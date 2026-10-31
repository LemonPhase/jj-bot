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
| `apps/api`           | Hono service: bootstrap/health, bot and task routes, SSE streaming, AG-UI run endpoint, CopilotKit runtime boundary |
| `apps/worker`        | Optional standalone PostgreSQL worker; the API embeds the scheduler by default                                      |
| `packages/contracts` | Canonical Zod schemas/types for bots, tasks, sessions, messages, checks and attributed events                       |
| `packages/backend`   | BackendService: coordinator, delegation, verification, steering, cancellation, leases and job scheduling            |
| `packages/runtime`   | GeminiSessionExecutor over the Google GenAI SDK, allowlisted tools, deterministic and model checks                  |
| `packages/db`        | Transactional PGlite/PostgreSQL store, idempotent schema, append-only task event log                                |

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
| `API_TOKEN`        | Optional bearer token required on `/api/*` when set.                                        |
| `GEMINI_API_KEY`   | Server-only Google GenAI key. Never expose it to the browser.                               |
| `GEMINI_MODEL`     | Exact model id used for sessions; validate access before relying on it.                     |

Database: `docker compose up -d postgres` starts PostgreSQL 17 under the compose project `jj-bot` (container `jj-bot-postgres-1`, volume `jj-bot_jj_postgres`) on `127.0.0.1:5433`. `docker compose stop` halts it; `docker compose down` removes the container and keeps the named volume. The store applies an idempotent v1 migration on open, so no separate migration step is required.

## Checks

```sh
npm run check         # lint + tests + all-package typecheck + web build
npm run format        # format and safe lint/import fixes
npm run test
npm run typecheck
npm run smoke:model   # live Gemini round trip; needs .env
npm run smoke:tool    # live tool-call round trip; needs .env
npm run smoke:backend # live end-to-end task run; needs .env, running API and database
```

CI runs `npm ci`, lint and tests on Node 24. The default suite covers domain invariants, the coordination state machine and the HTTP surface. `packages/db/src/store.test.ts` includes an opt-in PostgreSQL adapter test enabled with `JJ_TEST_DATABASE_URL`. Service and HTTP tests inject a fake executor, and the executor test uses a mocked provider client, so CI never calls a live model; live behavior is covered only by the smoke scripts. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the verification loop and [AGENTS.md](../AGENTS.md) for the Notion coordination policy.

Changes to `packages/contracts` must bump `CONTRACT_VERSION` and add an entry to [the contract changelog](contract-changelog.md).

## Endpoint boundaries

- `GET /health`: process health, not database or model readiness.
- `GET /api/bootstrap`: reported `mode` (`backend` or `scaffold`), contract version, capabilities, bots and tasks.
- Bots: `GET/POST /api/bots`, `GET /api/bots/:id`, `GET/PUT /api/bots/:id/memory`, `GET/POST /api/bots/:id/messages`.
- Tasks: `GET/POST /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/view`, `POST /api/tasks/:id/messages`, `/sessions`, `/steer`, `/stop`, `/cancel`, `/participants`, `/coordinator`, `GET /api/tasks/:id/events?after=`, `GET /api/tasks/:id/stream` (SSE with `Last-Event-ID`).
- `/api/copilotkit/*`: OSS AG-UI runtime route; `GET /api/copilotkit/info` discovers agent `jj`.
- `POST /api/agent`: AG-UI run that reuses a durable task and replays its events. Emits `RUN_STARTED`, `CUSTOM jj.task`, streamed task events, `TEXT_MESSAGE_*` and `RUN_FINISHED`/`RUN_ERROR`. Closing the browser connection does not cancel the task. With no service configured, it returns `SCAFFOLD_NOT_IMPLEMENTED`.

Task execution is owned by the backend scheduler, not by an HTTP request or an open stream. CopilotKit's runtime is integration plumbing; it is not the durable task store. Keep development services on loopback: the only access control is the optional shared bearer token, and there is no per-user identity.

## Constraints

- AG-UI client/core are pinned to 1.0.2 to match CopilotKit 1.83.0. Mixing that pinned client with a direct 1.0.3 client produced incompatible private class types; do not bypass this with casts.
- The dependency audit is not clean. Review reachability and patched upstream releases before external deployment; do not apply blanket breaking overrides or claim a clean audit.
- The CopilotKit provider produces large rendering-related chunks and the main bundle exceeds 2 MB before gzip. Isolate or lazy-load imports instead of suppressing the size warning.
- PostgreSQL mode serializes application writes through a single lock row: correctness over throughput. Partitioned locks or indexed repositories can follow when load justifies them.
- Job leases prevent duplicate execution by competing workers, but they do not make external tool effects exactly-once. Reconcile ambiguous effects before retrying after a crash.
