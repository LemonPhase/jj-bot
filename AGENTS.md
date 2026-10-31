# Project context and collaboration

## Context strategy: local-first, Notion on demand

Most product, architecture, contract, and setup context is already in this repository. **Do not fetch Notion pages at the start of every session by default.** Use local repository files first for coding, debugging, and codebase questions:

- `docs/development.md` — commands, workspace layout, environment variables, endpoint boundaries
- `docs/product-spec.md` & `docs/milestone-1.md` — bot/task/session model, steering, cancellation, and milestone acceptance criteria
- `docs/architecture.md` & `docs/tech-stack.md` — Option B stack (CopilotKit OSS/AG-UI + Hono + direct `@google/genai` SDK + PostgreSQL/Drizzle)
- `docs/verification.md` & `CONTRIBUTING.md` — task and session verification loop requirements
- `packages/contracts` — canonical Zod schemas and types shared across `apps/*` and `packages/*`

## Notion context map (fetch only when needed)

Consult or update Notion via the connected Notion MCP only when **claiming/updating a team task, checking live teammate status/handoffs, resolving cross-team scope decisions, or when explicitly asked by the user**. When you do need Notion, fetch only the specific page(s) relevant to your task rather than crawling every page:

| Page / Tracker                 | URL                                                       | When to fetch                                                                                                   |
| ------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Project HQ**                 | https://app.notion.com/p/44ef1321420182e4acb781ba075ad9b0 | Team roles, ownership, high-level tracker links                                                                 |
| **01 · Project Brief**         | https://app.notion.com/p/40af1321420181d29d55cfb6d70b6eea | Resolving product scope or milestone acceptance ambiguity                                                       |
| **02 · Build Runbook**         | https://app.notion.com/p/40af132142018125ac46e0b80cda7ea9 | Frontend/backend ownership split, tested model notes, integration status                                        |
| **03 · Agent Start & Handoff** | https://app.notion.com/p/40af13214201812d9cfae40de515812d | Handoff format and multi-agent coordination workflow                                                            |
| **00 · Idea Brainstorm**       | https://app.notion.com/p/40af13214201814abd85c00a6b20dd31 | Only when brainstorming or reviewing earlier candidate ideas                                                    |
| **Tasks database**             | https://app.notion.com/p/e341e5f714d14879b9f13779676f66c6 | Querying task status/ownership across lanes (`collection://37dfd29f-7b68-4307-8d83-9a4db1fbaa38`)               |
| **Decisions database**         | https://app.notion.com/p/25525cff2ddd410ba60b243570f5487b | Checking or recording team architecture/product decisions (`collection://9db4d62f-67e0-49ee-a1c4-7b6c28472803`) |
| **Handoffs database**          | https://app.notion.com/p/e861a4eec20440cab50b7e3346e2ea2e | Reading or leaving cross-session handoff checkpoints (`collection://9b1acbee-1972-4a36-a524-1f2335517044`)      |

### Direct task URLs

- **Task 01 (Shared — Contracts):** https://app.notion.com/p/40af13214201818c98dcdf487628d1e4
- **Task 02 (Backend — Persistence & jobs):** https://app.notion.com/p/40af132142018135916cc426891a0d27
- **Task 03 (Backend — Gemini session executor & tools):** https://app.notion.com/p/40af1321420181d18853fd36f26d4288
- **Task 04 (Backend — Coordinator, delegation, steering, stop):** https://app.notion.com/p/40af13214201810cb13bca1c99465373
- **Task 05 (Frontend — Bot & task chat with CopilotKit OSS):** https://app.notion.com/p/40af13214201815a9f0df4e740a094ec
- **Task 06 (Frontend — Task collaboration & verification UI):** https://app.notion.com/p/40af132142018111bdafcaeef61a3ac3
- **Task 07 (Backend — Task/session verification gates):** https://app.notion.com/p/40af1321420181a7a309f2354cdeafcf
- **Task 08 (Shared — Dependency advisories & bundle size):** https://app.notion.com/p/40af1321420181359ed1d3a491675ba3

Notion holds shared team coordination; repository code and tests establish implementation behavior. Keep proposals, source material, and accepted decisions distinct. The user's current instructions take precedence.

If a task requires reading or syncing Notion and the Notion MCP connection is unavailable or lacks access, inform the user what remains unsynced and ask them to enable access when needed. Never claim a Notion sync succeeded unless the write call succeeded.

## Keep context current

For implementation tasks, record ownership and acceptance checks before starting, and coordinate overlapping work. When stopping or handing off, update the relevant task and leave concise continuation notes with artifacts/commit links, verification results, blockers, and the exact next action. Keep updates within the user's authorized scope and never store credentials in shared context.

## Curate Notion; do not dump conversations

Notion is consolidated context for teammates and future agents, not a transcript or activity feed. A conversation alone is not a reason to write an update. It is fine to finish a session without changing Notion when nothing durable has changed.

- Save information only when explicitly requested or when it materially helps future work: agreed decisions and rationale, meaningful scope changes, actionable tasks/blockers, verified findings with sources, reusable setup lessons, or essential handoff state.
- Keep casual discussion, speculative tangents, routine progress reports, raw tool output, repeated explanations, and chat transcripts in the conversation. Do not automatically save every suggestion or question.
- Before writing, read the relevant destination and check whether the information already exists. Update and consolidate the existing entry or section rather than appending another recap or creating a new page for each chat.
- Write the smallest useful synthesis: the outcome, why it matters, and evidence or next action where relevant. Link artifacts and sources instead of copying their contents. Clearly label proposals, uncertainty, and superseded decisions.
- For brainstorming, record an idea when the user asks to capture it or clearly offers it for the shared list. Use one concise entry per distinct idea; refine that entry as discussion develops rather than logging every variation. Preserve teammates' contributions and do not mark proposals accepted without a team decision.
- Do not rewrite or delete unrelated team material as part of consolidation. Keep essential decision history, and avoid empty or duplicate handoffs when there is nothing useful to transfer.

## Repository development

- Option B is selected: our own application infrastructure, CopilotKit OSS/AG-UI integration, and direct Google GenAI SDK execution. No ADK or OpenBot fork.
- Read `docs/development.md` for commands, configuration and endpoint boundaries. Start with `npm ci`, then `docker compose up -d postgres` and `npm run dev`; use `npm run lint` and `npm test` as the baseline, and the `smoke:*` scripts for live model and end-to-end behavior.
- Shared schemas live in `packages/contracts`; coordinate changes there before implementing dependent API/UI/runtime work.
- Keep model keys and tool execution server-side. Do not use browser-owned loops for autonomous work.
- Keep tasks, bot personas, execution sessions and runs distinct. Visibility never implies activation. Require verification plans and evidence; a finished model turn is not a passed task.
- Report capability honestly: the API exposes `scaffold` versus `backend` mode and real capabilities. Never fake running agents, passing checks or successful persistence in the product UI.

## Documentation policy

Docs hold the invariants a future agent needs: contracts, boundaries, semantics and constraints. They are not progress logs.

- Do not record status, completion dates or "what I did" narratives in `docs/`. Status, ownership and handoffs belong in Notion and PR descriptions.
- Behavior is established by code and tests. Change a doc when the design contract changes, not when work advances.
- `docs/contract-changelog.md` is the deliberate exception: pinned schema changes require an entry there.
- Delete stale claims rather than layering corrections on top; history lives in git.

## Required verification loop for agent development

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for every substantive task and delegated execution session: define acceptance checks and expected evidence first; implement → verify → inspect failures → revise → reverify. Bound retries/budget and escalate unresolved failures. Verify the integrated result separately from local session outputs. Record passed, failed and inconclusive/not-run outcomes accurately in the task/handoff. Changed acceptance criteria require refreshed verification; never count stale evidence as completion. Scaffold validation may be limited to setup/contracts/build/smoke checks; it does not waive this standard for future feature work.
