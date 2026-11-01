# Project context and collaboration

## Context strategy: repository first

Product, architecture, contract and setup context lives in this repository. Read the local files first for coding, debugging and codebase questions:

- `docs/development.md` — commands, workspace layout, environment variables, endpoints, checks and constraints
- `docs/product-spec.md`, `docs/task-continuation.md` & `docs/milestone-1.md` — bot/task/session model, steering, continuation, cancellation, and milestone acceptance criteria
- `docs/architecture.md` & `docs/tech-stack.md` — pi agent runtime, pluggable sandbox drivers, Hono, PostgreSQL/Drizzle and the native task event stream
- `docs/verification.md` — opt-in task verification in the product; `CONTRIBUTING.md` — branches, PRs, review and the verification loop for development work
- `packages/contracts` — canonical Zod schemas and types shared across `apps/*` and `packages/*`
- `packages/*/README.md` — package contracts: the engine (`backend`), the pi runtime, storage (`db`), and the sandbox driver contract with the conformance suite every driver must pass (`sandbox`)

## Work tracking: GitHub Issues

Work is tracked in [GitHub Issues](https://github.com/LemonPhase/jj-bot/issues), grouped into milestones by phase; [docs/workstreams.md](docs/workstreams.md) explains the milestones, labels and how to pick up an issue. Repository code and tests establish implementation behavior; issues hold status, ownership, dependencies and handoffs. The user's current instructions take precedence.

- **Claim before starting.** Pick an issue with no open blockers — its native "blocked by" links are the source of truth — then assign yourself or comment to claim it. Record the accountable human owner and any agent or session.
- **Define acceptance first.** If an issue lacks acceptance criteria and expected evidence, add them before implementing.
- **One PR per issue.** Branch from the latest `main` per issue and open a PR against `main` that closes it (`Closes #N`); [CONTRIBUTING.md](CONTRIBUTING.md) has the PR description and the independent review. Coordinate before touching shared files: `packages/contracts`, root dependencies, and shared web layout and styles.
- **Hand off on the issue.** When stopping before an issue is done, comment with links to commits or the PR, verification results (passed, failed, not run), blockers and the exact next action.
- **New work gets a new issue,** with goal, scope, acceptance criteria and dependencies, rather than growing the current one.
- **Decisions are `decision` issues.** Once settled, write the resulting contract into the docs and close the issue.

## Keep issues curated

Issues and their comments are consolidated context for teammates and future agents, not a transcript or activity feed. The repository is public: never put credentials, private data or local machine details in an issue.

- Write only what materially helps future work: decisions and rationale, scope changes, blockers, verified findings with sources, reusable setup lessons, or essential handoff state.
- Keep casual discussion, routine progress reports, raw tool output and chat transcripts out of issues.
- Before writing, check whether the information already exists, and update the existing issue or comment rather than duplicating it.
- Write the smallest useful synthesis: the outcome, why it matters, and evidence or next action. Link artifacts instead of pasting them. Label proposals and uncertainty clearly, and never mark a proposal accepted without a decision.
- Do not rewrite or close teammates' issues while tidying; keep decision history.
- Never claim an issue or PR update succeeded unless the write succeeded.

## Repository development

- Execution sessions run on the pi agent runtime (`@earendil-works/pi-agent-core`, `pi-coding-agent`, `pi-ai`) with tools inside a pluggable sandbox. Providers are reached only through pi-ai, and clients only through the native task event stream. No other agent framework (Google ADK, LangGraph, Mastra) and no OpenBot fork.
- Read `docs/development.md` for commands, configuration and endpoint boundaries. Start with `npm ci` and `JJ_ENABLE_SCRIPTED_MODEL=true npm run dev` (embedded PGlite; set `DATABASE_URL` for PostgreSQL). `npm run lint` and `npm test` are the quick baseline and `npm run verify` (alias `check`) is the gate CI runs; `npm run smoke:e2e` exercises the whole server end to end and `npm run smoke:runtime` a live model.
- Shared schemas live in `packages/contracts`; coordinate changes there before implementing dependent API/UI/runtime work.
- Keep model keys and tool execution server-side. Do not use browser-owned loops for autonomous work.
- Agent-run code executes only through a sandbox driver, and a driver must refuse isolation it cannot enforce. No driver passes model keys or the host environment into a sandbox, but only drivers that declare `filesystemIsolation` (such as `docker`) keep them out of reach: on `local`, commands can read the server user's files and environment. New drivers must pass `describeSandboxConformance`.
- Keep tasks, bot personas, execution sessions and runs distinct. Visibility never implies activation. Verification is opt-in per task: when a task has a plan, a finished model turn is not a passed check, and an unverified result is never shown as verified.
- Report capability honestly: bootstrap reports `mode` and the real `capabilities`, and the web app labels its built-in demo data (`scaffold`) as such. Never fake running agents, passing checks or successful persistence in the product UI.

## Documentation policy

Docs hold the invariants a future agent needs: contracts, boundaries, semantics and constraints. They are not progress logs.

- Do not record status, completion dates or "what I did" narratives in `docs/`. Status, ownership and handoffs belong in GitHub issues and PR descriptions.
- Behavior is established by code and tests. Change a doc when the design contract changes, not when work advances.
- `docs/contract-changelog.md` is the deliberate exception: pinned schema changes require an entry there.
- Delete stale claims rather than layering corrections on top; history lives in git.

## Required verification loop for agent development

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for every substantive task and delegated execution session: define acceptance checks and expected evidence first; implement → verify → inspect failures → revise → reverify. Bound retries/budget and escalate unresolved failures. Verify the integrated result separately from local session outputs. Record passed, failed and inconclusive/not-run outcomes accurately in the issue or PR. Changed acceptance criteria require refreshed verification; never count stale evidence as completion. Scaffold validation may be limited to setup/contracts/build/smoke checks; it does not waive this standard for future feature work.
