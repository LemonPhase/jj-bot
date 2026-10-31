# Task continuation and goal versioning

Status: accepted product decision. The contract delta at the end is proposed and must be coordinated before either side builds against it.

A task is one durable timeline. Work can continue after the first result, but the task's **goal version changes if and only if its acceptance criteria change**. That rule keeps verification honest: evidence is always valid for exactly one version.

## What a version records

Every goal version records the goal and the criteria it is judged against:

| Field              | Meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `version`          | Positive integer, starts at 1, increments on scope change       |
| `goal`             | The goal text in force for this version                         |
| `verificationPlan` | Acceptance criteria in force for this version                   |
| `checks`           | Executable check definitions for this version, if any           |
| `reason`           | Why the version was created (`created`, `steered`, `continued`) |
| `authorId`         | Who or what caused it                                           |
| `createdAt`        | When it came into force                                         |

Sessions and check results already carry `goalVersion`, so they attach to the correct revision without change. The task record must retain the full version history rather than overwriting `goal`, because "what were we asked to do in version 2" is otherwise unrecoverable.

## Operations

| User intent                          | Operation                          | Goal version | Prior evidence |
| ------------------------------------ | ---------------------------------- | ------------ | -------------- |
| Do more work under the same criteria | `POST /api/tasks/:id/continue`     | unchanged    | still valid    |
| Extend or change the scope           | `POST /api/tasks/:id/steer`        | increments   | superseded     |
| Add another participant              | `POST /api/tasks/:id/participants` | unchanged    | still valid    |
| Retry after a failure                | `steer` or a new session           | unchanged    | still valid    |

`continue` posts an attributed message and enqueues sessions only for the bots explicitly named in `activateBotIds`. It never re-enqueues the whole roster; continuation must be as cheap as the user expects.

## Terminal states

- **`completed`** — continuable by explicit action only. Reopening emits `task.reopened` carrying the previous status and whether the version changed.
- **`waiting`**, **`failed`** — already continuable through steering or a new session.
- **`cancelled`** — terminal. Cancellation is a deliberate user decision; resuming requires a new task.

Implicit reopening is removed. `spawnSession`, `postMessage` with `activateBotIds`, and `addParticipant` with activation must reject a terminal task with `409 TASK_TERMINAL`. A caller that means to reopen says so.

## Guardrails

- **Cap the version count** (default 20) and reject further scope changes with `409 GOAL_VERSION_BUDGET`. Without it, a task can grow without bound and every version costs model calls.
- **Count only live sessions against the session budget.** Superseded sessions must not accumulate into a permanent block on steering.
- **Keep cancellation semantics.** A version bump cancels work at the old version; it never rewrites history.
- **Never mix evidence across versions.** Synthesis reads only results at the current version; checks record the version they were evaluated against.

## Rendering

The task view exposes the version history so a client can draw the timeline and mark earlier checks as superseded. Existing events already carry enough attribution (`goalVersion` on session start and checks); the version boundaries come from the history itself.

## Proposed contract delta (target `0.5.0`)

Compatibility: additive schemas, one breaking behavior change (implicit reopen removed). Under 0.x conventions that is a minor bump; if the changelog's literal "major for breaking" rule is preferred, call it `1.0.0` instead. Either way, frontend and backend must agree before landing.

| Area             | Change                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Command          | Add `continueTaskCommandSchema` (`text`, `authorId?`, `activateBotIds` required, non-empty) |
| Task record      | Add `goalHistory: GoalRevision[]`, appended on creation and every scope change              |
| Task view        | Expose `goalHistory` through `taskViewSchema`                                               |
| Event enum       | Add `task.reopened`, `goal.changed`, `coordinator.transferred`, `participant.added`         |
| HTTP             | Add `POST /api/tasks/:id/continue`; terminal-task guards return `409 TASK_TERMINAL`         |
| Backend behavior | Version bump only when `goal`, `verificationPlan`, or `checks` change                       |

`coordinator.transferred` also fixes an existing defect: coordinator changes currently emit `message.posted` and are indistinguishable from chat messages. `participant.added` closes a gap where membership changes emit no event at all.

## Migration

Tasks created before this change have no history. On first read, synthesize a single revision from the stored goal/plan at the current version and persist it; do not invent intermediate versions. Existing sessions and checks already carry the version they belong to.

## Non-goals

Branching or forking a task into parallel attempts. If that becomes necessary, it belongs in a separate design with explicit lineage rather than overloading continuation.
