# JJ Bot

JJ Bot is an open, self-hostable multi-bot agent workspace — an open alternative to Grok's bot. You create persistent bots, give a task a goal and a roster, and watch them work: one bot coordinates and delegates bounded pieces to the others, and each runs real command and file work inside a sandbox. Everything they say and do lands in a shared, attributed task chat and a live execution graph. You can steer a running task or stop it.

## How it works

- **Bots** are persistent personas with their own instructions, model, runtime profile and memory.
- **Tasks** are the shared problem container: a goal, a coordinator, participating bots, a group chat, execution sessions and results. Messages are visible to every participant without waking every bot.
- **Execution sessions** run on the [pi](https://github.com/earendil-works/pi) agent runtime. Their tools execute inside the sandbox chosen by the bot's runtime profile: the in-tree `local` or `docker` driver, or a remote provider such as Daytona behind the same driver contract. Model keys are never passed into a sandbox, but only an isolating driver such as `docker` keeps them out of reach: `local` commands can read the server user's files and environment.
- **Every change is an event** in an append-only per-task log. Chat, the execution graph and the audit trail are projections of it, and reconnecting replays it without re-running work.
- **Verification is opt-in per task.** A task with a verification plan cannot complete until its checks pass. Tool calls, exit codes and artifacts are recorded either way.

## Run locally

Use Node.js 24 (minimum 22.12), npm, and Docker for the default PostgreSQL store:

```sh
npm ci
cp .env.example .env
docker compose up -d postgres
npm run dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:3001. Set `JJ_DATABASE_MODE=pglite` to run without Docker (single process only). Model execution currently uses Gemini: add `GEMINI_API_KEY` and `GEMINI_MODEL`. Without them the API still stores and serves bots and tasks, but execution cannot start.

Run `npm run check` for lint, tests, all-package typecheck and the web build. Never commit `.env`. See [development setup](docs/development.md) for the full command set, configuration and endpoint boundaries.

## Repository layout

| Directory            | Responsibility                                                                       |
| -------------------- | ------------------------------------------------------------------------------------ |
| `apps/web`           | React/Vite workspace: bot and task chat, execution graph, steering and stop controls |
| `apps/api`           | Hono service: bootstrap/health, bot and task routes, task event streaming            |
| `apps/worker`        | Standalone worker for deployments that do not embed the scheduler in the API         |
| `packages/contracts` | Canonical Zod schemas and types; the frontend/backend boundary                       |
| `packages/backend`   | Coordination, delegation, steering, cancellation and scheduling                      |
| `packages/runtime`   | Agent session execution behind the `SessionExecutor` interface                       |
| `packages/sandbox`   | Sandbox driver contract, drivers and the shared driver conformance suite             |
| `packages/db`        | Transactional PGlite/PostgreSQL store with an append-only task event log             |

## Documentation

Docs describe stable design, contracts and constraints — not progress. Implementation behavior is established by code and tests; status, ownership and handoffs live in GitHub Issues.

- [Product specification](docs/product-spec.md): bots, tasks, sessions, coordination and runtime profiles.
- [Architecture](docs/architecture.md): components, execution, the sandbox boundary, coordination, records and events.
- [Technology stack](docs/tech-stack.md): accepted stack, layer constraints and integration checks.
- [Verification](docs/verification.md): opt-in task verification, check kinds and evidence.
- [Milestone 1](docs/milestone-1.md): MVP acceptance criteria.
- [Task continuation](docs/task-continuation.md): goal versioning and extending a completed task.
- [Development setup](docs/development.md): commands, configuration and endpoint boundaries.
- [Contract changelog](docs/contract-changelog.md): schema changes and required coordination.
- [Reference implementations](docs/references.md): Rakazo, OpenMausBot and OpenBot.

## Work tracking

Work is tracked in [GitHub Issues](https://github.com/LemonPhase/jj-bot/issues), grouped into milestones by phase. Start at the [MVP epic](https://github.com/LemonPhase/jj-bot/issues/46), and see [docs/workstreams.md](docs/workstreams.md) for how to pick up an issue.

No license has been selected; source availability and distribution terms remain a team decision.
