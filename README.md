# JJ Bot

JJ Bot is an open, self-hostable multi-bot agent workspace — an open alternative to Grok's bot. You create persistent bots, give a task a goal and a roster, and watch them work: a coordinator delegates bounded pieces to the others, each bot runs real commands and edits files in the task's sandbox, and everything they say and do lands in one attributed task chat and a live execution graph. You can steer a running task, stop it, continue it after it finishes, and download the files it produced.

## Quickstart

With Docker Engine and Compose v2, from the repository root:

```sh
cp .env.example .env    # then set one model provider key, such as OPENAI_API_KEY
docker compose up -d --build --wait
docker compose logs app | grep "Open JJ Bot"
```

Open the logged link, `http://127.0.0.1:3001/?token=…`. The token is generated on first boot and kept with the data, so the same link works after restarts; the web app remembers it and removes it from the address bar. If you set `API_TOKEN` in `.env`, no link is logged: open `http://127.0.0.1:3001/?token=<API_TOKEN>` instead.

The stack is PostgreSQL and one app container (the API serving the web app, with the worker embedded); each task runs in its own sandbox container on the host's Docker daemon. The app mounts the host's Docker socket, which is root-equivalent on the host, and publishes its port on loopback only. `docker compose down` stops it, and `-v` also deletes the data and the token. See [Docker Compose](docs/development.md#docker-compose) for the details.

## Development

`npm ci`, then `JJ_ENABLE_SCRIPTED_MODEL=true npm run dev`, runs the API and the web app on http://127.0.0.1:5173 with embedded PGlite and a keyless scripted test model, so nothing else is needed. `npm run verify` is the gate CI runs. [Development setup](docs/development.md) has the commands, configuration, endpoints and checks, and [CONTRIBUTING.md](CONTRIBUTING.md) the workflow. Never commit `.env`.

## Architecture

- The **web app** (`apps/web`, React) renders server state over HTTP and server-sent events and never runs agent loops.
- The **API** (`apps/api`, Hono) validates every command against the shared Zod contracts (`packages/contracts`) and streams each task's event log.
- The **worker** (`packages/backend`, embedded in the API by default) claims durable jobs and runs each execution session on the [pi](https://github.com/earendil-works/pi) agent runtime (`packages/runtime`). Model keys and provider calls stay in the worker.
- Agent tools run in a **sandbox** (`packages/sandbox`): one per task, from the coordinator's runtime profile, on the isolating `docker` driver or the unisolated `local` one.
- **Storage** (`packages/db`) is PostgreSQL, or embedded PGlite for one process: records, the job queue and an append-only per-task event log from which chat, the execution graph and reconnects are rebuilt.

[Architecture](docs/architecture.md) is the design contract.

## Documentation

Docs describe stable design, contracts and constraints, not progress. Code and tests establish implementation behavior; status, ownership and handoffs live in GitHub Issues.

- [Product specification](docs/product-spec.md): bots, tasks, sessions, coordination and user control.
- [Architecture](docs/architecture.md): components, execution, the sandbox boundary, records, events and security invariants.
- [Technology stack](docs/tech-stack.md): accepted stack, layer constraints and integration checks.
- [Verification](docs/verification.md): the opt-in task verification contract.
- [Task continuation](docs/task-continuation.md): goal versioning and continuing a finished task.
- [Milestone 1](docs/milestone-1.md): MVP acceptance criteria and the demo task.
- [Development setup](docs/development.md): commands, configuration, endpoints, checks and constraints.
- [Contract changelog](docs/contract-changelog.md): schema changes and required coordination.
- [Workstreams](docs/workstreams.md): milestones, labels and picking up an issue.
- [Reference implementations](docs/references.md): Rakazo, OpenMausBot and OpenBot.
- Package contracts: [engine](packages/backend/README.md), [runtime](packages/runtime/README.md), [sandbox drivers](packages/sandbox/README.md), [storage](packages/db/README.md).

## Work tracking

Work is tracked in [GitHub Issues](https://github.com/LemonPhase/jj-bot/issues), grouped into milestones by phase; see [docs/workstreams.md](docs/workstreams.md) for how to pick up an issue.

No license has been chosen ([#35](https://github.com/LemonPhase/jj-bot/issues/35)).
