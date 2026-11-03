# Architecture

The design contract for JJ Bot: components, boundaries, records and invariants. Terms are defined in the [glossary](glossary.md). Product semantics are in [Product specification](product-spec.md), and package-level contracts in the READMEs of [the engine](../packages/backend/README.md), [the runtime](../packages/runtime/README.md), [the sandbox drivers](../packages/sandbox/README.md) and [storage](../packages/db/README.md). Code and tests establish implementation behavior.

## Components

| Component | Responsibility                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app   | Bot chat, task group chat, execution graph, steering and stop, settings. Renders server state and never runs agent loops.                                       |
| API       | Validates commands, owns product records and message routing, persists events, streams task events.                                                             |
| Worker    | Claims durable jobs, runs execution sessions and chat replies on the pi agent runtime, maps runtime activity to task events, enforces budgets and cancellation. |
| Database  | PostgreSQL, or embedded PGlite for a single process: domain records, the job queue and the append-only task event log.                                          |
| Sandbox   | Where agent tools execute. Provided by a pluggable driver selected by a runtime profile.                                                                        |

The API embeds the worker by default. On PostgreSQL the worker can run as its own process (`apps/worker`) without changing any identity. Execution is never owned by an HTTP request or an open stream: closing the browser does not stop a task.

## Execution model

Each execution session runs pi's agent loop (`@earendil-works/pi-agent-core`) inside the worker, over a transcript the engine owns. Its coding tools — bash, read, edit, write, grep, find and ls — act on the task's sandbox, so the loop and the provider calls stay in the worker while every command and file access happens in the sandbox. ls is pi's tool on sandbox-backed operations; the other six are JJ tools over the sandbox's filesystem API and command execution, because pi's versions resolve paths on the host filesystem, pass the host environment, write host temp files or spawn host binaries. Model credentials are therefore never handed to agent-run code; whether that code can still read them from the host depends on the driver (see [Sandbox boundary](#sandbox-boundary)). The runtime README has the tool and run semantics.

pi supplies the agent loop, steering at turn boundaries and the multi-provider model registry. JJ Bot supplies identity, durability, scheduling, collaboration, the sandbox-bound tools and the event log. The engine reaches pi only through its ports (`SessionExecutor`, `ChatResponder` and `ModelCatalog` in `packages/backend/src/ports.ts`), so the runtime can be upgraded or replaced without touching orchestration.

The loop stays in the worker for every driver, remote ones included. Each command to a remote sandbox costs a network round trip; that latency is accepted in exchange for keeping keys, budgets, steering and cancellation in the worker.

Each bot chooses its own model as a `provider/model` reference resolved through pi's registry. Provider keys come from server environment variables and are resolved per call; they never appear in a transcript. Settings show which providers are configured and which models they offer, but keys are never entered or stored through the product.

## Sandbox boundary

A `SandboxDriver` turns a sandbox spec into a running `Sandbox` that exposes command execution, a workspace filesystem and optional ports, snapshots and metrics. The in-tree drivers are `local` and `docker`; a remote driver, such as one for Daytona, would implement the same contract. The contract lives in `packages/sandbox`.

- **Capabilities are declared, not assumed.** Each driver states what it can enforce: the network modes, resource limits and filesystem isolation. A spec that asks for more, or that is addressed to another driver, is refused. A driver never silently weakens isolation.
- **The environment is built from scratch.** No driver passes the host or worker environment into a command; declared variables and secrets injected by name are the only additions. Not passing is not hiding: only a driver that declares filesystem isolation keeps the host environment and files out of reach.
- **Paths are contained.** The sandbox filesystem API rejects any path outside the workspace, checked after following symlinks. This constrains the API, not commands: what a command can reach depends on the driver's isolation.
- **Interruption is reported honestly.** A command reports `no`, `yes` or `unknown`. `yes` means the driver verified that none of the command's processes survive; `unknown` means it could not, so the command's effect may already have happened or may still be happening.
- **Release ends everything the sandbox started,** background processes included, and discards an ephemeral workspace.
- **Conformance is the contract.** A driver is valid when it passes the shared conformance suite.

A task acquires **one sandbox for all its sessions**. The worker's task sandbox manager acquires it once per task, with the coordinator's runtime profile and `workspaceKey` set to the task id, and releases it when the task ends, after it sits idle (`sandboxIdleMs`, ten minutes by default, for a `task` workspace), or when the worker holds more than `JJ_MAX_HELD_SANDBOXES`; sessions never acquire their own. Bots therefore see each other's files immediately, and one runaway process affects the whole task within the profile's resource limits. Bots can also overwrite each other's edits, so the coordinator partitions files: each brief names the files its worker owns, workers edit only those (they may read any), and files several pieces need are edited by the coordinator after the results arrive.

A workspace is identified by its mode and its key. Task execution uses two modes:

- `task` (the default): files persist across releases and restarts, and every sandbox acquired for the task sees them. No API deletes a task workspace, so deleting a task leaves its files; the operator clears the driver's storage (for `local`, its root directory).
- `ephemeral`: the workspace is discarded when the task's sandbox is released: when the task finishes or stops, when the worker stops, after it sits idle much longer than a `task` workspace (`JJ_EPHEMERAL_IDLE_MINUTES`, default 6 hours), or when the worker holds more sandboxes than `JJ_MAX_HELD_SANDBOXES` and it is the least recently used idle one (idle `task` workspaces go first). A session that needs a discarded workspace, or would resume one after a restart, fails visibly.

The contract also defines `bot`, a workspace that persists for one bot across tasks. Task execution never uses it, because it would expose the coordinator's files from earlier tasks to every participant.

The `local` driver runs commands directly on the host, as the server's user. It does not pass the server's environment into commands, but it hides nothing from them: they can read every file that user can, including `.env` and key files, and the server's own environment through `/proc`. Its process cleanup is best effort without cgroups, so a `yes` from `local` is not a guarantee. `local` exists for development on a trusted machine, and the product labels profiles that use it as unisolated.

The `docker` driver starts sandboxes as sibling containers through the host's Docker API. When JJ Bot itself runs in a container, that API arrives as the mounted host socket, which is root-equivalent on the host. The driver therefore never passes the socket into a sandbox, never creates privileged containers and never bind-mounts host paths: workspaces are named volumes, and file access goes through the Docker API. A filtering proxy can sit in front of the socket through `DOCKER_HOST` without code changes; plain-HTTP `tcp://` is refused for a host that is not loopback unless the operator opts in. A starting worker removes the containers and networks of its docker namespace that other processes started (`reapOrphans`), keeping workspace volumes, so only one live worker may use a namespace on a daemon (see [Constraints](development.md#constraints)).

The docker driver enforces three network modes. `none` leaves a sandbox only loopback. `open` puts it on Docker's default bridge, which reaches the internet and whatever else the bridge reaches, host services on its gateway included. `allowlist` gives each sandbox its own internal network, on a small subnet of the driver's own pool, with no route out, no external DNS and no address on the host. Its only other member is an egress proxy the driver starts beside it. The driver checks the network and the sandbox (no host address, no IPv6) instead of trusting the engine version, and refuses the sandbox when a check fails. The sandbox reaches the outside only through that proxy, as an HTTP(S) proxy (`HTTPS_PROXY`), and the proxy forwards only to listed hosts and ports. It resolves names itself and refuses any target that resolves to a non-public address, so the app, PostgreSQL, the Docker host and cloud metadata stay unreachable even when listed. Proxy-unaware clients, raw TCP (ssh, `git://`) and private destinations do not work in `allowlist`. The proxy holds no secrets and is hardened like a sandbox; it is removed with the sandbox. The [driver README](../packages/sandbox/README.md#network-mode-allowlist) has the details and limits.

## Runtime profiles

A runtime profile is the user-facing record that decides how a bot executes: the sandbox driver and spec (image, resources, network policy, workspace lifetime), the coding tools it grants, and budgets (model calls per run and minutes per run). Collaboration tools come with a session's place in the task, not with a profile: `delegate` and `message` when the task has teammates (`delegate` only while the session's depth is below the delegation limit), `complete_task` for the coordinator alone, and the read-only lookup tools (`task_state`, `task_log`, `read_entry`, `read_report`; see [Context and memory](#context-and-memory)) for every session. Users create and edit profiles in settings; a bot references one, or uses the default profile. The profile is the single place where isolation and spending are configured. The API reports each profile's status from its driver: whether the driver is available, and whether it isolates the filesystem. A profile without filesystem isolation is labelled unisolated. Within a task, the shared sandbox uses the coordinator's profile, while each bot's own tools and budgets still apply to its sessions.

On first boot, with no profiles stored, the server seeds one profile per registered driver, each with every coding tool and the default budgets (60 model calls and 30 minutes per run): **Docker sandbox** (`jj-sandbox:base-1`, network `open`, `task` workspace, 2 CPUs, 2048 MB, 512 processes) and **Local (unisolated)** (network `open`, `task` workspace). Docker is the default when its daemon answers at that boot; otherwise local is, when registered.

## Domain records

| Record            | Responsibility                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Bot               | Identity, role, instructions, model choice, runtime profile, appearance, memory.                                   |
| RuntimeProfile    | Sandbox driver and spec, coding tools, budgets; reports driver availability and isolation.                         |
| BotConversation   | Direct user-to-bot chat outside task execution.                                                                    |
| ChatTaskUpdate    | A task event its coordinator's chat is told (completed, failed, waiting for the user) until a reply answers it.    |
| Task              | Title, goal and goal version, coordinator, state, final result, stop request.                                      |
| TaskParticipation | Bot membership in a task.                                                                                          |
| ExecutionSession  | Task, bot, parent session, role, brief, depth, goal version, status, what it waits for, result.                    |
| SessionEntry      | One entry of a session's pi transcript: a pi message or a compaction checkpoint.                                   |
| InboxItem         | Input waiting for a session: a brief, a result, steering or a message, delivered at its next turn boundary or run. |
| Run               | One execution or resumption of a session. Separates context lifetime from execution attempts.                      |
| Message           | Attributed author, task or conversation, sequence, intent and recipients.                                          |
| TaskEvent         | Ordered durable activity. The single source for chat, the execution graph and the audit trail.                     |
| Artifact          | A workspace file or spilled tool output, credited to the run that wrote it, or task-level when no run can be.      |
| Usage             | Tokens and cost per model call, compaction summaries included, attributed to session and run.                      |

There is no separate assignment record: a delegated assignment is an execution session (see [Coordination](#coordination)). A bot's appearance is cosmetic and never affects execution. How artifact snapshots credit files is in the engine README.

Records are relational tables with indexed foreign keys. Every record carries an owner so multi-user support is additive. Runtime identifiers (pi sessions, sandbox ids) map to application records; they never replace a JJ Bot identity.

## Direct bot chat

A direct message to a bot runs a lightweight pi session with the bot's persona and model, no sandbox, a bounded history and the chat's task tools. The bot can answer directly, ask a clarifying question, or shape a task's goal and roster before creating it. A bot coordinates the tasks it creates from chat. Task creation from chat is rate-limited. The chat prompt gives the count of the bot's unfinished tasks and points to `list_tasks`; it does not list them.

The task tools cover only the tasks the bot takes part in (its participations); any other task id, known or not, is refused with a tool error:

- `list_tasks(status?, limit?)`: the bot's tasks, newest first, each with its id, title, status, the bot's role, when it last changed and its result or error on one line.
- `get_task(id)`: the task state as a session's `task_state` gives it (goal and goal version, status, result or error, each session's bot, role, status and the first line of its brief), the bot's role, and the latest task log entries as an index.
- `read_task_log(id, …)`: the task log as `task_log` pages it (newest entries by default), or one entry in full. Session transcripts are never read.
- `create_task`: as above.
- `send_to_task(id, text)`: passes the message on to the task's coordinator, continuing a waiting, completed or failed task as a user message does: same task, workspace and coordinator transcript. A cancelled or stopping task refuses it.
- `stop_task(id, reason?)`: stops the task as the user's stop does. Only the task's coordinator can.

The read tools change nothing, and their output is never a reply's text when its budget cuts it short. Tool definitions are the same whatever tasks exist: task ids are plain string parameters checked inside each tool. A reply takes at most six model calls: the deepest planned reply, a question about a task, takes four (`list_tasks`, `get_task`, `read_task_log` for an entry in full, then the answer), and the other two absorb a refused call and its retry.

**Task updates.** When a task completes, fails or waits for the user, its coordinator tells the user in its direct chat, in its own words:

- The transaction that changes the task records the update (the task, what happened, and its result, error or the coordinator's question, as stored then and clipped) and enqueues a chat reply for the coordinator. Each event has one update, keyed by the task and its event sequence; a task that continues and then waits again is a new event.
- The update is the input of one chat reply and is never stored as a chat message. That reply gets the read tools only; it may suggest an action, and the user decides. Its message carries the task's id, so the chat shows the task's card under it.
- A bot's chat replies run one at a time, each answering one input: the user's unanswered messages first, then the oldest update. An update, or a user message, that arrives during a reply is answered after it, by a reply that sees both.
- The reply that answers an update marks it answered in the transaction that stores its message, so a crash or hand-off tells it once. If the reply fails (a model error or the budget), or its job keeps dying, the engine posts the update as a plain message with the task's card instead, so it is never lost. A user message whose reply failed is not answered again until the user writes more.

The task card reads the live task summary: it shows the task's current status, not its status when the message was written, and a completed or failed task's result or error.

## Visibility is separate from activation

Each task message is persisted once, with attribution and intent, in the task log. The user sees the whole task log. A session is pushed only what reaches its inbox: its brief, results, steering, and messages addressed to it or to everyone (a message with no recipient goes to every other active session of the task). A session keeps at most its 20 newest undelivered messages; older ones reach it as one `[N earlier messages omitted]` line, and stay in the task log. Beyond its inbox, every session can pull its own task's shared record with read-only lookup tools: the whole task log, including messages not addressed to it, and any session's brief and report (see [Context and memory](#context-and-memory)). Other sessions' transcripts stay private. Pulling delivers nothing and wakes no one.

Delivery is separate from activation: only briefs, results and steering start or continue a run, while other messages ride along with the recipient's next turn and never launch work by themselves. This prevents acknowledgement loops and unbounded reply chains.

A message to a teammate with no active session in the task, because its sessions have finished or it never had one, is refused: no bot would read it, so it is not posted, and the sender gets a tool error that says so and suggests `delegate` (or its report, when it cannot delegate). A broadcast is never refused: it reaches every other active session, and is posted even when there is none. Bots are told not to leave anything important only in a message: what a teammate or the coordinator must know goes in a brief, a report or a workspace file.

Message intents: discussion, assignment, result, steering and notification. A bot's message with no recipient (a broadcast) is a notification; a coordinator's reply to the user is a discussion message with no recipient.

## Coordination

Every task has one coordinator, which delegates bounded work and delivers the consolidated task result: the bot the user names when creating the task, or the bot that created it from direct chat.

Delegation creates a child **execution session** for the assignee bot. Its parent is the requesting session, its brief is the assignment, and its result is the assignment's result; there is no separate assignment record. Delegated sessions can delegate in turn, and the session tree is the task's execution graph.

Shared decisions are settled in briefs. Before delegating pieces that share something (an interface, a naming or style convention, a data format), the coordinator decides it and states it in every affected brief, alongside the files each worker owns, rather than leaving workers to agree it between themselves. Inside its own piece, a worker decides. A worker that needs a shared decision changed says so in its report, or messages its requester.

When a child session finishes, its result is posted as a result message that activates the parent session. The parent resumes from its persisted transcript with the result in context, so it can react to each result as it arrives — re-delegate, correct, or follow up — rather than only after all work ends. A session that ends its turn is `waiting` until input arrives, and records what it waits for: the results of its open delegations, or the user. A waiting session holds no lease and no concurrency slot, so waiting parents cannot starve their children.

The coordinator completes the task by calling `complete_task` with the consolidated result; ending a model turn is not completion. Input that reaches the coordinator after it called `complete_task` but before its run ended sets that completion aside, and the coordinator is told so with the input, so it calls `complete_task` again once it has dealt with it. A coordinator that ends its turn without calling it, usually to ask the user something, is waiting for the user, and once no work is active the task is `waiting`; the user's next message continues it. A completed or failed task continues the same way. Only a cancelled task, or one being stopped, is terminal. See [task continuation](task-continuation.md).

Configurable limits cap sessions per task, delegation depth and concurrent execution. Excess concurrent runs queue. A delegation that would exceed the session or depth limit, that repeats one of the caller's open delegations exactly (same assignee and brief), or that follows `complete_task` in the same run, is refused, and the refusal returns to the model as the tool's error so it can adapt. The caller's open delegations are listed in each `delegate` result and in each result delivered to it, never in a tool description: tool definitions stay identical across a session's runs, since they lead the model's prompt cache. Cancelling a task cancels its open sessions.

## Steering and cancellation

Steering is posted to the task chat and reaches the coordinator. Steering is injected into a running session at its next turn boundary rather than discarding its work. A change to the goal or its criteria increments the goal version, and work at an older version cannot complete the task.

Stop marks cancellation durably (`cancelRequestedAt`), prevents new launches and new messages, propagates to active sessions and their sandboxes, and records what actually stopped. Cancellation does not undo completed external effects, and a command that could not be interrupted is reported as such.

## Events and streaming

Persist before publishing. Each task event carries an event id, a per-task sequence allocated in the same transaction as the change it records, task id, optional bot, session and run ids, type, timestamp, causal reference and payload.

An event that changes a task, session, message or artifact record carries the whole record after the change. A client therefore keeps a task view current by folding events onto it with the contract's pure `applyTaskEvent`, without refetching: a view at sequence n plus events n+1 to m equals the view at m. Other events are markers (goal changed, reopened, finished) and activity. Clients ignore event types they do not know.

Clients receive two streams:

- **Task stream** (`GET /api/tasks/:taskId/stream`): server-sent events over the task event log, one frame per event with the sequence as its `id`, the event type as its `event` and the event as its `data`. It resumes after `Last-Event-ID` or `?after=`. A task view carries the cursor of the last event it reflects, so a client loads the view and streams from that cursor without gaps. Reconnecting replays from the cursor and never re-runs work. A view holds at most the latest 500 events and drops their output previews; earlier events and full previews come from `GET /api/tasks/:taskId/events?after=`.
- **Workspace stream** (`GET /api/stream`): hints naming what changed — bots, a task, a bot conversation, profiles. Hints carry no state and are not resumable; clients refetch what they show on every hint and on every (re)connect.

Messages arrive whole; text is not streamed token by token. While a bot works, clients show a per-bot activity line derived from durable events — the command it is running, the file it is editing, a delegation, or that it is writing a reply — so activity survives reload and reconnect. The derivation is a pure contract function, so clients and the server show the same line. Token streaming, if ever added, travels as ephemeral events outside the durable log. Persisted tool output is capped at 64 KiB (`JJ_OUTPUT_CAP_BYTES` can lower it, never raise it); larger output is stored in full as an artifact and the event keeps a truncated preview with a reference to it. The server's secret values are replaced with `[redacted]` in everything a run persists: events, transcript entries, messages, results, the texts collaboration tools store, errors and spilled output. The runtime applies the replacement before it caps, clips or spills any text, so a cut never leaves part of a secret, and the engine applies it again when it writes. The secrets are the configured provider keys and the API token, replaced wherever they appear when at least 16 characters long (a shorter one is named in a warning at boot and left alone, since it is too likely to be an ordinary word), and the database password, replaced only as the password of a URL (`:<password>@`). Tools receive what the model wrote; only the stored copies are redacted. Files in the workspace are the user's and are stored unredacted, as are their artifacts: on `local`, `env > out.txt` keeps the keys in `out.txt`.

## Context and memory

A session's prompt carries the bot's persona and memory, the goal at the session's goal version, the roster, the shared workspace and, for a delegated session, its brief as the requester wrote it. Its inputs are what its inbox delivers; a delegated session starts on an item that points at the brief in its prompt, so the brief is not sent twice.

Every task session, coordinator and workers alike, can also look up its task's shared record with four read-only tools, and its prompt says when to use them:

- `task_state`: the goal and goal version, the task's status (with its result or error once it has one), and each session's id, bot, role, status and the first line of its brief.
- `task_log`: the task log, shown oldest first, filtered by kind and by text (ignoring case), from the oldest or the newest entry and paged with `after`, `before` and `limit`; a page says how many matching entries lie before and after it. Each entry is one index line: its id, its kind, its author (→ recipients, or → everyone for a broadcast) and a clipped preview. An entry's id is the stored task message's id, so it never changes. Its kind is `user` (steering, or a message a bot relayed from the user's direct chat), `brief` (an assignment), `report` (a worker's report or failure, or the coordinator's result) or `message` (any other message, the coordinator's replies to the user included).
- `read_entry`: one entry in full, by id.
- `read_report`: a session's brief and its report (or result, or failure) in full, by session id, or by bot name for each of that bot's sessions on the task.

The invariants:

- **Own task only.** The tools read only the caller's task. An id from another task is refused like an unknown one, and a search never matches another task's entries. Listing or searching other tasks is not offered.
- **Never a transcript.** A session's transcript (its reasoning, tool calls and tool output) is private to it: no tool reads another session's transcript, and no model call receives one.
- **Read-only.** The tools change no record and wake no one; like every tool call, each call is recorded as events.
- **Cache-stable.** Their definitions are the same for every session and run; ids and names are checked inside a tool, never listed in its schema.
- **Redacted and capped.** What they read is redacted before any preview clips it, so a cut never leaves part of a secret; the result is capped at `JJ_OUTPUT_CAP_BYTES` and spilled to an artifact like any other tool output.
- **Clean refusals.** An unknown id, another task's id, a NUL character in an argument or a failed read is a tool error the model can act on, never a database message.

An execution session's context is compacted with pi's compaction when it nears its model's context window; direct chat sends a bounded history instead. The [runtime README](../packages/runtime/README.md#context-compaction) has the details; the invariants are:

- **When.** Before a model call whose context passes the window less a reserve (which always leaves the provider room to answer), and once after a provider `context_overflow` or a response the provider cut short for lack of room (its output reached the cap the context left, or it filled the window), which then retries the call. If the context still overflows, the run fails with `context_overflow`. Models with a window under 16384 tokens, or no known window, do not compact, and their overflow errors say so.
- **What.** The bot's own model summarises the older part, keeping decisions, files changed, open delegations, results received and pending work, and folding in any earlier summary. The recent part is kept from a cut point that never separates a tool call from its results. The system prompt is rebuilt every run and is not summarised, so the goal and a delegated session's brief always reach the model as written.
- **Persisted.** The compaction is one transcript entry (the summary, how many stored entries before it are kept, the tokens before), written in one transaction after everything it covers. The full transcript stays stored and append-only; a run builds its context as [latest summary] + the kept entries + every entry after it, then repairs crashed tool calls on that view. A crash before the entry is written loses only the summary, and the next run compacts again.
- **Never dropped.** A tool call is summarised or kept together with its results, and one a crash left unanswered is still answered as interrupted, never re-run or lost. Undelivered inbox items stay undelivered (compaction never touches the inbox). The most recent messages up to the cut are kept as they are; when the cut falls inside a turn, the turn's start is summarised with pi's turn-prefix prompt.
- **Accounted.** Each summary call is reported as `model.started` and `model.finished` with its usage, so it has a usage row attributed to its task, session, run and bot.

A bot's memory is one text that the user edits (`PUT /api/bots/:id/memory`). It is added to that bot's own prompts, in task sessions and direct chat, never to a teammate's, and no agent tool writes it. Shared task membership is never authority to read a bot's private conversations.

## Concurrency and recovery

A job lease gives each active run a single owner, and every write-back re-checks ownership. Event and conversation sequences are serialized per task and per bot rather than globally, so independent tasks never contend. Side effects of a job that can run again are keyed by its input: a chat reply that runs again after a hand-off or crash creates no second task, relays no message twice and tells a task update once.

A session's pi transcript is persisted as the run proceeds: its inputs before the model call that sees them, an assistant message before its tools run, each tool result as soon as that tool finishes, and a compaction entry once everything it covers is stored. After a crash or restart, the session resumes from what was persisted, in a new run. A command that was running at the crash is reported to the agent as interrupted with an unknown outcome; it is never silently re-run. A session whose workspace did not survive, such as an ephemeral one, is not resumed: it fails visibly. A pi upgrade that changes the transcript format must migrate stored transcripts or refuse to resume them.

## Security invariants

- Model keys, provider calls and the worker's environment are never passed into a sandbox. They are out of agent-run code's reach only on drivers that declare filesystem isolation; `local` hides neither the server user's files nor its environment.
- The engine passes no secrets into sandboxes; the driver contract accepts them only by name at acquisition. Model error text is stored with the provider key and key-shaped strings redacted, and the server's secrets are redacted from everything a run persists (see [Events and streaming](#events-and-streaming)); workspace files, which a command on `local` can fill with them, are stored as written.
- A driver refuses any spec it cannot enforce.
- Sandboxes never receive the Docker socket, privileged mode or host bind mounts.
- Every tool call is recorded as an event attributed to its task, session and run.
- The API answers without a token only on loopback. Listening anywhere else it requires a bearer token: the configured one, or one it generates on first boot, keeps in the database and prints only in the line that opens the app. It refuses cross-site requests and non-JSON writes, and without a token it answers only loopback `Host` values and an explicit allowlist, so a web page cannot drive it through the user's browser.
