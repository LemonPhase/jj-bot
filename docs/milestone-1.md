# Milestone 1 · MVP

A self-hostable product that someone can install and use for real multi-bot work. Single-bot execution does not satisfy it: multi-bot tasks are the product.

## Required experience

Start the stack with one command → configure a model and a runtime profile → create several bots → start a task with a goal and a roster → the coordinator delegates, and at least two bots do real command and file work in sandboxes, in parallel → watch the group chat and execution graph live → steer or stop → receive the consolidated result and its files.

## Acceptance criteria

The milestone is met only when all of these are demonstrable together, through the product surface rather than scripts:

- The stack runs from the repository with one compose command and no hosted dependency besides a model provider.
- Bots persist identity, instructions, model choice, runtime profile and scoped memory across tasks.
- Runtime profiles are created and edited in settings and select a sandbox driver; both `local` and `docker` work.
- Task creation records goal, coordinator and participants.
- At least two bots do real work in separate sessions, running in parallel inside sandboxes.
- Sessions of one task can share files through the task workspace.
- Task messages are attributed and visible to all participants without activating every bot.
- The coordinator delegates bounded work and receives the results back.
- Each working bot shows its current activity live, and the execution graph shows bots, assignments, commands and results.
- Steering reaches the coordinator and changes subsequent execution.
- Stop cancels active sessions, prevents new launches and records what actually stopped.
- Files a session produces can be downloaded as artifacts.
- After a server restart, in-flight work resumes or fails visibly; completed work is never silently repeated.
- Reload or reconnect reconstructs task activity without re-running anything.
- With the `docker` driver, agent-run code cannot read model keys, the host filesystem or the host environment. The `local` driver does not pass the server's environment into commands but hides nothing from them, so the product labels it unisolated.
- A third bot routes through the same paths, with no two-bot special case.

## Boundaries

A configurable team size means the domain and scheduler accept any participant list. It does not promise unlimited concurrency, budget or quality.

Out of scope for this milestone: verification plans, multi-user accounts, remote sandbox drivers, messaging channels, scheduled or triggered tasks, Git hosting integration and retrieval-based memory. The API rejects a task that carries a verification plan rather than accepting one it cannot enforce. The demo task and final visualization layout remain open.
