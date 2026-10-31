# JJ Bot

JJ Bot is an agent workspace. Persistent bot personas with deliberately scoped memory work on goal-oriented tasks through independently contextualized execution sessions. Every task has a coordinator, a shared and attributed group chat, and a verification plan; messages are visible to all participants without triggering every bot. Users can steer a running task or stop it, and a task only completes when its verification evidence supports it.

The backend owns execution and verification: it schedules sessions, runs the Google GenAI loop server-side, persists ordered events, and keeps task state independent of browser connections. CopilotKit/AG-UI is the chat and streaming boundary in front of it, not the source of task truth. The API and scheduler are the working surface today; the web client is still a shell that reports capability state rather than a task workspace.

## Run locally

Use Node.js 24 (minimum 22.12), npm, and Docker for the default PostgreSQL store:

```sh
npm ci
cp .env.example .env
docker compose up -d postgres
npm run dev
```

Open http://127.0.0.1:5173. The API listens on http://127.0.0.1:3001. Set `JJ_DATABASE_MODE=pglite` to run without Docker (single process only). Add `GEMINI_API_KEY` and `GEMINI_MODEL` to run model sessions; without them the API still stores and serves bots and tasks, but execution cannot start.

Run `npm run check` for lint, tests, all-package typecheck and the web build. Never commit `.env`. See [development setup](docs/development.md) for the full command set, configuration and endpoint boundaries.

## Repository layout

| Directory            | Responsibility                                                                   |
| -------------------- | -------------------------------------------------------------------------------- |
| `apps/web`           | React/Vite client, CopilotKit provider, capability and connection state          |
| `apps/api`           | Hono service: bootstrap/health, bot and task routes, SSE, AG-UI runtime          |
| `apps/worker`        | Optional standalone PostgreSQL worker when the API does not embed the scheduler  |
| `packages/contracts` | Canonical Zod schemas and types; the frontend/backend boundary                   |
| `packages/backend`   | Coordinator, delegation, verification, steering, cancellation, and scheduling    |
| `packages/runtime`   | Direct Google GenAI execution, allowlisted tools, deterministic and model checks |
| `packages/db`        | Transactional PGlite/PostgreSQL store with an append-only task event log         |

## Documentation

Docs describe stable design, contracts and constraints — not progress. Implementation behavior is established by code and tests; status, ownership and handoffs live in the team Notion workspace.

- [Product specification](docs/product-spec.md): bot, task, session and coordinator semantics.
- [Architecture](docs/architecture.md): boundaries, records, event flow and context rules.
- [Verification](docs/verification.md): checks, evidence, revision and completion rules.
- [Milestone 1](docs/milestone-1.md): the multi-bot vertical slice and its acceptance criteria.
- [Technology stack](docs/tech-stack.md): accepted stack, layer constraints and sources.
- [Development setup](docs/development.md): commands, configuration and endpoint boundaries.
- [Contract changelog](docs/contract-changelog.md): schema changes and required coordination.
- [Approach comparison](docs/approach-comparison.md) and [reference implementations](docs/references.md): research history.

## Team coordination

Ownership, task status and handoffs are tracked in the team Notion workspace: [project home](https://app.notion.com/p/44ef1321420182e4acb781ba075ad9b0), [Project Brief](https://app.notion.com/p/40af1321420181d29d55cfb6d70b6eea), [Build Runbook](https://app.notion.com/p/40af132142018125ac46e0b80cda7ea9). See [AGENTS.md](AGENTS.md) for the full context map and when to consult it.

No license has been selected; source availability and distribution terms remain a team decision.
