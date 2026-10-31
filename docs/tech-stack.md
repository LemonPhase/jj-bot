# Technology stack proposal

Status: recommendation for team review, researched 31 October 2026. No stack has been adopted, no dependencies installed, and no runtime integration tested.

## Recommended starting point

Use a TypeScript stack: React/Vite frontend, Hono API on Node.js, LangGraph.js execution worker, the official Google GenAI SDK behind a model adapter, and PostgreSQL. Keep JJ Bot's product model independent of framework thread/session names.

| Layer | Proposed choice | Reason for JJ Bot |
| --- | --- | --- |
| Frontend | React + TypeScript + Vite | Interactive bot chat, task chat, and visualization can share typed domain events; a separate backend fits local/server operation. |
| UI components | Tailwind CSS + shadcn/ui | Composable UI primitives for chat, sidebars, panels, forms, and status displays. |
| Server-state UI | TanStack Query | Fetch task snapshots, send commands, and update cached server state from events. |
| Visualization | React Flow, if the team chooses a graph | Custom bot/session nodes and attributed edges; a timeline can use the same event record. A graph layout is still a proposal. |
| API | Hono on a long-running Node.js service | Typed HTTP endpoints and SSE support with a small service boundary. |
| Execution | LangGraph.js | Explicit routing and verification cycles, dynamic fan-out, checkpoint persistence, subgraphs, and human-input pauses. |
| Models | Official Google GenAI SDK behind an adapter | Direct Gemini integration without assuming a framework wrapper already supports the exact event model/API. |
| Storage | PostgreSQL + Drizzle for product records | Bot/task participation and ordered events are relational; one database can also host a supported durable runtime checkpointer. Validate adapter compatibility. |
| Realtime | HTTP commands + server-sent task events | Clients send messages/steering/stop through commands and subscribe to updates. Add WebSockets only if a concrete requirement needs them. |
| Deployment | Long-running API/worker services; local PostgreSQL via Docker | Autonomous work continues without a browser connection; the same boundaries can run on one machine or a server. |

These are design recommendations, not benchmark results. Avoid an ephemeral request lifecycle for long-running autonomous execution.

## Agent framework comparison

### LangGraph.js — recommended for explicit execution control

LangGraph provides stateful orchestration, persistence, streaming, and human-in-the-loop primitives. Graph routing can express execute → verify → revise, and dynamic dispatch supports a variable participant set. Subgraph state mappings allow independently scoped contexts.

JJ Bot still owns bot identities/memory policy, task membership, selective activation, chat, goal versions, execution scheduling, event attribution, and cross-session cancellation. A LangGraph interrupt pauses at a programmed point; it is not automatically an immediate task-wide stop or arbitrary mid-tool steering. Resuming can rerun node code, so isolate/idempotently handle side effects.

The open-source library can run in our own worker; using its runtime does not require choosing a hosted LangSmith deployment. Confirm the chosen persistent checkpointer and model adapter in the first implementation spike.

Sources: [overview](https://docs.langchain.com/oss/javascript/langgraph/overview), [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts), [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api), [subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs).

### Google ADK — strongest Google-native alternative

ADK documents multi-agent/graph workflows, dynamic workflows, resumption, and cancellation. It is a natural candidate if the team prefers Google's agent abstractions and Gemini-first integration. Check language-specific support and current API versions; do not copy older workflow-class examples without checking current docs.

It still needs JJ Bot's persistent persona/task/session product layer, selective message routing, memory boundaries, verification criteria, and visualization projections. Prototype state isolation and steering/cancellation before adopting it.

Sources: [workflow overview](https://adk.dev/workflows/), [dynamic workflows](https://adk.dev/graphs/dynamic/), [resume](https://adk.dev/runtime/resume/), [cancel](https://adk.dev/runtime/cancel/).

### Mastra — strongest integrated TypeScript alternative

Mastra brings agent, memory, workflow, and server abstractions together. Its workflows support suspension, resumption, streaming, and structured steps. It may reduce integration work if the team likes its APIs. Evaluate dynamic delegation, runtime cancellation, and state isolation against our exact milestone instead of treating a successful chat demo as sufficient.

Sources: [overview](https://mastra.ai/docs), [workflows](https://mastra.ai/docs/workflows/overview).

### AG-UI / CopilotKit — frontend protocol/tooling, not the orchestrator

AG-UI standardizes events between an agent backend and frontend; it does not replace task scheduling or our bot/task relationships. Consider it as the streaming boundary if the selected runtime adapter fits. Otherwise start with a small typed domain event contract and retain an adapter boundary. Check SDK/integration support for the event subset used; documentation includes evolving features.

CopilotKit OpenBot is a useful reference/template, but adopting its entire product model would require mapping its channels and agent threads to our shared task semantics. Do not assume it already implements the agreed JJ Bot design.

Source: [AG-UI overview](https://docs.ag-ui.com/introduction); see [reference implementations](references.md).

## Framework mapping proposal

Bots are application identities, not fixed graph nodes. Instantiate execution agents from a bot profile. Keep each execution session's context/checkpoint identity distinct; carry taskId/botId/sessionId/runId through emitted events. Dynamically select workers from task participants. Keep shared task messages in application storage rather than one shared mutable message list injected into every worker.

Persist the work item and event before dispatch. A bounded worker scheduler handles concurrency, cancellation, and recovery. Framework checkpoints and application task state have different responsibilities. Do not put every durable action solely in the browser or an in-memory promise.

## Model choices to validate

Candidate: Gemini 4 Argon for coordination and complex work; a compatible Flash model for bounded worker tasks where justified. Model selection and actual event-account access are untested. Test the exact model ID, tool calling, cancellation behavior, streaming, and schema support before locking dependencies or prompts.

Use the [official Google GenAI libraries](https://ai.google.dev/gemini-api/docs/libraries) and [current model catalogue](https://ai.google.dev/gemini-api/docs/models). No API keys belong in this repository or client bundle.

## Frontend/backend references

- [Vite](https://vite.dev/guide/)
- [shadcn/ui](https://ui.shadcn.com/docs)
- [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)
- [React Flow custom nodes](https://reactflow.dev/learn/customization/custom-nodes)
- [Hono streaming/SSE](https://hono.dev/docs/helpers/streaming)
- [Drizzle ORM](https://orm.drizzle.team/docs/overview)

## Next decision

Team to select LangGraph.js, Google ADK, or Mastra after reviewing these tradeoffs. Then run the narrow multi-bot/model/verification/steering spike in [Milestone 1](milestone-1.md). Package versions and exact adapter APIs are intentionally unpinned until implementation validation.
