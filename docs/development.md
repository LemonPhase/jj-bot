# Development setup

## Prerequisites and start

Use Node.js 24 (minimum 22.12) and npm. From the repository root:

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173. API: http://127.0.0.1:3001. The worker starts in idle scaffold mode. Stop all three with Ctrl+C. No model key or database is needed to start the scaffold. Never commit `.env`.

`npm run dev -w @jj/web`, `npm run dev -w @jj/api` and `npm run dev -w @jj/worker` start individual processes. The web dev server proxies `/api` and `/health` to port 3001; update `apps/web/vite.config.ts` if you change API_PORT. API_HOST defaults to loopback. AGENT_URL is a server-side endpoint override, not a user-provided URL.

## Workspace ownership

| Directory            | Responsibility                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/web`           | React/Vite shell, CopilotKit provider, API connection/error states; future bot/task chat and visualization |
| `apps/api`           | Hono service, bootstrap/health, CopilotKit OSS runtime and AG-UI endpoint boundary                         |
| `apps/worker`        | Long-running process entry; no job scheduler yet                                                           |
| `packages/contracts` | Zod schemas/types for bots, tasks, sessions, messages, evidence and attributed events                      |
| `packages/runtime`   | Direct Google SDK factory and SessionExecutor interface; no execution loop yet                             |
| `packages/db`        | PostgreSQL/Drizzle client factory; no schema/migrations yet                                                |

Internal packages export TypeScript source. API/worker run with `tsx`; the initial `build` typechecks all packages and produces the web bundle. Production service bundling, authentication and deployment are follow-up work, not completed by this scaffold.

## Configuration

- `API_HOST`, `API_PORT`: local API listener.
- `AGENT_URL`: custom execution endpoint registered with CopilotKit.
- `DATABASE_URL`: used by `createDatabase` once persistence is implemented.
- `GEMINI_API_KEY`, `GEMINI_MODEL`: server-only provider configuration. Set the exact event-supported model after validating access. The scaffold never calls Gemini; populated variables alone do not enable execution.

Optional database: `docker compose up -d postgres`. Stop with `docker compose stop`. It keeps data in a named volume. This only starts PostgreSQL; no migration is present and the API does not use it yet. Docker startup was not part of scaffold validation.

## Checks and contribution standard

```sh
npm run check       # lint + tests + all-package typecheck + web build
npm run format      # format and safe lint/import fixes
npm run test
npm run typecheck
```

CI runs `npm ci`, lint and tests on Node 24. For the current fast iteration, lint/tests are the required baseline; typecheck and build remain available when relevant. Read [CONTRIBUTING.md](../CONTRIBUTING.md) for the required development verification loop and [AGENTS.md](../AGENTS.md) for mandatory Notion access/sync. The small scaffold test set checks domain invariants and honest capability reporting; it does not establish live-agent correctness.

## Endpoint boundaries

- `GET /health`: process health, not database/model readiness.
- `GET /api/bootstrap`: explicit scaffold capabilities and empty bot/task collections; runtime schema validated.
- `/api/copilotkit/*`: actual OSS AG-UI runtime route; `GET /api/copilotkit/info` discovers agent `jj`.
- `POST /api/agent`: explicit AG-UI `RUN_ERROR` with `SCAFFOLD_NOT_IMPLEMENTED`. No fabricated answer or model call.

CopilotKit's default OSS runner is transient integration plumbing. It is not our durable task store or future worker queue. Task creation, jobs, execution, verification loops, steering/stop, durable events and reconnect/replay remain to implement. UI empty states say so. No auth is present; keep development services on loopback. The starter is not ready for public deployment.

## Known setup findings

- AG-UI client/core are pinned to 1.0.2 to match CopilotKit 1.83.0. Mixing its pinned client with a direct 1.0.3 client caused incompatible private class types; do not bypass this with casts.
- Initial dependency audit reports 34 findings (6 low, 6 moderate, 22 high), including inherited Zod 3 and provider/rendering dependencies. `npm audit fix` without force did not resolve the set. A dependency-review task tracks this; do not apply breaking blanket overrides or claim a clean audit. Review reachability and compatible patched upstream releases before external deployment.
- The CopilotKit provider currently produces large rendering-related frontend chunks. Build succeeds with size warnings; isolate/lazy-load or narrow imports as part of frontend integration, without suppressing the warning to claim optimization.
- The developer machine's default npm cache had root-owned entries. A separate cache (`npm ci --cache /tmp/jj-bot-npm-cache`) avoided changing global permissions; ordinary `npm ci` works on a normal writable cache.

## Next work

See [workstreams](workstreams.md) and the linked Notion tasks. Agree contracts first; persistence, model access and UI work can then proceed with clear boundaries. Live runtime/coordination work must converge into the real multi-bot verification milestone.
