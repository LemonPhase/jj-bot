# Architecture proposal

Status: proposed implementation design. Product semantics in [Product specification](product-spec.md) are agreed; exact records, protocols, and runtime mappings below require team selection and implementation validation.

## Deployment boundaries

- Frontend: bot conversations, task group chats, steering/stop controls, and execution visualization.
- API service: validates commands, owns product records and message routing, persists events, and streams task updates.
- Execution worker: runs coordinator and worker sessions, model/tool calls, verification, and cancellation. Its lifecycle is independent of browser connections.
- Database: task membership, attributed messages, execution state, checkpoints, events, verification records, and bot memory metadata.
- Tool boundary: narrow tool adapters and, when needed, an isolated execution environment for shell/browser work.

For a single-machine demo the API and worker may share one long-running process, provided execution is not owned by an HTTP request or an open stream. A server deployment can separate those processes without changing task identities. A framework checkpoint is not by itself an external job scheduler or a safe exactly-once tool executor.

## Proposed domain records

| Record | Key responsibility |
| --- | --- |
| Bot | Persistent identity, instructions, memory references, runtime defaults. |
| BotConversation | Ordinary user-to-bot or bot-to-bot conversation outside task execution. |
| Task | Goal and goal version, coordinator, verification plan, state, final result. |
| TaskParticipation | Many-to-many bot/task membership and role. |
| ExecutionSession | Task ID, responsible bot, parent session if applicable, brief, context/checkpoint reference, verification contract. |
| Run / Attempt | A particular execution/resume/retry within a session. Distinguishes context lifetime from execution attempts. |
| Message | Attributed author, task or conversation, recipients, intent, causal reference. |
| TaskEvent | Ordered durable operational activity used by chat and visualization. |
| VerificationCheck | Criterion, method, evidence, result, attempt, and goal version checked. |
| Artifact | Output reference and producing session/run. |

These are conceptual entities, not a committed database schema. Every framework session/thread/run identifier maps to an application-owned record; it must not replace JJ Bot's task identity.

## Visibility is separate from activation

Persist each task-chat message once, with attribution and audience. All participating bots can read the task history. Separately record which bots/sessions should be activated by that message. Maintain a consumption cursor or selected-context view for each execution context.

Proposed message intents: discussion, assignment, question, result, steering, and notification. A notification or informational contribution should not automatically launch work. The coordinator routes assignments, reconciles results, and decides when another bot is needed. Avoid acknowledgement loops and unbounded reply chains.

## Steering and cancellation

The user posts steering to the task chat; the coordinator records any plan/goal change and informs affected sessions. Proposed implementation: increment the goal version when acceptance criteria change and reject stale completion claims against earlier criteria. Decide whether active operations finish at a safe boundary or are interrupted, and show the delivery/acknowledgement state.

Stop task marks cancellation durably, prevents new launches, propagates cancellation to active descendants, and records what actually stopped. Tool adapters must report when an action cannot be interrupted or may already have completed. Do not report success after a cancellation or retry without reconciling outcomes.

## Events and visualization

Persist before publishing. Proposed event envelope fields: event ID, per-task sequence, task ID, optional bot/session/run IDs, source/target, type, timestamp, causal reference, and payload. Use server-issued attribution and identifiers.

Proposed events include task creation, participation changes, messages, session start, delegation, tool start/result, verification start/pass/fail/inconclusive, steering delivery, cancellation request/acknowledgement, and task completion/failure.

Chat, graph, and timeline are projections of this same record. Reload/reconnect uses a snapshot plus cursor-based replay; it must not start work again. Persist low-volume semantic events and final outputs; streaming token deltas can be batched instead of becoming one durable row per token.

## Context and memory

Give each session a bounded objective, relevant goal version, selected task messages, required artifacts, and verification criteria. Return concise results plus evidence to the task/coordinator. Promote durable facts into a bot's persistent memory deliberately, preserving source and scope. Shared task membership is not authority to read unrelated private bot conversations.

## Concurrency and recovery

Store participants as data, not fixed bot slots. Dynamically schedule selected sessions with configurable concurrency and model budgets. Enforce single ownership of an active execution attempt, idempotent command delivery, and resource locks for shared files/browser/computers where needed. Restart recovery must reconcile uncertain tool effects before repeating them.

See [Technology stack](tech-stack.md) for the proposed implementation tools and [Milestone 1](milestone-1.md) for the required vertical slice.
