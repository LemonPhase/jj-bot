# Development setup

## Prerequisites and start

Use Node.js 24 (minimum 22.12) and npm. Docker is optional: it runs PostgreSQL and the `docker` sandbox driver. From the repository root:

```sh
npm ci
JJ_ENABLE_SCRIPTED_MODEL=true npm run dev
```

Open http://127.0.0.1:5173. `npm run dev` starts the API on http://127.0.0.1:3001 with the worker embedded, and the Vite dev server, which proxies `/api` and `/health` to it (update `apps/web/vite.config.ts` if you change `API_PORT`). Stop both with Ctrl+C.

With no settings the API stores everything in embedded PGlite under `.jj-data` and needs no other service. To run bots, configure a model: `JJ_ENABLE_SCRIPTED_MODEL=true` registers the keyless, deterministic scripted test model (`scripted/team`), or put a provider key in `.env` (`cp .env.example .env`). Without either, the API stores and serves bots and tasks, bootstrap reports `capabilities.agentExecution: false` and tasks are refused with `MODEL_NOT_CONFIGURED`. Never commit `.env`.

For PostgreSQL, run `docker compose up -d postgres` and set `DATABASE_URL=postgresql://jj:jj_local@localhost:5433/jj_bot`. The compose project `jj-bot` runs PostgreSQL 17 (container `jj-bot-postgres-1`, volume `jj-bot_jj_postgres`) on `127.0.0.1:5433`; `docker compose stop` halts it and `docker compose down` removes the container but keeps the volume.

One process serves everything in production: `npm run build -w @jj/web`, then `npm run start -w @jj/api` serves the built app from `apps/web/dist` on the API port, with client routes falling back to `index.html`.

To run the worker separately, set `DATABASE_URL` and `JJ_EMBED_WORKER=false` for the API and start `npm run dev:worker` (or `npm run start -w @jj/worker`). The worker refuses to start without `DATABASE_URL`, and the API refuses `JJ_EMBED_WORKER=false` on PGlite.

## Workspace ownership

| Directory            | Responsibility                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/web`           | React/Vite workspace: bot chat, task chat, execution view, steering and stop, settings                         |
| `apps/api`           | Hono HTTP and SSE layer over the engine, health and readiness, serving the built web app; the composition root |
| `apps/worker`        | Standalone job loop on the API's wiring, for PostgreSQL deployments that do not embed the worker               |
| `packages/contracts` | Canonical Zod schemas and types: the HTTP and SSE contract                                                     |
| `packages/backend`   | The engine: bots, profiles, tasks, messages, chat, artifacts and views, and the worker that runs sessions      |
| `packages/runtime`   | The pi agent runtime: model registry, session executor, chat responder and the scripted test model             |
| `packages/sandbox`   | Sandbox driver contract, the `local` and `docker` drivers and the shared driver conformance suite              |
| `packages/db`        | Drizzle schema and migrations, per-task sequences, job queue and LISTEN/NOTIFY bus on PostgreSQL or PGlite     |

Internal packages export TypeScript source. The API and worker run with `tsx`; `build` typechecks all packages and produces the web bundle.

The API's composition root is `apps/api/src/server.ts` (`startServer`). It configures the outbound proxy, opens the database (applying migrations), registers the sandbox drivers, builds the model registry, executor and chat responder and the engine, listens, and then starts the embedded worker, so a port clash fails before any run is claimed. `createApp({ engine, config })` in `apps/api/src/app.ts` is the HTTP app alone, so tests drive it with `app.request`. `apps/api/src/wiring.ts` (`openServices`) is shared with `apps/worker`.

### Web app structure

`apps/web/src` keeps screens in feature folders (`features/shell`, `bots`, `tasks`, `office`, `studio`, `settings`), the design-system kit in `components/ui` and `components/sprite`, pure helpers in `lib`, and the backend seam in `api` (`JJApi`) with workspace state in `state`. Screens are addressed by URL hash, so every view is linkable and survives a reload: `#/bots/:botId`, `#/tasks/:taskId`, `#/studio` (new bot) or `#/studio/:botId`, and `#/settings`. `features/shell/router.ts` parses and formats them and `useRoute()`/`navigate()` bind them to the window; a list route without an id opens the first item. The dev-only kit gallery is at `?gallery=1`, and `?demo` forces demo data.

## Configuration

Settings are environment variables, read from `.env` at the repository root by the dev and start scripts. Relative paths resolve against the repository root. A setting that cannot work stops the process at startup with a message naming it.

| Variable                                | Purpose                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `API_HOST`                              | Listener address, default `127.0.0.1`. A non-loopback address requires `API_TOKEN`; the server refuses to start without it.                            |
| `API_PORT`                              | Listener port, default `3001`; `0` picks a free one.                                                                                                   |
| `API_TOKEN`                             | Bearer token required on `/api/*` when set. The web app reads it once from `?token=` and keeps it in localStorage.                                     |
| `API_ALLOWED_HOSTS`                     | Without `API_TOKEN`, `Host` values besides loopback that `/api/*` answers, comma-separated: a hostname (any port) or `host:port`. For reverse proxies. |
| `DATABASE_URL`                          | PostgreSQL connection string. When set, the API and worker use PostgreSQL.                                                                             |
| `JJ_DATABASE_PATH`                      | PGlite data directory when `DATABASE_URL` is unset, default `.jj-data`; `memory://` keeps nothing (bootstrap reports no persistence).                  |
| `JJ_EMBED_WORKER`                       | `true` (default) runs the job loop in the API; `false` leaves it to `apps/worker` and needs PostgreSQL.                                                |
| `JJ_ENABLE_SCRIPTED_MODEL`              | `true` registers the keyless scripted test model `scripted/team`. The web app labels it "Scripted model".                                              |
| Provider keys                           | One variable per provider, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; `GET /api/models` lists every provider with its `envVars`.                 |
| `JJ_DEFAULT_MODEL`                      | `provider/model` for bots without a model, when that provider is configured; otherwise a cheap model of the first configured provider.                 |
| `JJ_CONCURRENCY`                        | Jobs (session runs and chat replies) one worker runs at once, default `4`.                                                                             |
| `JJ_MAX_SESSIONS_PER_TASK`              | Sessions a task may create, default `16`.                                                                                                              |
| `JJ_MAX_DELEGATION_DEPTH`               | Delegation depth below the coordinator, default `3`.                                                                                                   |
| `JJ_TASKS_PER_BOT_PER_HOUR`             | Tasks a bot may create from direct chat per hour, default `10`.                                                                                        |
| `JJ_OUTPUT_CAP_BYTES`                   | Tool output kept in events, default and maximum 65536; larger output is stored as an artifact.                                                         |
| `JJ_SANDBOX_DRIVERS`                    | Drivers to register, comma-separated from `docker` and `local`, default both. `docker` stays registered without a daemon and reports unavailable.      |
| `JJ_SANDBOX_ROOT`                       | Workspace root of the `local` driver, default `<os.tmpdir()>/jj-sandbox`; the OS may clear it, so point it somewhere durable. The operator clears it.  |
| `JJ_DOCKER_NAMESPACE`                   | Container and volume name prefix of the `docker` driver, default `jj-sandbox`.                                                                         |
| `DOCKER_HOST`                           | Docker Engine API address, default `/var/run/docker.sock`. Plain-HTTP `tcp://` beyond loopback needs `JJ_DOCKER_ALLOW_INSECURE_TCP=true`.              |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Outbound proxy for model provider calls (either case; lowercase wins). A proxy's CA goes in `NODE_EXTRA_CA_CERTS`.                                     |
| `JJ_POSTGRES_PORT`                      | Host port of the compose PostgreSQL service, default `5433`.                                                                                           |

Schema: opening the database applies the SQL migrations in `packages/db/migrations`, so there is no separate migration step; processes opening one PostgreSQL database at once serialize on an advisory lock. To change the schema, edit `packages/db/src/schema.ts`, run `npm run db:generate -w @jj/db` and commit the generated migration. Never edit a migration that has been applied. The store's contract is in `packages/db/README.md`.

## Endpoints

The route table and every shape are in [the contract changelog](contract-changelog.md) (1.0.0); the schemas are in `packages/contracts`.

| Method | Path                                           | Answer                                                      |
| ------ | ---------------------------------------------- | ----------------------------------------------------------- |
| `GET`  | `/health`                                      | liveness                                                    |
| `GET`  | `/health/ready`                                | readiness checks; 200 when ready, 503 otherwise             |
| `GET`  | `/api/bootstrap`                               | mode, contract version, capabilities, bots, tasks, profiles |
| `GET`  | `/api/stream`                                  | SSE workspace hints                                         |
| `GET`  | `/api/bots`, `POST /api/bots`                  | `{ bots }`; `{ bot }` (201)                                 |
| `GET`  | `/api/bots/:id`, `PATCH`, `DELETE`             | `{ bot }`; `{ bot }`; archives (204)                        |
| `GET`  | `/api/bots/:id/memory`, `PUT`                  | the bot's memory                                            |
| `GET`  | `/api/bots/:id/messages`, `POST`               | the conversation; `{ message }` (201), the reply follows    |
| `GET`  | `/api/runtime-profiles`, `POST`                | `{ profiles }`; `{ profile }` (201)                         |
| `GET`  | `/api/runtime-profiles/:id`, `PATCH`, `DELETE` | `{ profile }`; `{ profile }`; 204                           |
| `GET`  | `/api/sandbox-drivers`                         | `{ drivers }` with capabilities and spec JSON Schema        |
| `GET`  | `/api/models`                                  | providers, their models and the default model               |
| `GET`  | `/api/tasks`, `POST /api/tasks`                | `{ tasks }` (summaries); `{ task }` (201)                   |
| `GET`  | `/api/tasks/:id`                               | the task view, with its `cursor`                            |
| `POST` | `/api/tasks/:id/messages`                      | `{ message }` (201)                                         |
| `POST` | `/api/tasks/:id/stop`                          | `{ task }`                                                  |
| `GET`  | `/api/tasks/:id/events?after=&limit=`          | an event page with full output previews                     |
| `GET`  | `/api/tasks/:id/stream`                        | SSE task events                                             |
| `GET`  | `/api/tasks/:id/artifacts/:artifactId/content` | the artifact's bytes                                        |

- **Errors.** Every non-2xx JSON answer is `{ error: { code, message, details? } }` with a contract code and its status (`VALIDATION_FAILED` 400, `UNAUTHORIZED` 401, `NOT_FOUND` 404, `CONFLICT` and the other refusals 409, `MODEL_NOT_CONFIGURED`, `PROFILE_UNSUPPORTED` and `VERIFICATION_UNAVAILABLE` 422, `RATE_LIMITED` 429). A body that is not JSON is `VALIDATION_FAILED`, one over 1 MiB is `VALIDATION_FAILED` with 413, an unknown route is `NOT_FOUND`. Anything unexpected is `500 INTERNAL` with no detail; the stack goes to the server log.
- **Browser protection.** Every `/api/*` request with `Sec-Fetch-Site: cross-site` is refused with 403. Without `API_TOKEN`, only loopback `Host` values (`localhost`, `127.0.0.1`, `[::1]`, any port) and `API_ALLOWED_HOSTS` are answered; any other `Host`, such as a DNS-rebinding page's own name, gets 403. POST, PUT and PATCH need `Content-Type: application/json` (415 otherwise), so a cross-origin write always needs a CORS preflight, and the API sends no CORS headers. The Vite dev proxy keeps the browser's `Host` (`127.0.0.1:5173`), and a container whose port is published on the host's loopback receives `127.0.0.1:<port>` or `localhost:<port>`; both pass. With a token, the bearer check replaces the `Host` check.
- **Validation.** The engine parses every request body with its contract schema. Path ids, `after`, `limit` and `Last-Event-ID` are checked in the API.
- **Task stream.** One frame per event: `id:` the sequence, `event:` the type, `data:` the event JSON. It replays events after `Last-Event-ID`, else after `?after=`, else from the start, then streams new ones; each event is sent once, in order. An unknown task answers 404 before the stream opens. The stream stays open after the task finishes, since a message can continue it.
- **Workspace stream.** One frame per hint, `event:` its type and `data:` the hint JSON, without ids: it is not resumable, so clients refetch on (re)connect.
- **Both streams** send `: heartbeat` comments every 15 s, carry `Cache-Control: no-cache` and `X-Accel-Buffering: no`, close their database subscription when the client disconnects, and end on shutdown, even when the client has stopped reading. `HEAD` gets the stream headers and opens nothing. The workspace stream subscribes before its response starts, so no hint falls between subscribing and the client seeing the stream open.
- **Artifacts** download as `Content-Disposition: attachment` with the artifact's content type, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, so agent-written files never run as the app's pages.
- **Readiness** reports `database` (a query), `migrations` (none pending), `worker` (the embedded job loop polled within 30 s; skipped when the worker runs elsewhere) and `drivers` (at least one available). `/health` and `/health/ready` are unauthenticated and report states and counts only.
- **Static files.** When `apps/web/dist` exists, other paths serve its files, and page routes without a file extension fall back to `index.html`. They never answer `/api` or `/health`.

Task execution is owned by the worker, not by an HTTP request or an open stream: closing the browser does not stop a task. The only access control is the optional shared bearer token, plus the browser protection above; there is no per-user identity, so keep the API on loopback unless a token is set.

## Checks

```sh
npm run verify        # the CI gate: lint + all-package typecheck + tests + web build
npm run check         # alias for verify
npm run format        # format and safe lint/import fixes
npm run test
npm run typecheck
npm run smoke:e2e     # the whole server over HTTP on PGlite, the local driver and the scripted model
npm run smoke:runtime # one live pi tool cycle in a local sandbox; JJ_SMOKE_MODEL (default openai/gpt-6-luna) and its key
```

`smoke:e2e` boots the API in-process on a temporary PGlite directory, creates three bots and a task with all of them, follows the task stream to completion, checks that two workers ran in parallel and that every artifact downloads intact, and stops a second task; it exits non-zero on any failure. `JJ_SMOKE_MODEL=<provider/model> npm run smoke:e2e` runs the same flow on a real model whose key is set.

CI (`.github/workflows/ci.yml`) runs on every push and pull request, on the Node version in `.nvmrc`. After `npm ci` it builds the sandbox base image, then runs lint, typecheck, tests, the web build and `smoke:e2e` (scripted model only). Every step must pass, and each runs even when an earlier one fails, so one run reports every failure. A newer run on the same ref cancels the superseded one.

Some tests need external services and skip when those services are missing. CI provides both, so there these tests run instead of skipping:

- PostgreSQL: tests gated on `JJ_TEST_DATABASE_URL`, such as the concurrency tests in `packages/db` and the separate-worker test in `apps/worker`. Each of those suites creates and drops its own database, so the user needs the `CREATEDB` privilege. Locally, point it at a disposable server, never the development one: `docker run -d --rm -p 55432:5432 -e POSTGRES_USER=jj -e POSTGRES_PASSWORD=jj -e POSTGRES_DB=jj_test postgres:17-alpine`, then `JJ_TEST_DATABASE_URL=postgresql://jj:jj@127.0.0.1:55432/jj_test npm run verify`.
- Docker: sandbox driver tests that skip when no Docker daemon is reachable. CI runs on the runner VM with its Docker daemon and fails if `docker version` cannot reach it; it builds the base image with `npm run sandbox:image` and sets `JJ_SANDBOX_TEST_IMAGE=jj-sandbox:base-1`. Locally the tests use that image when it is built and `node:22-bookworm-slim` otherwise.

The root `vitest.config.ts` sets 20 s per-test and per-hook timeouts, because PGlite-backed suites are slow on loaded machines, and excludes `.claude/` agent worktrees so a run from the main checkout matches CI. No test calls a live model: the engine suites use a fake executor, the runtime suites pi's faux provider and the scripted model, and the API suites drive the real wiring with the scripted model through `app.request` and a real server. `apps/api/src/web-client.test.ts` runs the web app's `liveApi` against the server, which keeps the client and the routes in step. Live model behavior is covered only by the smoke scripts. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the verification loop and [AGENTS.md](../AGENTS.md) for the issue workflow.

Changes to `packages/contracts` must bump `CONTRACT_VERSION` and add an entry to [the contract changelog](contract-changelog.md).

## Constraints

- PGlite is single-process. Its data directory is locked to the process that opens it and a second process is refused. A separate worker, or more than one API process, requires PostgreSQL.
- One worker per `JJ_DOCKER_NAMESPACE` on a Docker daemon. At start a worker removes every container of its namespace that another process started (`reapOrphans`), so two live workers in one namespace remove each other's sandboxes; an API with `JJ_EMBED_WORKER=true` counts as a worker. Task volumes are named by namespace (`<namespace>-task-<taskId>`), so workers in separate namespaces do not share task workspaces either. Scaling workers needs a shared-namespace design ([#45](https://github.com/LemonPhase/jj-bot/issues/45)).
- The `local` driver is not an isolation boundary: commands run as the server's user and can read its files, `.env` included, and its environment. Use `docker` for anything but trusted development. Its commands get `GIT_CEILING_DIRECTORIES` set to the driver root, so git in a workspace never finds a repository above the root.
- Writes serialize per task and per bot (sequence allocation row-locks that task or bot), never globally. Job claims use `FOR UPDATE SKIP LOCKED`, and at most one run per session and one chat reply per bot is ever active.
- Pooled PostgreSQL connections set `lock_timeout` (10 s) and `idle_in_transaction_session_timeout` (60 s), so a statement stuck waiting on a lock, or a transaction left open, fails instead of hanging.
- Job leases prevent duplicate execution by competing workers, but they do not make external tool effects exactly-once. Reconcile ambiguous effects before retrying after a crash.
- The dependency audit is not clean. Review reachability and patched upstream releases before external deployment; do not apply blanket breaking overrides or claim a clean audit.
