# Technology direction

Accepted direction: our own JJ Bot application infrastructure, CopilotKit OSS for the frontend/agent boundary, and the official Google GenAI SDK for model calls.

## Accepted choice

Build the application ourselves. CopilotKit OSS supplies chat/state/tool UI integration and a TypeScript runtime boundary speaking AG-UI; Google ADK is deferred, and LangGraph and Mastra are not selected. We do not fork OpenBot: we borrow its structured handoffs, leased work queues, tool boundaries and attributed events, together with OpenMausBot's assignment hierarchy and Rakazo's identity/execution separation. Preserve upstream attribution and license obligations if implementation code is reused.

JJ Bot owns bot identities and memory, tasks and participation, execution sessions, group messages, selective activation, durable scheduling, tool execution, verification, steering, cancellation, and event persistence and replay. CopilotKit does not own the product model or the scheduler.

## Layer constraints

| Layer                   | Direction                                                                                    | Constraint                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Models                  | Direct official Google GenAI SDK behind a provider adapter                                   | Server-side only; no browser-owned loops                      |
| Agent/frontend boundary | AG-UI carrying JJ task/session attribution                                                   | Provider thread/run ids never replace JJ task identity        |
| Frontend                | React + TypeScript + Vite with CopilotKit components/hooks                                   | Renders product state; must not fabricate execution           |
| API                     | Hono on a long-running TypeScript service                                                    | Validates commands; owns records and message routing          |
| Storage                 | Application-owned PostgreSQL, embedded PGlite as a single-process option                     | Transactional writes; durable events persisted before publish |
| Execution               | Backend-owned Google SDK session/tool loop with persistent jobs and configurable concurrency | Independent of browser and HTTP request lifetime              |
| Live updates            | Durable task events, HTTP commands, event streaming and replay                               | Reconnect replays; it never re-runs work                      |
| Visualization           | Session activity projected from the event log                                                | Never present private model reasoning as evidence             |

CopilotKit Intelligence is not a required dependency. Application-owned persistence and memory come first; adding an optional service later requires a concrete need and an explicit decision.

## Integration requirements

These are the checks that define a working integration, in order:

1. A real backend tool cycle completes with no browser attached.
2. Two bots execute in separate sessions under one task.
3. Selective activation keeps a notification from waking every bot.
4. A failed check is revised and re-verified before the session reports success.
5. Steering changes subsequent execution and invalidates stale evidence.
6. Stop prevents new launches and records what actually stopped.
7. Event replay reconstructs activity without repeating work.
8. A third bot routes through the same paths with no special-casing.

Sources: [Google SDK](https://ai.google.dev/gemini-api/docs/libraries), [CopilotKit OSS versus Intelligence](https://docs.copilotkit.ai/concepts/oss-vs-enterprise), [AG-UI](https://docs.ag-ui.com/introduction), [reference implementations](references.md).
