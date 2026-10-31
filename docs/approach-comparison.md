# JJ Bot implementation approaches

Researched 31 October 2026. **Current accepted choice: B — CopilotKit OSS with our own application infrastructure and agent execution backend, using the Google GenAI SDK directly; ADK deferred.** The user selected B to control the application model while borrowing suitable ideas from existing systems. The original OpenBot-first recommendation below is retained as research history and is superseded. See [current technology direction](tech-stack.md).

Method: documentation and selected source inspection, not installation, live model testing or benchmarking. Relative effort and risk are engineering judgments. No approach has passed JJ Bot's acceptance checks yet.

## Original recommendation — superseded by option B selection

Start by evaluating **OpenBot as the application base, with a JJ execution backend using `@google/genai` directly**. Reuse bot profiles, conversations, groups, the tool gateway, durable work queue and audit infrastructure. Add our task/session/verification model and collaboration visualization. Google ADK, LangGraph and Mastra are not prerequisites.

The fallback is **CopilotKit's open-source TypeScript runtime and React tooling with our own task backend and storage**. This retains UI/protocol infrastructure without adopting OpenBot's whole application or Intelligence dependency. A completely custom UI is the third choice, justified if CopilotKit integration costs more than it saves for the selected demo.

## Separate the layers

| Layer | Responsibility | JJ Bot direction |
| --- | --- | --- |
| Google GenAI SDK | Gemini API access, streaming and model/tool interaction | Selected; exact model/API access still needs testing. |
| JJ execution runtime | Scheduling, contexts, tools, verification, steering and cancellation | Implement/adapt our semantics regardless of UI choice. |
| AG-UI | Agent/frontend event protocol | Suitable boundary; does not schedule agents. |
| CopilotKit OSS SDK/runtime | Chat/state/tool UI integration and runtime handling | Supports a custom AG-UI backend without ADK. |
| CopilotKit Intelligence | Saved streams, realtime continuity and other services | Required by stock OpenBot's documented setup; optional for a new app using the OSS TypeScript runtime. |
| OpenBot | Application template combining profiles, channels, groups, tools and infrastructure | Design reference; not selected as our application base. |

Google recommends [`@google/genai`](https://ai.google.dev/gemini-api/docs/libraries). Its [function-calling guide](https://ai.google.dev/gemini-api/docs/function-calling) documents model/tool interaction. The SDK does not itself supply our application-owned task lifecycle or verification policy.

CopilotKit supports [custom AG-UI backends](https://docs.copilotkit.ai/concepts/architecture). Its [OSS comparison](https://docs.copilotkit.ai/concepts/oss-vs-enterprise) explicitly permits the TypeScript runtime without Intelligence and with application-owned persistence. OpenBot's service dependencies do not apply to every CopilotKit application.

## Overall comparison

| Approach | Reuse | Remaining work | Main tradeoff | Hackathon assessment |
| --- | --- | --- | --- | --- |
| A. Extend OpenBot + direct Google SDK backend | Bot management, chat/groups, tool gateway, queue, audit, deployment | Gemini endpoint; task/session records; routing; verification; task controls; visualization | Substantial application to learn; Intelligence setup and existing thread assumptions | Best first candidate if infrastructure starts cleanly and agent tools matter to the demo. |
| B. CopilotKit OSS + custom JJ backend | Chat components/hooks, protocol plumbing, state/tool rendering | Bot/task UI and records; storage; durable scheduling; memory; verification; controls; visualization | More backend/application work than A, but no required Intelligence service | Best fallback if OpenBot's setup or mappings become a blocker. |
| C. Custom React/Hono + direct Google SDK | General-purpose libraries | Essentially all product and execution infrastructure | Maximum control, maximum implementation responsibility | Third choice while a suitable template exists. |
| D. Fork OpenMausBot | Messaging app, bots/groups, durable hierarchical assignments | Direct Gemini engine; JJ task model; verification/visualization mapping | Existing CLI/provider execution assumptions differ from our SDK choice | Strong assignment-design reference; less attractive base for this integration. |
| E. Fork Rakazo | Persistent-bot app, tools, workers, deployment | Direct SDK runtime integration; shared task layer; verification/visualization | Broad product and Pi runtime abstractions to adapt | Complete product reference, not the simplest route to our milestone. |

None eliminates the verification and task-control work. Multi-bot chat, handoffs or audit records alone do not satisfy our contract.

## A. OpenBot: source-level fit

Inspected revision: [`743649efc3f21d7bf0badbe6af2bcd5daedd97ce`](https://github.com/CopilotKit/OpenBot/tree/743649efc3f21d7bf0badbe6af2bcd5daedd97ce). Pin a tested source/image revision when implementing.

### What already fits

- Persistent bot profiles separate from runtime registrations; standing roles, channel conversations and external AG-UI endpoint registration. [Coworker documentation](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/docs/coworkers.md).
- Groups with one runtime thread per bot and an attributed shared transcript. This already separates shared conversation from execution context. [Group schema](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/db/schema/group.ts).
- Typed peer handoffs carrying a task, constraints and expected output. Delegated work uses scratch threads and relays results back to the requester. [Handoff tool](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/agents/handoff-tool.ts), [delivery](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/agents/handoff-delivery.ts).
- PostgreSQL work claims, leases, attempts and completion records, with a durable handoff runner. These are useful foundations, not an exactly-once guarantee for external actions. [Work schema](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/db/schema/work.ts), [runner](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/agents/handoff-runner.ts).
- React/Vite, Hono, PostgreSQL/Drizzle, computer/tool access and audit infrastructure. Much of the previously proposed custom foundation exists here. [Architecture](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/docs/architecture.md).

### Concrete differences to address

| Our requirement | Inspected behavior | Adaptation |
| --- | --- | --- |
| Task owns goal, coordinator, many bots and multiple sessions | Groups own conversations; responsibilities include success criteria but link one agent/channel/thread | Add a JJ Task linked to the group, with participation and execution-session records. |
| Visibility separate from activation | Recipient/mentions select bots; absent either, every group bot answers | Coordinator-directed steering and informational messages that do not automatically launch replies. |
| Multiple sessions per bot/task | Group thread is per bot/channel; delegated work can mint scratch threads | Register every session under the task with an independent context, including multiple sessions for the same bot. |
| Configurable execution concurrency | Group sweep runs selected bot replies sequentially | Preserve chat ordering; schedule independent sessions through a bounded worker path. Sequential group chat alone is not parallel execution. |
| Mandatory verification loops | Success-criteria/expected-output fields exist | Add check plans, evidence, attempts and pass/fail/inconclusive records; gate completion. Criteria text is not proof. |
| Task-wide steering and stop | Runtime abort/stop primitives exist | Persist cancellation, prevent queued launches, propagate to descendants, acknowledge outcomes and version changed goals. |
| Task collaboration visualization | Group attribution and audit events provide inputs | Add task/bot/session/run and causal IDs, then project actual durable events. |

Sources: [group routing/sweep, lines 1187–1261](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/channels/group.ts#L1187), [responsibility schema](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/db/schema/responsibilities.ts), [runtime cancellation](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/toolkit/src/copilotkit/agents.ts).

### Direct Google SDK integration

Proposed flow: OpenBot UI/API → JJ task scheduler → execution sessions → custom AG-UI endpoint using `@google/genai` → OpenBot's governed tool gateway. Task/session/check events feed chat and visualization.

This requires neither ADK nor LangGraph, but it is integration work, not a tested configuration switch. The proof-of-concept agent imports OpenAI and translates its messages/tools/events manually. Changing its model name/key does not make it a direct Google SDK implementation. [Proof-of-concept source](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/agent-bot/src/index.ts).

Our endpoint must translate Gemini messages, streaming and function results; preserve continuation state required by the chosen API; carry server-issued identity; and propagate cancellation. Reuse the governed tool callback rather than bypassing it.

Unattended work requires a backend-owned tool loop. The proof-of-concept delegates the loop to the surface. The inspected LangGraph agent now executes deployment tools server-side using signed callbacks, although introductory comments still describe its older surface loop. Borrow the callback boundary without requiring LangGraph. UI components and human questions may still suspend for input. [Executable tool loop, lines 229–389](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/agent-langgraph/src/index.ts#L229).

### Infrastructure and ownership

OpenBot describes itself as a beta template; workspaces are private packages. Extending it means maintaining application source rather than consuming a stable published framework. Its repository is MIT; preserve upstream notices. Intelligence has separate terms. [README](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/README.md), [license](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/LICENSE).

The documented setup requires Bun 1.4+, Docker, a model key and an Intelligence project. Managed Intelligence avoids operating that service. Local Intelligence evaluation is a macOS/Docker Desktop preview with a renewable 30-day license, not a production deployment; production self-hosting is a separate path. Published local prerequisites include 4 CPUs, 12 GiB RAM and 40 GiB free storage per Intelligence stack. Local evaluation does not include User Memory; OpenBot documents a local memory fallback that would need testing. [Local requirements](https://docs.copilotkit.ai/intelligence/self-hosting-local), [OpenBot memory behavior](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/docs/architecture.md).

A local execution backend using managed Intelligence is not a fully self-contained local stack. Our current scope allows local/server execution and has not required offline operation. Choose the demo topology explicitly.

## B. CopilotKit OSS with our own backend

Use React/Vite, the CopilotKit TypeScript runtime, a direct-Google-SDK AG-UI endpoint, PostgreSQL and our worker. Intelligence can be omitted. [Official capability comparison](https://docs.copilotkit.ai/concepts/oss-vs-enterprise).

This avoids modifying OpenBot's group/channel implementation or adopting its service topology. We give up its ready-made bot management, tool gateway, queue wiring and admin surfaces. Persistent history, replay/reconnect, scoped memory and background scheduling become our work.

AG-UI documents lifecycle, tool, state, custom and subagent events. Subagent attribution describes invocations; it does not schedule them or replace durable JJ task/session identities. Confirm event support across the exact producer/runtime/frontend versions; newer protocol docs do not establish installed-library compatibility. Use a typed custom event where necessary. [Events](https://docs.ag-ui.com/sdk/js/core/events), [subagent semantics](https://docs.ag-ui.com/concepts/subagents).

## C. Fully custom application

Use React/Vite, Hono, PostgreSQL/Drizzle, HTTP commands/SSE and a long-running Google SDK worker. React Flow is optional if the selected visualization needs a graph; a session list/timeline may be enough initially.

This provides complete control and no CopilotKit dependency, but all chat streaming, storage, tool rendering, error/reconnect behavior, bot management and task runtime become our responsibility. Fewer dependencies do not imply less implementation risk. Choose this only for a demonstrated integration obstacle or a demo UI narrow enough that CopilotKit adds little value.

## Other applications and frameworks

**OpenMausBot:** assignments have root/parent IDs, requester/assignee, completion criteria, results and evidence. Its product currently describes local Claude/Codex/Grok CLI engines. A direct Google SDK backend needs a new/adapted engine and validation of tool/permission/context contracts. Borrow its assignment model even if we do not fork the app. [README](https://github.com/milind-soni/OpenMausBot/blob/main/README.md), [types](https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/runtime/types.ts), [store](https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/runtime/store.ts).

**Rakazo:** a full persistent-bot product with tools, worker infrastructure and deployment. Its Task belongs to one bot/thread; our shared task container needs an added mapping. The inspected helper code uses Pi, permits four parallel helpers and rejects deeper helper nesting. A concurrency cap is compatible with an arbitrary bot roster. Direct Google SDK execution requires adapting that runtime path. [README](https://github.com/elie222/rakazo/blob/main/README.md), [schema](https://github.com/elie222/rakazo/blob/26f284c8dbea1a272b70c4fb99ada4634034ba53/packages/db/prisma/schema.prisma), [helper implementation](https://github.com/elie222/rakazo/blob/26f284c8dbea1a272b70c4fb99ada4634034ba53/packages/adapters/src/pi-runtime-subagent.ts).

**LangGraph/Mastra/ADK:** these are execution-layer choices, not application shells. LangGraph checkpoints help recovery/human pauses but do not supply JJ membership, routing or task-wide cancellation automatically. Direct SDK calls could run within a framework, but adding one is optional. ADK is deferred; LangGraph and Mastra are not selected. Separate the provider adapter, session driver and task store so later migration is bounded; it will not necessarily be drop-in. [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence).

## Original OpenBot evaluation gate — historical

The following spike is proposed, not executed:

1. Start pinned OpenBot with the selected Intelligence topology and record setup/service requirements.
2. Register a direct-Google-SDK endpoint; complete a real model → governed backend tool → model cycle with the browser closed.
3. Run one task with two bot identities and separate sessions; add another session for the same bot to test context isolation.
4. Store a shared message without waking everyone. Steer through the coordinator and show affected work adopting the new goal version.
5. Fail a check deliberately, revise/recheck, collect session evidence and verify the integrated result.
6. Stop active work, block queued launches and acknowledge descendant outcomes. Reconnect/restart without blindly repeating completed effects.
7. Render attributed session events and replay after reload. Add a third bot through the same registration/scheduling path.

Choose A if contained extensions preserve our semantics and tool boundaries. Choose B if Intelligence setup or invasive changes dominate. Choose C only if protocol/UI integration is itself the demonstrated obstacle. No precise delivery estimate is justified before this check.

The repository remains documentation-only. Option B and the direct Google SDK are now selected; the OpenBot gate above is historical. The next integration check targets CopilotKit OSS and our own backend, as described in [technology direction](tech-stack.md). Implementation should follow the agreed [product specification](product-spec.md), [verification contract](verification.md) and [milestone](milestone-1.md).
