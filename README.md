# JJ Bot · Halloween Hackathon

A team project for Track 1: Frontier Agents with Gemini at Halloween At Imperial: Gemini Edition.

**Status: runnable scaffold.** Option B is selected: our own application infrastructure with CopilotKit OSS/AG-UI and direct Google GenAI SDK integration. The starter UI, API and idle worker run locally; autonomous execution and persistence are not implemented yet.

## Run locally

Use Node.js 24 and npm:

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173. No model key/database is required for scaffold mode. Run `npm run check` for lint, tests, typecheck and web build. See [development setup](docs/development.md), [contribution standard](CONTRIBUTING.md), and [workstreams](docs/workstreams.md).

Repository: [LemonPhase/jj-bot](https://github.com/LemonPhase/jj-bot).

JJ Bot runs persistent bot personas with memory above goal-oriented tasks. Bots and tasks have a many-to-many relationship; each task has a coordinator and a shared group chat, and may use several execution sessions or subagents. Messages are visible to all participating bots without automatically triggering every bot. Users can steer through the coordinator or stop the task's active sessions. The backend can run locally or on a server.

The first milestone is multi-bot end to end: create a task from bot chat, execute work in separate sessions for at least two bots, visualize activity, accept user steering, and return a consolidated result. The design must support an arbitrary configurable number of bots rather than hard-coding two; practical concurrency is resource-limited.

Tasks and execution sessions must define verification criteria before work and run an execute–verify–revise loop, with evidence for session results and integrated task completion. Consult the live Notion Project Brief for current scope and implementation decisions.

## Initial documentation

- [Product specification](docs/product-spec.md): agreed bot/task/session concepts and behavior.
- [Architecture proposal](docs/architecture.md): runtime boundaries, data model, routing, and event flow.
- [Verification contract](docs/verification.md): task/session checks, evidence, and completion rules.
- [Milestone 1](docs/milestone-1.md): the first multi-bot vertical slice and acceptance checklist.
- [Technology stack proposal](docs/tech-stack.md): recommendation, alternatives, and primary sources.
- [Implementation approach comparison](docs/approach-comparison.md): OpenBot, CopilotKit OSS, custom development, and other existing applications.
- [Reference implementations](docs/references.md): Rakazo, OpenMausBot, and CopilotKit OpenBot.

No license has been selected yet; source availability and distribution terms remain a team decision.

## Shared project context

Most technical, architectural, and contract context lives in the `docs/` directory and `packages/contracts` so agents and developers can work local-first. When coordinating team ownership, checking live task/handoff state, or recording cross-team decisions, look up the relevant page on demand from [Hackathon HQ in Notion](https://app.notion.com/p/44ef1321420182e4acb781ba075ad9b0):

- [00 · Idea Brainstorm](https://app.notion.com/p/40af13214201814abd85c00a6b20dd31): candidate ideas and comparisons.
- [01 · Project Brief](https://app.notion.com/p/40af1321420181d29d55cfb6d70b6eea): agreed direction, scope, and success criteria.
- [02 · Build Runbook](https://app.notion.com/p/40af132142018125ac46e0b80cda7ea9): setup, architecture, commands, and known issues.
- [03 · Agent Start & Handoff](https://app.notion.com/p/40af13214201812d9cfae40de515812d): collaboration workflow and continuation context.

See [AGENTS.md](AGENTS.md) for the full Notion context map (including direct task URLs) and guidelines on when to look up or curate Notion.
