# Architecture

The design contract for JJ Bot: components, boundaries, records and invariants. Product semantics are in [Product specification](product-spec.md). Code and tests establish implementation behavior.

## Components

| Component | Responsibility                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app   | Bot chat, task group chat, execution graph, steering and stop, settings. Renders server state and never runs agent loops.                      |
| API       | Validates commands, owns product records and message routing, persists events, streams task events.                                            |
| Worker    | Claims durable jobs, runs execution sessions on the pi agent runtime, maps runtime activity to task events, enforces budgets and cancellation. |
| Database  | PostgreSQL, or embedded PGlite for single-process development: domain records, the job queue and the append-only task event log.               |
| Sandbox   | Where agent tools execute. Provided by a pluggable driver selected per runtime profile.                                                        |

A self-hosted install embeds the worker in the API process. A server deployment can separate them without changing any identity. Execution is never owned by an HTTP request or an open stream: closing the browser does not stop a task.

## Execution model

Each execution session runs one pi agent (`@earendil-works/pi-coding-agent`) inside the worker. Its tools — bash, read, edit, write and search — are bound to a sandbox through pi's pluggable tool operations, so the loop stays in the worker while every command and file access happens in the sandbox. Model credentials and provider calls therefore never enter agent-run code.

pi supplies the agent loop, the coding tools, context compaction, mid-run steering and the multi-provider model registry. JJ Bot supplies identity, durability, scheduling, collaboration and the event log. pi is reached only through the `SessionExecutor` interface, so the runtime can be upgraded or replaced without touching orchestration.

The loop stays in the worker for every driver, remote ones included. Each command to a remote sandbox costs a network round trip; that latency is accepted in exchange for keeping keys, budgets, steering and cancellation in the worker.

Each bot chooses its own model as a `provider/model` reference resolved through pi's registry. Provider keys come from server environment variables and are resolved per call; they never appear in a transcript. Settings show which providers are configured and which models they offer, but keys are never entered or stored through the product.

## Sandbox boundary

A `SandboxDriver` turns a sandbox spec into a running `Sandbox` that exposes command execution, a workspace filesystem and optional ports, snapshots and metrics. The in-tree drivers are `local`, `docker` and `daytona`; other providers implement the same contract out of tree. The contract lives in `packages/sandbox`.

- **Capabilities are declared, not assumed.** Each driver states what it can enforce (network policy, resource limits, filesystem isolation). A spec that asks for more is refused. A driver never silently weakens isolation.
- **The environment is built from scratch.** A sandbox never inherits the host or worker environment. Declared variables and secrets injected by name are the only additions.
- **Paths are contained.** Filesystem access outside the workspace is rejected.
- **Interruption is reported honestly.** A command reports whether it was interrupted as `no`, `yes` or `unknown`; `unknown` means its effect may already have happened.
- **Workspaces have explicit lifetimes:** `ephemeral` (discarded on release), `task` (shared by a task's sessions, the default) or `bot` (persists for one bot across tasks).
- **Conformance is the contract.** A driver is valid when it passes the shared conformance suite.

The `local` driver isolates the environment only. Agent-run code shares the host kernel, filesystem and network, so it can read any file the server's user can, including a key file. It exists for development on a trusted machine, and the product labels profiles that use it as unisolated. Key isolation from agent-run code holds only for drivers that declare filesystem isolation.

A task's sessions share **one sandbox and one workspace**, acquired with the coordinator's runtime profile. Bots therefore see each other's files immediately, and one runaway process affects the whole task within the profile's resource limits. Bots can also overwrite each other's edits, so the coordinator partitions work to avoid touching the same files concurrently.

The `docker` driver starts sandboxes as sibling containers through the host's Docker API. When JJ Bot itself runs in a container, that API arrives as the mounted host socket, which is root-equivalent on the host. The driver therefore never passes the socket into a sandbox, never creates privileged containers and never bind-mounts host paths: workspaces are named volumes, and file access goes through the Docker API. A filtering proxy can sit in front of the socket through `DOCKER_HOST` without code changes.

## Runtime profiles

A runtime profile is the user-facing record that decides how a bot executes: the sandbox driver and spec (image, resources, network policy, workspace lifetime), tool allow and deny lists, and budgets. Users create and edit profiles in settings; bots reference one. The profile is the single place where isolation and spending are configured. Within a task, the shared sandbox uses the coordinator's profile, while each bot's own tool policy and budgets still apply to its sessions.

## Domain records

| Record            | Responsibility                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Bot               | Identity, instructions, model choice, runtime profile, memory reference.                       |
| RuntimeProfile    | Sandbox driver and spec, tool policy, budgets.                                                 |
| BotConversation   | Direct user-to-bot chat outside task execution.                                                |
| Task              | Goal and goal version, coordinator, optional verification plan, state, final result.           |
| TaskParticipation | Bot membership and role in a task.                                                             |
| ExecutionSession  | Task, responsible bot, brief, goal version, sandbox and workspace reference.                   |
| Assignment        | Requester session, assignee bot, parent assignment, brief, status and result.                  |
| SessionEntry      | One entry of a session's pi transcript, appended after each completed turn.                    |
| Run               | One execution or resumption of a session. Separates context lifetime from execution attempts.  |
| Message           | Attributed author, task or conversation, intent, activation list, causal reference.            |
| TaskEvent         | Ordered durable activity. The single source for chat, the execution graph and the audit trail. |
| VerificationCheck | Criterion, method, evidence, outcome and goal version, for tasks that carry a plan.            |
| Artifact          | A file or output produced by a session, with its producing run.                                |
| Usage             | Tokens and cost per model call, attributed to session and run.                                 |

Records are relational tables with indexed foreign keys. Every record carries an owner so multi-user support is additive. Runtime identifiers (pi sessions, sandbox ids) map to application records; they never replace a JJ Bot identity.

## Direct bot chat

A direct message to a bot runs a lightweight pi session with the bot's persona and model, no sandbox, and two tools: create a task, or send a message to one of the bot's active tasks. The bot can answer directly, ask a clarifying question, or shape a task's goal and roster before creating it. Task creation from chat is rate-limited.

## Visibility is separate from activation

Each task message is persisted once, with attribution and intent. Every participating bot can read the task history. Separately, a message names the bots it activates. A notification or informational message never launches work by itself. This prevents acknowledgement loops and unbounded reply chains.

Message intents: discussion, assignment, result, steering and notification.

## Coordination

Every task has one coordinator, initially its creator, which delegates bounded work and delivers the consolidated task result.

Delegation creates a durable **assignment**: requester session, assignee bot, parent assignment, brief, status and result. Each assignment runs as its own execution session. Assignments nest, and the assignment tree is the task's execution graph.

When an assignment finishes, its result is posted as a result message that activates the requesting session. The requester resumes from its persisted transcript with the result in context, so it can react to each result as it arrives — re-delegate, correct, or follow up — rather than only after all work ends. A requester waiting on assignments holds no lease and no concurrency slot, so waiting parents cannot starve their children.

Configurable limits cap sessions per task, delegation depth and concurrent execution; excess work queues rather than failing. Cancelling a task cancels its open assignments.

## Steering and cancellation

Steering is posted to the task chat and reaches the coordinator. Where the runtime allows, steering is injected into a running session at its next turn boundary rather than discarding its work. A change to the goal or its criteria increments the goal version, and work at an older version cannot complete the task.

Stop marks cancellation durably, prevents new launches, propagates to active sessions and their sandboxes, and records what actually stopped. Cancellation does not undo completed external effects, and a command that could not be interrupted is reported as such.

## Events and streaming

Persist before publishing. Each task event carries an event id, a per-task sequence allocated in the same transaction as the change it records, task id, optional bot, session and run ids, type, timestamp, causal reference and payload.

Clients receive events through one streaming contract: server-sent events over the task event log, resumed from `Last-Event-ID`. Reconnecting replays from the cursor and never re-runs work.

Messages arrive whole; text is not streamed token by token. While a bot works, clients show a per-bot activity line derived from durable events — the command it is running, the file it is editing, a delegation, or that it is writing a reply — so activity survives reload and reconnect. Token streaming, if ever added, travels as ephemeral events outside the durable log. Persisted tool output is capped (64 KiB by default); larger output is stored in full as an artifact and the event keeps a truncated preview with a reference to it. Secret values are redacted before an event is written.

## Context and memory

Each session gets a bounded objective, the current goal version, selected task messages, required artifacts and any verification criteria. Long sessions are compacted rather than truncated. Durable facts are promoted into a bot's memory deliberately, keeping source and scope. Shared task membership is never authority to read a bot's private conversations.

## Concurrency and recovery

A job lease gives each active run a single owner, and every write-back re-checks ownership. Event and conversation sequences are serialized per task and per bot rather than globally, so independent tasks never contend. Commands are idempotent.

A session's pi transcript is persisted after every completed turn. After a crash or restart, the session resumes from its last completed turn in a new run. A command that was running at the crash is reported to the agent as interrupted with an unknown outcome; it is never silently re-run. A session whose workspace did not survive, such as an ephemeral one, is not resumed: it fails visibly. A pi upgrade that changes the transcript format must migrate stored transcripts or refuse to resume them.

## Security invariants

- Model keys, provider calls and the worker's environment never enter a sandbox.
- Secrets reach a sandbox only by name at acquisition, and are redacted from events and logs.
- A driver refuses any spec it cannot enforce.
- Sandboxes never receive the Docker socket, privileged mode or host bind mounts.
- Every command and file change is attributed to a task, session and run.
- The API listens on loopback unless an access token is configured.
