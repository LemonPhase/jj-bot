# Technology direction

Status: documentation only; no dependencies installed or integration tested. Updated 31 October 2026.

**Selected:** direct use of the official Google GenAI SDK (`@google/genai`) for the hackathon. Google ADK is deferred. Exact Gemini model IDs and event-account capabilities still require validation.

**Recommended, pending team selection and an integration check:** extend CopilotKit OpenBot with a JJ execution backend, task/session records, verification loops and collaboration visualization. This supersedes the previous recommendation to build a new application with LangGraph.js. LangGraph and Mastra are not selected or required.

Read the [implementation approach comparison](approach-comparison.md) for source-level findings, alternatives, dependencies and the proposed validation gate.

| Layer | Proposed starting point | Status |
| --- | --- | --- |
| Application base | CopilotKit OpenBot, pinned revision | Recommendation |
| Frontend | Reuse its React/Vite app; add task/session visualization | Depends on base selection |
| API/storage | Reuse Hono, PostgreSQL/Drizzle and durable queue foundations | Depends on base selection |
| Model calls | Official Google GenAI SDK behind a provider adapter | Selected; untested |
| Execution | JJ backend-owned session/tool loop with explicit verification | Required behavior; implementation open |
| Agent/frontend boundary | Custom AG-UI endpoint and attributed task events | Proposed |
| Service topology | Local/server execution backend; managed or self-hosted Intelligence if using OpenBot | Open; setup must be validated |
| Visualization | Actual session activity projected into a task view; React Flow only if a graph is chosen | UI open |

Fallback: CopilotKit OSS TypeScript runtime and React tooling with our own storage/task backend; Intelligence is optional on that route. A completely custom UI/backend is the third choice if integration evidence supports it.

Keep bot, task, execution-session and run identities application-owned. An AG-UI thread or provider session must not replace the shared JJ task. Keep model/provider integration separate from scheduling so a later runtime migration does not require redefining the product model.

Next implementation check: pinned OpenBot startup, direct Gemini backend tool execution with the browser closed, separate multi-bot sessions, selective activation, steering, verification failure/retry, task-wide stop and attributed event replay. The research did not run this check.

Sources: [Google SDK](https://ai.google.dev/gemini-api/docs/libraries), [OpenBot](https://github.com/CopilotKit/OpenBot), [CopilotKit OSS versus Intelligence](https://docs.copilotkit.ai/concepts/oss-vs-enterprise), [AG-UI](https://docs.ag-ui.com/introduction).
