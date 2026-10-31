# Task continuation and goal versioning

A task is one durable timeline. Work continues in the same task after its first result, and the task's **goal version changes if and only if its goal or acceptance criteria change**. That rule keeps verification honest: evidence is always valid for exactly one version.

## Every user message steers

Every user message in a task is steering to the coordinator, posted with `POST /api/tasks/:id/messages`. There is no separate continue or steer endpoint. The message activates the coordinator only; it never re-enqueues the whole roster, and the coordinator decides whom to involve.

Posting to a `waiting`, `completed` or `failed` task continues it. The server emits `task.reopened` with the previous status, and the task record returns to `running` with its result, error and finish time cleared (`task.updated`). The coordinator resumes from its transcript with the new message in context.

## Terminal tasks

- **`cancelled`** is terminal. Posting answers `409 TASK_TERMINAL`; resuming the work requires a new task.
- **Stopping** is terminal too. Once stop is requested, `cancelRequestedAt` is set and new messages answer `409 TASK_TERMINAL` while the task stops.

## Goal versions

A message may replace the goal. It must carry `observedGoalVersion`, the version the user was looking at. If that is not the current version, the API answers `409 STALE_GOAL_VERSION` and changes nothing.

A goal change increments `goalVersion` and emits `task.goal_changed` with the new goal and version, so the event log is the task's version history. A message that does not change the goal leaves the version, and the evidence gathered under it, untouched. Work at an older version cannot complete the task.

## Guardrails

- **Cap the version count** (default 20). A further goal change answers `409 GOAL_VERSION_BUDGET`. Without a cap a task can grow without bound, and every version costs model calls.
- **Never mix evidence across versions.** Results and checks carry the goal version they were produced at, and the consolidated result uses only work at the current version.

## Non-goals

Branching or forking a task into parallel attempts. If that becomes necessary, it belongs in a separate design with explicit lineage rather than overloading continuation.
