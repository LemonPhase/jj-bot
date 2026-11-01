# Development setup

## Prerequisites and start

Use Node.js 24 (minimum 22.12) and npm. Docker is optional: it runs PostgreSQL and the `docker` sandbox driver, or the whole product (see [Docker Compose](#docker-compose)). From the repository root:

```sh
npm ci
JJ_ENABLE_SCRIPTED_MODEL=true npm run dev
```

Open http://127.0.0.1:5173. `npm run dev` starts the API on http://127.0.0.1:3001 with the worker embedded, and the Vite dev server, which proxies `/api` and `/health` to it (update `apps/web/vite.config.ts` if you change `API_PORT`). Stop both with Ctrl+C.

With no settings the API stores everything in embedded PGlite under `.jj-data` and needs no other service. To run bots, configure a model: `JJ_ENABLE_SCRIPTED_MODEL=true` registers the keyless, deterministic scripted test model (`scripted/team`), or put a provider key in `.env` (`cp .env.example .env`). Without either, the API stores and serves bots and tasks, bootstrap reports `capabilities.agentExecution: false` and tasks are refused with `MODEL_NOT_CONFIGURED`. Never commit `.env`.

For PostgreSQL, run `docker compose up -d postgres` and set `DATABASE_URL=postgresql://jj:jj_local@localhost:5433/jj_bot`. The compose project `jj-bot` runs PostgreSQL 17 (container `jj-bot-postgres-1`, volume `jj-bot_jj_postgres`) on `127.0.0.1:5433`; `docker compose stop` halts it and `docker compose down` removes the container but keeps the volume.

One process serves everything in production: `npm run build -w @jj/web`, then `npm run start -w @jj/api` serves the built app from `apps/web/dist` on the API port, with client routes falling back to `index.html`.

To run the worker separately, set `DATABASE_URL` and `JJ_EMBED_WORKER=false` for the API and start `npm run dev:worker` (or `npm run start -w @jj/worker`). The worker refuses to start without `DATABASE_URL`, and the API refuses `JJ_EMBED_WORKER=false` on PGlite.

## Docker Compose

`compose.yaml` runs the whole product on one Docker host:

```sh
cp .env.example .env    # then set one model provider key in .env
docker compose up -d --build
```

Open http://127.0.0.1:3001 (`JJ_PORT` changes the host port). Compose reads `.env` only to fill the variables `compose.yaml` names (provider keys, `JJ_DEFAULT_MODEL`, `JJ_ENABLE_SCRIPTED_MODEL`, `API_TOKEN`, the proxy variables, the engine limits, `JJ_PORT`, `JJ_POSTGRES_PORT`, `JJ_DOCKER_NAMESPACE`, `JJ_DOCKER_SOCKET`); other settings in `.env`, such as `API_HOST`, never reach the container. `docker compose up -d postgres` alone still starts just the database for `npm run dev`.

| Service         | What it is                                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`      | PostgreSQL 17 with a healthcheck; data in the volume `jj-bot_jj_postgres`.                                                                                                                |
| `app`           | The root `Dockerfile`: the API serving the built web app, with the worker embedded, on PostgreSQL. Starts once `postgres` is healthy; healthy itself while `/health/ready` is 200.        |
| `sandbox-image` | Builds `jj-sandbox:base-1` from `packages/sandbox/images/base` on the host's daemon, where the docker driver looks for it, and exits at once. The app needs the image, not the container. |

- **Image.** A multi-stage build: `npm ci` and the web bundle in one stage, the API's and worker's production dependencies in another, and a Node 24 slim runtime that runs `node --import tsx apps/api/src/index.ts` from `/app`. The code is owned by root and read-only to the app. Behind a TLS-intercepting proxy, pass its CA bundle as the build secret `build_ca` (`docker build --secret id=build_ca,src=ca.pem .`, or `build.secrets` in a compose override); it is never stored in a layer.
- **Sandboxes.** Only the `docker` driver is registered (`JJ_SANDBOX_DRIVERS=docker`), so the default profile is the isolated docker sandbox. Never enable `local` in the container: its commands would run next to the model keys and the Docker socket. Sandboxes are sibling containers on the host's daemon in the namespace `jj` (`JJ_DOCKER_NAMESPACE`), on Docker's default bridge network rather than the compose network, so they cannot reach the app or PostgreSQL by container address. The one-worker-per-namespace constraint below applies: the compose app is that namespace's worker.
- **The Docker socket.** The host's socket is mounted at `/var/run/docker.sock` (`JJ_DOCKER_SOCKET` picks another host path, such as a rootless daemon's). It is root-equivalent on the host: whoever controls the app container controls the host. The driver never passes it into a sandbox, never starts privileged containers and never bind-mounts host paths ([Sandbox boundary](architecture.md#sandbox-boundary)).
- **No root.** The entrypoint (`docker/entrypoint.sh`) starts as root only to read the socket's group id, which differs per host, adds that group to the user `jj` (uid 10001), and drops to it with `setpriv` and `no_new_privs`; the app holds no capabilities. A socket its group cannot read and write is reported in the log, and the driver then reports unavailable. An image started with `--user` skips the switch, so give that user the socket's group with `group_add`. The container also runs with a read-only root filesystem, a `/tmp` tmpfs, `no-new-privileges` and every capability dropped except `SETUID` and `SETGID` (the entrypoint) and `KILL` (init forwarding stop signals).
- **Authentication.** Inside the container the API listens on `0.0.0.0`, which it refuses without `API_TOKEN` unless `API_ALLOW_UNAUTHENTICATED=true`. Compose sets that opt-in because it publishes the port on the host's loopback only. Publishing the port beyond loopback, or putting anything in front of it that other machines can reach, requires `API_TOKEN` (open the app once with `?token=`). Loopback keeps other machines out, not software on the host: any local process can use the API without a token, and on Docker Desktop containers, sandboxes included, reach the host's loopback through `host.docker.internal`. Set `API_TOKEN` where that matters.
- **Proxy.** `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` pass through for model calls. `127.0.0.1` inside the container is the container itself; a proxy on the host is `host.docker.internal`.
- **Restarts.** `docker compose restart app` or `stop` sends SIGTERM and allows 30 s, more than the API's own 20 s shutdown limit, so running sessions are handed back and resume from their last completed turn when the app starts again; a command cut short is reported as interrupted, never re-run.
- **Data.** `docker compose down -v` removes the PostgreSQL volume, but not the task workspaces, which are Docker volumes named `jj-task-<taskId>` and labelled `jj.sandbox.namespace=jj`: `docker volume ls -q --filter label=jj.sandbox.namespace=jj | xargs -r docker volume rm` removes them.

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

The API's composition root is `apps/api/src/server.ts` (`startServer`). It configures the outbound proxy, opens the database (applying migrations), registers the sandbox drivers, builds the model registry, executor and chat responder and the engine, starts the embedded worker and listens. `createApp({ engine, config })` in `apps/api/src/app.ts` is the HTTP app alone, so tests drive it with `app.request`. `apps/api/src/wiring.ts` (`openServices`) is shared with `apps/worker`.

## Configuration

Settings are environment variables, read from `.env` at the repository root by the dev and start scripts. Relative paths resolve against the repository root. A setting that cannot work stops the process at startup with a message naming it.

| Variable                                | Purpose                                                                                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_HOST`                              | Listener address, default `127.0.0.1`. A non-loopback address requires `API_TOKEN`, or `API_ALLOW_UNAUTHENTICATED=true`; the server refuses to start without either. |
| `API_PORT`                              | Listener port, default `3001`; `0` picks a free one.                                                                                                                 |
| `API_TOKEN`                             | Bearer token required on `/api/*` when set. The web app reads it once from `?token=` and keeps it in localStorage.                                                   |
| `API_ALLOW_UNAUTHENTICATED`             | `true` lets the API listen beyond loopback without `API_TOKEN`. Only for a container whose port the host publishes on loopback only, as `compose.yaml` does.         |
| `DATABASE_URL`                          | PostgreSQL connection string. When set, the API and worker use PostgreSQL.                                                                                           |
| `JJ_DATABASE_PATH`                      | PGlite data directory when `DATABASE_URL` is unset, default `.jj-data`; `memory://` keeps nothing (bootstrap reports no persistence).                                |
| `JJ_EMBED_WORKER`                       | `true` (default) runs the job loop in the API; `false` leaves it to `apps/worker` and needs PostgreSQL.                                                              |
| `JJ_ENABLE_SCRIPTED_MODEL`              | `true` registers the keyless scripted test model `scripted/team`. The web app labels it "Scripted model".                                                            |
| Provider keys                           | One variable per provider, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; `GET /api/models` lists every provider with its `envVars`.                               |
| `JJ_DEFAULT_MODEL`                      | `provider/model` for bots without a model, when that provider is configured; otherwise a cheap model of the first configured provider.                               |
| `JJ_CONCURRENCY`                        | Jobs (session runs and chat replies) one worker runs at once, default `4`.                                                                                           |
| `JJ_MAX_SESSIONS_PER_TASK`              | Sessions a task may create, default `16`.                                                                                                                            |
| `JJ_MAX_DELEGATION_DEPTH`               | Delegation depth below the coordinator, default `3`.                                                                                                                 |
| `JJ_TASKS_PER_BOT_PER_HOUR`             | Tasks a bot may create from direct chat per hour, default `10`.                                                                                                      |
| `JJ_OUTPUT_CAP_BYTES`                   | Tool output kept in events, default and maximum 65536; larger output is stored as an artifact.                                                                       |
| `JJ_SANDBOX_DRIVERS`                    | Drivers to register, comma-separated from `docker` and `local`, default both. `docker` stays registered without a daemon and reports unavailable.                    |
| `JJ_SANDBOX_ROOT`                       | Workspace root of the `local` driver, default `<os.tmpdir()>/jj-sandbox`; the OS may clear it, so point it somewhere durable. The operator clears it.                |
| `JJ_DOCKER_NAMESPACE`                   | Container and volume name prefix of the `docker` driver, default `jj-sandbox`.                                                                                       |
| `DOCKER_HOST`                           | Docker Engine API address, default `/var/run/docker.sock`. Plain-HTTP `tcp://` beyond loopback needs `JJ_DOCKER_ALLOW_INSECURE_TCP=true`.                            |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Outbound proxy for model provider calls (either case; lowercase wins). A proxy's CA goes in `NODE_EXTRA_CA_CERTS`.                                                   |
| `JJ_POSTGRES_PORT`                      | Host port of the compose PostgreSQL service (loopback), default `5433`.                                                                                              |
| `JJ_PORT`                               | Host port of the compose app (loopback), default `3001`.                                                                                                             |
| `JJ_DOCKER_SOCKET`                      | Host path of the Docker socket compose mounts into the app, default `/var/run/docker.sock`.                                                                          |

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
- **Validation.** The engine parses every request body with its contract schema. Path ids, `after`, `limit` and `Last-Event-ID` are checked in the API.
- **Task stream.** One frame per event: `id:` the sequence, `event:` the type, `data:` the event JSON. It replays events after `Last-Event-ID`, else after `?after=`, else from the start, then streams new ones; each event is sent once, in order. An unknown task answers 404 before the stream opens. The stream stays open after the task finishes, since a message can continue it.
- **Workspace stream.** One frame per hint, `event:` its type and `data:` the hint JSON, without ids: it is not resumable, so clients refetch on (re)connect.
- **Both streams** send `: heartbeat` comments every 15 s, carry `Cache-Control: no-cache` and `X-Accel-Buffering: no`, close their database subscription when the client disconnects, and end on shutdown.
- **Artifacts** download as `Content-Disposition: attachment` with the artifact's content type, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, so agent-written files never run as the app's pages.
- **Readiness** reports `database` (a query), `migrations` (none pending), `worker` (the embedded job loop polled within 30 s; skipped when the worker runs elsewhere) and `drivers` (at least one available). `/health` and `/health/ready` are unauthenticated and report states and counts only.
- **Static files.** When `apps/web/dist` exists, other paths serve its files, and page routes without a file extension fall back to `index.html`. They never answer `/api` or `/health`.

Task execution is owned by the worker, not by an HTTP request or an open stream: closing the browser does not stop a task. The only access control is the optional shared bearer token; there is no per-user identity, so keep the API on loopback (in compose, its published port) unless a token is set.

## Checks

```sh
npm run verify        # the CI gate: lint + all-package typecheck + tests + web build
npm run check         # alias for verify
npm run format        # format and safe lint/import fixes
npm run test
npm run typecheck
npm run smoke:e2e     # the whole server over HTTP on PGlite, the local driver and the scripted model
JJ_SMOKE_BASE_URL=http://127.0.0.1:3001 npm run smoke:e2e   # the same against a running stack, on the docker driver
npm run smoke:runtime # one live pi tool cycle in a local sandbox; JJ_SMOKE_MODEL (default openai/gpt-6-luna) and its key
```

`smoke:e2e` boots the API in-process on a temporary PGlite directory, creates three bots and a task with all of them, follows the task stream to completion, checks that two workers ran in parallel and that every artifact downloads intact, and stops a second task; it exits non-zero on any failure. `JJ_SMOKE_MODEL=<provider/model> npm run smoke:e2e` runs the same flow on a real model whose key is set.

With `JJ_SMOKE_BASE_URL` it boots nothing and drives the server at that URL (`JJ_SMOKE_TOKEN` is its bearer token, if any). It then also checks that the default profile is the available, isolated docker sandbox and that the workers' commands ran as the sandbox user in `/workspace`. `JJ_SMOKE_RESTART_COMMAND` adds restart survival: a third task's workers are caught running a slow command, the command (such as `docker compose restart app`) restarts the server, and the task must still complete, with the cut-short commands reported as stopped, the runs handed back and resumed, no finished tool call run again, and the stream replayed across the restart folding into the same view a reload returns.

CI (`.github/workflows/ci.yml`) runs on every push and pull request, on the Node version in `.nvmrc`, in two parallel jobs. The first, after `npm ci`, builds the sandbox base image, then runs lint, typecheck, tests, the web build and `smoke:e2e` (scripted model only). Every step must pass, and each runs even when an earlier one fails, so one run reports every failure. The second, "Compose stack", runs `docker compose build` (the app image and the sandbox image), starts the stack with the scripted model, waits for `/health/ready`, and runs `smoke:e2e` against it through the published loopback port with `JJ_SMOKE_RESTART_COMMAND="docker compose restart app"`; on failure it prints the stack's logs, and it always ends with `docker compose down -v`. A newer run on the same ref cancels the superseded one.

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
