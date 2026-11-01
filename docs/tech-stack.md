# Technology stack

The accepted stack and the constraint each layer must respect. See [Architecture](architecture.md) for the boundaries these serve.

| Layer         | Choice                                                                                             | Constraint                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Agent runtime | `@earendil-works/pi-agent-core` and `pi-coding-agent`                                              | Reached only through the engine's ports. Pin exact versions. JJ Bot owns durability and identity. |
| Models        | `@earendil-works/pi-ai` provider registry                                                          | Server-side keys only. Per-bot `provider/model` choice.                                           |
| Sandbox       | `@jj/sandbox`: `local` and `docker` in tree; remote drivers, such as Daytona, on the same contract | Every driver passes the conformance suite and declares its capabilities.                          |
| API           | Hono on a long-running Node service                                                                | Validates every command against the shared contracts.                                             |
| Streaming     | Server-sent events over the task event log                                                         | One contract for every client. Resume from `Last-Event-ID`; replay never re-runs work.            |
| Storage       | PostgreSQL with Drizzle; embedded PGlite for single-process development                            | Transactional writes. Events persisted before they are published.                                 |
| Contracts     | Zod schemas in `packages/contracts`                                                                | Versioned; every change gets a [changelog](contract-changelog.md) entry.                          |
| Frontend      | React, TypeScript and Vite                                                                         | Renders server state; never fabricates execution or runs agent loops.                             |
| Tooling       | npm workspaces, TypeScript, Biome, Vitest                                                          | `npm run verify` (alias `check`), which CI runs, is the merge gate.                               |

## Why pi

pi provides the parts of an agent runtime this project would otherwise build: a low-level agent loop that runs over a transcript the caller owns, steering at turn boundaries, provider error classification and one model registry across many providers. JJ Bot offers the pi providers that authenticate with a single API key variable (`GET /api/models` lists them with their variables) and never lets pi read host credential files. It uses pi's `ls` tool on sandbox-backed operations and its own versions of the other coding tools, and loads no pi session files, settings, context files or extensions; see the [runtime README](../packages/runtime/README.md). Rakazo runs its subagents on pi as well. The maintained packages are published under `@earendil-works`; the earlier `@mariozechner` scope is deprecated.

pi is a fast-moving dependency. Keep it behind JJ Bot's own interfaces, pin exact versions, and upgrade deliberately.

## Not used

No other agent framework or protocol runs alongside pi: Google ADK, LangGraph and Mastra are not used, providers are reached only through pi-ai, and the native task event stream is the only client protocol.

## Integration checks

A working integration is defined by these observations, in order:

1. A real tool cycle runs inside a sandbox with no browser attached.
2. With a filesystem-isolating driver such as `docker`, agent-run code cannot read model keys or the host environment.
3. Two bots execute in separate sessions under one task, in parallel.
4. A notification does not wake every bot.
5. Steering changes subsequent execution and invalidates stale evidence.
6. Stop prevents new launches and records what actually stopped.
7. Event replay reconstructs activity without repeating work.
8. A third bot routes through the same paths with no special case.
9. Where the server reports the `verification` capability, a task with a verification plan cannot complete with a failed or inconclusive check; without it, a plan is refused.

Sources: [pi](https://github.com/earendil-works/pi), [pi coding agent on npm](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), [Daytona SDK](https://www.daytona.io/docs), [reference implementations](references.md).
