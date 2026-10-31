# Contract changelog

Every change to `packages/contracts` is recorded here, newest first. The shared schemas are
the frontend/backend boundary: a change that is not written down is a change the other side
cannot plan around.

Live ownership, status and acceptance checks stay in
[01 · Maintain shared contracts and integration fixtures](https://app.notion.com/p/40af13214201818c98dcdf487628d1e4).
This file is the implementation record; Notion is the coordination record.

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

A `breaking` entry needs agreement from both sides first. Raise it as a Decision in Notion
rather than landing it and announcing it afterwards.

## 0.2.0 — 2026-10-31 — Frontend command boundary and task read model

**Changed by:** frontend (task 05) · **Compatibility:** additive

Nothing existing changed shape. New exports from `@jj/contracts`:

- `createTaskCommandSchema`: `goal`, `coordinatorBotId`, `participantBotIds`, `verificationPlan`.
  Rejects a coordinator who is not a participant, and an empty verification plan — a task cannot
  be created without one.
- `postTaskMessageCommandSchema`: `taskId`, `text`, `activateBotIds`. An empty `activateBotIds`
  shares the message with every participant and activates nobody. Posting is not permission to execute.
- `steerTaskCommandSchema`: `taskId`, `text`, `observedGoalVersion`, optional `replacementGoal`.
  `observedGoalVersion` is the version the user was looking at, so the backend can reject stale
  steering instead of applying it to a goal that already moved. Only steering may bump the goal version.
- `stopTaskCommandSchema`: `taskId`, `reason`.
- `taskViewSchema`: `task`, `participants`, `messages`, `sessions`, `verificationResults`, `events`,
  `replayCursor`. One read model behind both the task chat (05) and the collaboration view (06) so
  the two cannot disagree. `replayCursor` is the highest event sequence included, for resuming a
  stream after reload.

**Endpoints the frontend already calls** (they 404 today; the UI shows the error rather than
simulating success):

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/api/tasks/:taskId/messages` | `postTaskMessageCommandSchema` |
| `POST` | `/api/tasks/:taskId/steer` | `steerTaskCommandSchema` |
| `POST` | `/api/tasks/:taskId/stop` | `stopTaskCommandSchema` |

A read endpoint returning `taskViewSchema` is still needed; path not yet agreed. Proposal:
`GET /api/tasks/:taskId/view`. Say if you would rather shape it differently — it is unimplemented
on both sides, so it is cheap to change now.

**Action required (frontend):** none — `apps/web` is built against these today, using labeled
development fixtures in `apps/web/src/fixtures.ts` until the endpoints exist.
**Action required (backend):** implement the three command endpoints and a task-view read endpoint
against these schemas. Validate with the exported schemas rather than re-deriving the shapes. If
any shape does not suit persistence or the coordinator, change it here and say so — do not quietly
accept a different body.

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
- `bootstrapSchema`: scaffold-mode capability report consumed by `GET /api/bootstrap`.

**Known gaps, still to agree:** task creation and steering/stop command payloads, session result
handoffs, the replay cursor for reconnect, and bot/task list endpoint shapes.

**Action required (frontend):** none — this is what `apps/web` reads today.
**Action required (backend):** none — extend rather than redefine; record each extension above.
