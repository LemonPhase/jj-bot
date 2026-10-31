# Contract changelog

Every change to `packages/contracts` is recorded here, newest first. The shared schemas are
the frontend/backend boundary: a change that is not written down is a change the other side
cannot plan around.

Live ownership, status and acceptance checks stay in the GitHub issue for each contract change.
This file is the implementation record; issues are the coordination record.

## How to record a change

Add an entry before merging the schema change, using the template below.

- **Version** — the `CONTRACT_VERSION` value in `packages/contracts/src/index.ts` after the change.
  Bump the patch for clarifications, the minor for additive changes, the major for breaking ones.
- **Compatibility** — `additive` (older consumers keep working), `breaking` (the other side must
  change before integrating), or `clarifying` (no wire change).
- **Action required** — what the other team has to do, or "none".

```md
## <version> — <YYYY-MM-DD> — <short title>

**Changed by:** <side> · **Compatibility:** <additive | breaking | clarifying>

- `<schemaName>`: what changed and why.

**Action required (frontend):** …
**Action required (backend):** …
```

A `breaking` entry needs agreement from both sides first. Raise it as a `decision` issue
rather than landing it and announcing it afterwards.

## 0.4.0 — 2026-10-31 — Bot turn routing

**Changed by:** backend · **Compatibility:** additive

- `botTurnCommandSchema` (`BotTurnCommand`): `text`, 1–20000 characters.
- `botTurnResultSchema` (`BotTurnResult`): `kind` (`reply` | `task` | `routed`) plus the affected `task` when one exists. A direct message is no longer assumed to start a task.
- `ConversationMessage` records gain an optional monotonic `sequence` so same-millisecond messages keep their order.

| Method | Path                 | Body                   |
| ------ | -------------------- | ---------------------- |
| `POST` | `/api/bots/:id/turn` | `botTurnCommandSchema` |

**Action required (frontend):** send bot-chat messages to `/api/bots/:id/turn` instead of
`/api/bots/:id/messages`, then refetch the conversation; a follow-up may attach to an existing
task rather than creating one. `/api/bots/:id/messages` remains available for explicit task
creation.
**Action required (backend):** none beyond this release.

## 0.3.0 — 2026-10-31 — Bot creation command and backend orchestration boundary

**Changed by:** frontend (task 05) & backend (tasks 02, 03, 04, 07) · **Compatibility:** additive

- `createBotCommandSchema` (`CreateBotCommand`): `name`, `instructions`, both required and non-empty.
- `taskSchema` & `executionSessionSchema`: added optional output metadata (`result`, `cancelReason`, `cancelledAt`, `createdAt`, `updatedAt`, `kind`, `error`, `runId`, `attempts`) so `taskViewSchema` and `bootstrapSchema` preserve completed synthesis/session results.
- `taskEventSchema`: added `model.started`, `model.finished`, `verification.started`, and `session.revising` event types for session-level verification and bounded revision loops.
- `checkDefinitionSchema`: executable check specification (`contains`, `regex`, `json`, `model`).

| Method | Path         | Body                      |
| ------ | ------------ | ------------------------- |
| `POST` | `/api/bots`  | `createBotCommandSchema`  |
| `POST` | `/api/tasks` | `createTaskCommandSchema` |

**Action required (frontend):** none.
**Action required (backend):** implemented in `@jj/api` and `@jj/backend`.

## 0.2.0 — 2026-10-31 — Frontend command boundary and task read model

**Changed by:** frontend (task 05) & backend (task 04) · **Compatibility:** additive

Nothing existing changed shape. New exports from `@jj/contracts`:

- `createTaskCommandSchema`: `goal`, `coordinatorBotId`, `participantBotIds`, `verificationPlan` (plus optional `checks`, `autoStart`).
  Rejects a coordinator who is not a participant, and an empty verification plan — a task cannot
  be created without one.
- `postTaskMessageCommandSchema`: `taskId` (optional in body when sent via URL), `text`, `activateBotIds`. An empty `activateBotIds`
  shares the message with every participant and activates nobody. Posting is not permission to execute.
- `steerTaskCommandSchema`: `taskId` (optional in body), `text`, `observedGoalVersion`, optional `replacementGoal` / `goal`.
  `observedGoalVersion` is the version the user was looking at, so the backend rejects stale
  steering (`409 STALE_GOAL_VERSION`) instead of applying it to a goal that already moved. Only steering may bump the goal version.
- `stopTaskCommandSchema`: `taskId` (optional in body), `reason`.
- `taskViewSchema`: `task`, `participants` (and `bots`), `messages`, `sessions`, `verificationResults` (and `checks`), `events`,
  `replayCursor`. One read model behind both the task chat (05) and the collaboration view (06) so
  the two cannot disagree. `replayCursor` is the highest event sequence included, for resuming a
  stream after reload.

| Method | Path                          | Body                           |
| ------ | ----------------------------- | ------------------------------ |
| `GET`  | `/api/tasks/:taskId`          | returns `taskViewSchema`       |
| `GET`  | `/api/tasks/:taskId/view`     | returns `taskViewSchema`       |
| `POST` | `/api/tasks/:taskId/messages` | `postTaskMessageCommandSchema` |
| `POST` | `/api/tasks/:taskId/steer`    | `steerTaskCommandSchema`       |
| `POST` | `/api/tasks/:taskId/stop`     | `stopTaskCommandSchema`        |

**Action required (frontend):** none.
**Action required (backend):** implemented in `@jj/api` and `@jj/backend`.

## 0.1.0 — 2026-10-31 — Scaffold baseline

**Changed by:** scaffold ([145e61f](https://github.com/LemonPhase/jj-bot/commit/145e61f)) · **Compatibility:** baseline

Starting point for both sides, not a finished protocol. Exported from `@jj/contracts`:

- `botSchema`: `id`, `name`, `instructions`.
- `taskSchema`: `id`, `goal`, `goalVersion`, `coordinatorBotId`, `participantBotIds`,
  `verificationPlan`, `status`. The coordinator must appear in the participant list and
  participants must be unique; the verification plan must be non-empty.
- `executionSessionSchema`: `id`, `taskId`, `botId`, optional `parentSessionId`, `goalVersion`,
  `brief`, `verificationPlan`, `status`.
- `taskMessageSchema`: `id`, `taskId`, `authorId`, `authorKind`, `text`, `intent`,
  `activateBotIds`. Shared visibility is independent of `activateBotIds`.
- `taskEventSchema`: `id`, `taskId`, `sequence`, optional `botId`/`sessionId`/`runId`/
  `causedByEventId`, `occurredAt`, `type`, `payload`.
- `verificationResultSchema`: `criterionId`, `taskId`, optional `sessionId`, `goalVersion`,
  `outcome`, `evidence`. A `passed` outcome requires at least one evidence entry.
- `bootstrapSchema`: capability report consumed by `GET /api/bootstrap`.
