# Development setup

## Prerequisites and start

Use Node.js 24 (minimum 22.12), npm, and Docker for the default PostgreSQL store. From the repository root:

```sh
npm ci
cp .env.example .env
docker compose up -d postgres
npm run dev
```

Open http://127.0.0.1:5173. API: http://127.0.0.1:3001. Stop everything with Ctrl+C. Never commit `.env`.

The API requires a reachable database at startup. Use `docker compose up -d postgres`, or set `JJ_DATABASE_MODE=pglite` to run a single-process embedded database without Docker. Model execution additionally requires `GEMINI_API_KEY` and `GEMINI_MODEL`; without them the API still stores and serves bots and tasks, but sessions cannot run.

`npm run dev -w @jj/web`, `npm run dev -w @jj/api` and `npm run dev -w @jj/worker` start individual processes. The web dev server proxies `/api` and `/health` to port 3001; update `apps/web/vite.config.ts` if you change API_PORT. API_HOST defaults to loopback. AGENT_URL is a server-side endpoint override, not a user-provided URL.

## Workspace ownership

| Directory            | Responsibility                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apps/web`           | React/Vite workspace: bot and task chat, execution graph, steering and stop controls                                |
| `apps/api`           | Hono service: bootstrap/health, bot and task routes, task event streaming (SSE), legacy AG-UI and CopilotKit routes |
| `apps/worker`        | Optional standalone PostgreSQL worker; the API embeds the scheduler by default                                      |
| `packages/contracts` | Canonical Zod schemas/types for bots, tasks, sessions, messages, checks and attributed events                       |
| `packages/backend`   | BackendService: coordinator, delegation, verification, steering, cancellation, leases and job scheduling            |
| `packages/runtime`   | Session execution behind `SessionExecutor`; the current `GeminiSessionExecutor` uses the Google GenAI SDK           |
| `packages/sandbox`   | Sandbox driver contract, the `local` driver and the shared driver conformance suite                                 |
| `packages/db`        | Drizzle schema and migrations, per-task sequences, job queue and LISTEN/NOTIFY bus on PostgreSQL or PGlite          |

Internal packages export TypeScript source. API/worker run with `tsx`; `build` typechecks all packages and produces the web bundle.

## Configuration

| Variable           | Purpose                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `API_HOST`         | API listener; loopback by default. `API_TOKEN` becomes mandatory beyond loopback.           |
| `API_PORT`         | API port, default `3001`.                                                                   |
| `AGENT_URL`        | Server-side execution endpoint override registered with CopilotKit.                         |
| `DATABASE_URL`     | PostgreSQL connection string; defaults to `postgresql://jj:jj_local@localhost:5433/jj_bot`. |
| `JJ_DATABASE_MODE` | `postgres` (default) or `pglite` for a single-process embedded store.                       |
| `JJ_DATABASE_PATH` | PGlite data directory, default `../../.jj-data`.                                            |
| `JJ_EMBED_WORKER`  | `true` (default) runs the scheduler inside the API; `false` requires the separate worker.   |
| `JJ_CONCURRENCY`   | Concurrent execution sessions and claimed jobs, default `3`.                                |
| `JJ_POSTGRES_PORT` | Host port for the compose PostgreSQL service, default `5433`.                               |
| `JJ_SANDBOX_ROOT`  | `local` sandbox workspace root, default `<os.tmpdir()>/jj-sandbox`; the operator clears it. |
| `API_TOKEN`        | Optional bearer token required on `/api/*` when set.                                        |
| `GEMINI_API_KEY`   | Server-only Google GenAI key. Never expose it to the browser.                               |
| `GEMINI_MODEL`     | Exact model id used for sessions; validate access before relying on it.                     |

Database: `docker compose up -d postgres` starts PostgreSQL 17 under the compose project `jj-bot` (container `jj-bot-postgres-1`, volume `jj-bot_jj_postgres`) on `127.0.0.1:5433`. `docker compose stop` halts it; `docker compose down` removes the container and keeps the named volume.

Schema: the store applies the SQL migrations in `packages/db/migrations` when it opens, so no separate migration step is required. Processes that open one PostgreSQL database at the same time serialize on an advisory lock. To change the schema, edit `packages/db/src/schema.ts`, run `npm run db:generate -w @jj/db` and commit the generated migration. Never edit a migration that has already been applied. The store's contract is in `packages/db/README.md`.

## Checks

```sh
npm run verify        # the CI gate: lint + all-package typecheck + tests + web build
npm run check         # alias for verify
npm run format        # format and safe lint/import fixes
npm run test
npm run typecheck
npm run smoke:model   # live Gemini round trip; needs .env
npm run smoke:tool    # live tool-call round trip; needs .env
npm run smoke:backend # live end-to-end task run; needs .env, running API and database
```

CI (`.github/workflows/ci.yml`) runs on every push and pull request, on the Node version in `.nvmrc`. After `npm ci` it runs lint, typecheck, tests and the web build, the same steps as `npm run verify`, and every step must pass. Each check runs even when an earlier one fails, so one run reports every failure. A newer run on the same ref cancels the superseded one.

Some tests need external services and skip when those services are missing. CI provides both, so in CI these tests run instead of skipping:

- PostgreSQL: tests gated on `JJ_TEST_DATABASE_URL`, such as the concurrency tests in `packages/db`. Each of those suites creates and drops its own database, so the user needs the `CREATEDB` privilege. CI starts a PostgreSQL 17 service container and exports the variable to the test step. Locally, point it at a disposable database, never the development one: `docker run -d --rm -p 55432:5432 -e POSTGRES_USER=jj -e POSTGRES_PASSWORD=jj -e POSTGRES_DB=jj_test postgres:17-alpine`, then `JJ_TEST_DATABASE_URL=postgresql://jj:jj@127.0.0.1:55432/jj_test npm run verify`.
- Docker: sandbox driver tests that skip when no Docker daemon is reachable. The CI job runs on the runner VM with its Docker daemon, not inside a job container, and it fails if `docker version` cannot reach the daemon.

The root `vitest.config.ts` sets 20 s per-test and per-hook timeouts, because PGlite-backed suites are slow on loaded machines. It also excludes `.claude/` agent worktrees, so a run from the main checkout matches CI. The default suite covers domain invariants, the coordination state machine, the HTTP surface and the sandbox driver conformance suite against the `local` driver. Service and HTTP tests inject a fake executor, and the executor test uses a mocked provider client, so CI never calls a live model; live behavior is covered only by the smoke scripts. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the verification loop and [AGENTS.md](../AGENTS.md) for the issue workflow.

Changes to `packages/contracts` must bump `CONTRACT_VERSION` and add an entry to [the contract changelog](contract-changelog.md).

## Endpoint boundaries

- `GET /health`: process health, not database or model readiness.
- `GET /api/bootstrap`: reported `mode` (`backend` or `scaffold`), contract version, capabilities, bots and tasks.
- Bots: `GET/POST /api/bots`, `GET /api/bots/:id`, `GET/PUT /api/bots/:id/memory`, `GET/POST /api/bots/:id/messages`, `POST /api/bots/:id/turn` (routes a message to a conversational reply, a new task, or an active task).
- Tasks: `GET/POST /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/view`, `POST /api/tasks/:id/messages`, `/sessions`, `/steer`, `/stop`, `/cancel`, `/participants`, `/coordinator`, `GET /api/tasks/:id/events?after=`, `GET /api/tasks/:id/stream` (SSE with `Last-Event-ID`).
- `/api/copilotkit/*`: OSS AG-UI runtime route; `GET /api/copilotkit/info` discovers agent `jj`.
- `POST /api/agent`: AG-UI run that reuses a durable task and replays its events. Emits `RUN_STARTED`, `CUSTOM jj.task`, streamed task events, `TEXT_MESSAGE_*` and `RUN_FINISHED`/`RUN_ERROR`. Closing the browser connection does not cancel the task. With no service configured, it returns `SCAFFOLD_NOT_IMPLEMENTED`.

Task execution is owned by the backend scheduler, not by an HTTP request or an open stream. The AG-UI and CopilotKit routes are not part of the supported contract; build new clients on `GET /api/tasks/:id/stream`. Keep development services on loopback: the only access control is the optional shared bearer token, and there is no per-user identity.

## Constraints

- AG-UI client/core are pinned to 1.0.2 to match CopilotKit 1.83.0. Mixing that pinned client with a direct 1.0.3 client produced incompatible private class types; do not bypass this with casts.
- The dependency audit is not clean. Review reachability and patched upstream releases before external deployment; do not apply blanket breaking overrides or claim a clean audit.
- The CopilotKit provider produces large rendering-related chunks and the main bundle exceeds 2 MB before gzip. Isolate or lazy-load imports instead of suppressing the size warning.
- PGlite is single-process. Its data directory is locked to the process that opens it, and a second process is refused. A separate worker, or more than one API process, requires PostgreSQL.
- Writes serialize per task and per bot (sequence allocation row-locks that task or bot), never globally. Job claims use `FOR UPDATE SKIP LOCKED`, and at most one run per session and one chat reply per bot is ever active.
- Pooled PostgreSQL connections set `lock_timeout` (10 s) and `idle_in_transaction_session_timeout` (60 s), so a statement stuck waiting on a lock, or a transaction left open, fails instead of hanging.
- Job leases prevent duplicate execution by competing workers, but they do not make external tool effects exactly-once. Reconcile ambiguous effects before retrying after a crash.
