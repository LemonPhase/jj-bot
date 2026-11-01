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
- Task messages are attributed and shared in one task chat, and posting one does not activate every bot.
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

Out of scope for this milestone: verification plans, multi-user accounts, remote sandbox drivers, messaging channels, scheduled or triggered tasks, Git hosting integration and retrieval-based memory. The API rejects a task that carries a verification plan rather than accepting one it cannot enforce.

## Demo task

The acceptance run uses this task through the product surface. It exercises every criterion above with three bots and needs nothing but the Node.js standard library, so it runs in a `docker` sandbox with network mode `none`.

**Goal:** Build `wordfreq`, a small Node.js command-line tool that prints the N most frequent words in a text file, with tests and a README. Use only the Node.js standard library.

| Bot     | Role          | Instructions                                                                                                                                              |
| ------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lead    | Tech lead     | Coordinates. Agrees the interface first, splits the work into files no two bots edit, delegates, reviews results, runs the tests and reports the outcome. |
| Builder | Implementer   | Writes `wordfreq.js`: an exported `topWords(text, n)` function and a CLI (`node wordfreq.js <file> [n]`).                                                 |
| Tester  | Test engineer | Writes `wordfreq.test.js` with `node:test` against the agreed interface, plus a `sample.txt` fixture.                                                     |

Lead is the coordinator and all three are participants. Lead's runtime profile, which the task's sandbox uses, is a docker profile with network `none` (the seeded Docker sandbox profile has `open`, so edit it or create one).

Expected run:

1. Lead delegates to Builder and Tester, who work in parallel in separate sessions and share files through the task workspace.
2. Each working bot's activity line shows its commands and file edits; the execution graph shows Lead's two assignments.
3. Lead reacts to each result, runs `node --test` and completes the task with a consolidated result.
4. `wordfreq.js`, `wordfreq.test.js`, `sample.txt` and `README.md` are downloadable as artifacts.

Steering, stop and recovery are checked on the same task: a mid-run message asking for a `--min-length` option changes what Lead delegates next; a second run is stopped while bots are working; and a server restart during a third run resumes or fails visibly without repeating completed commands.
