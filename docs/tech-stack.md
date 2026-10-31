# Technology direction

Status: option B selected by the user on 31 October 2026. Documentation only; no application code, dependencies or integration tests yet.

## Accepted direction

Build our own JJ Bot application infrastructure using CopilotKit OSS for frontend/agent integration and the official Google GenAI SDK (`@google/genai`) directly for model calls. Google ADK is deferred. LangGraph and Mastra are not selected.

JJ Bot owns bot identities/memory, tasks and participation, execution sessions, group messages, selective activation, durable scheduling, tool execution, verification, steering, cancellation, and event persistence/replay. CopilotKit handles chat/state/tool UI integration through AG-UI; it does not own our product model or scheduler.

We are not forking OpenBot. Borrow and adapt its structured handoffs, leased work queues, tool boundaries and attributed events, together with OpenMausBot's assignment hierarchy and Rakazo's identity/execution separation. Preserve upstream attribution and license obligations if implementation code is reused.

## Implementation baseline

| Layer | Direction | Status |
| --- | --- | --- |
| Application | Custom JJ Bot infrastructure + CopilotKit OSS | Selected |
| Models | Direct official Google GenAI SDK behind a provider adapter | Selected; exact model/API access untested |
| Agent/frontend boundary | AG-UI with JJ task/session attribution | Selected direction; exact event/version mapping to validate |
| Frontend | React + TypeScript + Vite and CopilotKit components/hooks | Proposed baseline |
| API | Hono on a long-running TypeScript service | Proposed baseline |
| Storage | Application-owned PostgreSQL + Drizzle | Proposed baseline |
| Execution | Backend-owned Google SDK session/tool loop, persistent jobs and configurable concurrency | Required behavior; exact implementation open |
| Live updates | Durable task events, HTTP commands and event streaming/replay | Required behavior; transport details open |
| Visualization | Actual session activity projected into task views | Required; graph/timeline layout open |
| Deployment | Backend runs locally or on a server, independent of browser lifecycle | Accepted product requirement; demo topology open |

CopilotKit Intelligence is not a required dependency for this architecture. Initially plan application-owned persistence and memory. Adding an optional service later requires a concrete need and an explicit decision.

Keep bot, task, execution-session and run identities application-owned. An AG-UI thread or provider session must not replace a JJ task. Separate provider calls, session execution and task orchestration so later framework changes have bounded scope.

## First integration check

Connect CopilotKit OSS to our direct-Gemini execution endpoint. Complete a real backend tool cycle with the browser closed. Then run two bots in separate sessions under one task; verify selective activation, user steering, a failed check followed by revision, task-wide stop, and attributed event replay. Add a third bot without special-case routing. No part of this check has been executed yet.

Next design work: agree the task/session/event contract and ownership boundaries, choose the demo task/tools, then implement the multi-bot vertical slice in [Milestone 1](milestone-1.md).

See the [approach comparison](approach-comparison.md) for the earlier research and alternatives. Its original OpenBot recommendation is superseded by this accepted choice.

Sources: [Google SDK](https://ai.google.dev/gemini-api/docs/libraries), [CopilotKit OSS versus Intelligence](https://docs.copilotkit.ai/concepts/oss-vs-enterprise), [AG-UI](https://docs.ag-ui.com/introduction), [reference implementations](references.md).
