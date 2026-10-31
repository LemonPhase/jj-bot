# Milestone 1 · Multi-bot vertical slice

Status: agreed initial product goal. Suggested delivery sequence below is a proposal, not assigned work.

## Required experience

Chat with a bot → create a task group chat → at least two bots contribute through separate execution sessions → inspect their activity → steer from the task chat → receive a consolidated, verified result.

Single-bot execution alone does not meet the milestone. The exact demo task, permitted tools, and sample inputs remain open.

## Acceptance checklist

- [ ] Frontend connects to a backend running locally or on a server.
- [ ] Persistent bots retain identity and deliberately scoped memory across tasks.
- [ ] Task creation records the goal, coordinator, participants, and verification plan.
- [ ] At least two bots do real work through separate sessions.
- [ ] Task messages are attributed and visible to all participants without activating every bot.
- [ ] A bot can communicate with another bot to align work and return results.
- [ ] Session execution includes evidence-backed verification and correction.
- [ ] Task interface exposes bots, delegated sessions, progress, and verification activity.
- [ ] User steering reaches the coordinator and changes relevant subsequent execution.
- [ ] Stop task cancels active sessions and prevents new launches.
- [ ] Coordinator verifies the integrated result and returns evidence and remaining gaps.
- [ ] The same routing paths support additional configured bots; no two-bot special case.
- [ ] Reload/reconnect reconstructs current task activity without repeating execution.

## Suggested build sequence

1. Agree contracts for identity, task membership, sessions, commands, and events.
2. Build durable task/session records and the runtime adapter.
3. Implement a coordinator and dynamic delegation to a configured participant list.
4. Connect task chat, selective activation, steering, and cancellation.
5. Render real session activity and evidence in the visualization.
6. Demonstrate failed verification followed by correction and integrated task verification.

## Smallest useful runtime spike

Before committing to a framework, prove that the chosen Gemini model can execute a tool, that two independently contextualized workers can report to a coordinator, that verification can loop on failure, and that stopping prevents further work. This is future implementation work; the repository now contains a runnable scaffold, but no live execution loop or durable task store.

## Boundaries

An arbitrary configurable team size means the domain and scheduler accept a variable participant list. It does not promise unlimited concurrent execution, budget, or quality. Test a third bot through the same route to catch a hard-coded pair while keeping the initial demo focused.

Defer native desktop packaging, external messaging channels, broad connector catalogues, and advanced memory retrieval unless the selected demo actually requires them. The final visualization layout is open.
