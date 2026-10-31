# Milestone 1 · Multi-bot vertical slice

The first demonstrable vertical slice. Single-bot execution alone does not satisfy it.

## Required experience

Chat with a bot → create a task group chat → at least two bots contribute through separate execution sessions → inspect their activity → steer from the task chat → receive a consolidated, verified result.

## Acceptance criteria

The milestone is met only when all of the following are demonstrable together in one flow:

- A frontend reaches a backend running locally or on a server.
- Persistent bots retain identity and deliberately scoped memory across tasks.
- Task creation records the goal, coordinator, participants and verification plan.
- At least two bots do real work through separate execution sessions.
- Task messages are attributed and visible to all participants without activating every bot.
- A bot can communicate with another bot to align work and return results.
- Session execution includes evidence-backed verification and correction.
- The task interface exposes bots, delegated sessions, progress and verification activity.
- User steering reaches the coordinator and changes relevant subsequent execution.
- Stopping a task cancels active sessions and prevents new launches.
- The coordinator verifies the integrated result and reports evidence and remaining gaps.
- The same routing paths serve additional configured bots; there is no two-bot special case.
- Reload or reconnect reconstructs current task activity without repeating execution.

The demo task, permitted tools and sample inputs remain to be chosen. The flow must be driven through the product surface, not through scripts alone.

## Boundaries

An arbitrary configurable team size means the domain and scheduler accept a variable participant list. It does not promise unlimited concurrent execution, budget, or quality. Exercise a third bot through the same route to catch a hard-coded pair while keeping the demo focused.

Defer native desktop packaging, external messaging channels, broad connector catalogues and advanced memory retrieval unless the demo requires them. The final visualization layout is open.
