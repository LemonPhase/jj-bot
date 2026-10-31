# Contract changelog

Every change to `packages/contracts` is recorded here, newest first. The shared schemas are
the frontend/backend boundary: a change that is not written down is a change the other side
cannot plan around.

Live ownership, status and acceptance checks stay in the GitHub issue for each contract change.
This file is the implementation record; issues are the coordination record.

## How to record a change

Add an entry before merging the schema change, using the template below.

- **Version** — the `CONTRACT_VERSION` value in `packages/contracts/src/common.ts` after the change.
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

## 1.0.0 — 2026-10-31 — Revamp contracts

**Changed by:** backend & frontend ([#11](https://github.com/LemonPhase/jj-bot/issues/11)) · **Compatibility:** breaking

`@jj/contracts` is rewritten for the pi runtime revamp as modules `common`, `bots`, `profiles`,
`tasks`, `events` and `api`, all exported from `@jj/contracts`. The 0.x schemas move unchanged
to `@jj/contracts/legacy` and `@jj/contracts/legacy/backend` for the code that still uses them.
The sandbox spec is re-exported from `@jj/sandbox/contract`, never redefined. Where a refinement
would make `.pick`, `.omit` or `.partial` throw, the unrefined `*ObjectSchema` is exported too.

Commands keep their input limits (text 1–20000 characters); records accept what the engine
produces, up to `RECORD_TEXT_LIMIT` (200000), and an empty final turn is stored as `(no text)`.

- `botSchema`: adds `role`, `model` (`provider/model`, or null for the server default),
  `runtimeProfileId`, `appearance`, and server-derived `presence` and `activeTaskIds`;
  `instructions` may be empty. `createBotCommandSchema` requires only `name`; new
  `updateBotCommandSchema` (at least one field), `botMemorySchema`, `updateBotMemoryCommandSchema`,
  `conversationMessageSchema` (`taskId` nullable), `conversationViewSchema` (`replying`,
  `lastReplyError`, cleared when a reply succeeds) and `sendBotMessageCommandSchema`.
  `botAppearanceSchema` with exported value lists and `defaultAppearanceFor(seed)`.
- `botTurnCommandSchema` and `botTurnResultSchema` are removed: a direct message is stored and the
  reply arrives asynchronously, linking any task it created or forwarded to.
- New runtime profile, driver and model shapes: `runtimeProfileSchema` (sandbox spec, coding
  tools, budgets, and a computed `status` whose `isolated` is the driver's filesystem isolation),
  `createRuntimeProfileCommandSchema`, `updateRuntimeProfileCommandSchema`,
  `sandboxDriverInfoSchema` (capabilities and `specJsonSchema`), `modelInfoSchema`,
  `providerInfoSchema` and `modelsViewSchema`. The update command has no defaults
  (`sandboxSpecPatchSchema`, partial budgets): the server deep-merges it onto the stored profile
  (`tools`, `sandbox.network`, `sandbox.env` and `sandbox.driverConfig` are replaced whole) and
  validates the merged spec with the driver.
- `taskSchema`: adds `title`, `error`, `cancelRequestedAt` and `finishedAt`; `result` and
  `cancelReason` are nullable; `verificationPlan` and `cancelledAt` are removed. `waiting` now
  means the coordinator ended its turn without `complete_task`, and `completed` means it called
  `complete_task`. Once `cancelRequestedAt` is set, new messages answer `409 TASK_TERMINAL` and
  clients show "Stopping…".
- `executionSessionSchema`: there is no assignment record. A delegation is a child session with
  `parentSessionId`, `role`, `brief`, `depth` and `result`. Adds `waitingFor` (`delegations` |
  `user` | null), `activity`, `runCount`, `startedAt` and `finishedAt`; removes the `verifying`
  status, `kind`, `attempts`, `runId` and the per-session `verificationPlan`. A waiting session
  ended its turn and resumes when the input named by `waitingFor` arrives.
- `taskMessageSchema`: `authorId` becomes `authorBotId` (null for user and system messages),
  `activateBotIds` becomes `recipientBotIds`; adds `sequence` and `sessionId`.
- New `artifactSchema`, `usageSchema`, `activitySchema` and `taskSummarySchema`.
- `createTaskCommandSchema` adds the coordinator to the participants when missing; the
  verification plan is optional and `checks` and `autoStart` are removed. A present plan is
  rejected with `VERIFICATION_UNAVAILABLE` while `capabilities.verification` is false.
- `postTaskMessageCommandSchema` replaces `steerTaskCommandSchema` (removed): every user message
  steers the coordinator, and changing `goal` requires `observedGoalVersion`. Posting to a waiting,
  completed or failed task continues it; there is no continue endpoint. See
  [task continuation](task-continuation.md). `stopTaskCommandSchema` keeps only `reason`; a blank
  reason counts as none.
- `taskEventSchema` is a discriminated union with a typed payload per type (`TASK_EVENT_TYPES`).
  `botId`, `sessionId` and `runId` are nullable and `causedByEventId` becomes `causedBy`. Events
  that change a record carry the whole record: `task.created` and `task.updated` (`task`,
  `previousStatus`), `session.created` and `session.updated` (`session`, `previousStatus`; any
  session change except activity), `message.posted` and `artifact.created`.
  `task.goal_changed`, `task.reopened` and `task.finished` are markers. `session.started`,
  `session.finished`, `session.revising` and `verification.*` are removed; `run.*`, `model.*`,
  `tool.*`, `steering.received` and `cancellation.*` are new or retyped.
  `TOOL_OUTPUT_PREVIEW_LIMIT` (64 KiB) bounds `tool.finished.output`; the server clamps
  `JJ_OUTPUT_CAP_BYTES` to it.
- Clients ignore unknown event types: `unknownTaskEventSchema` and `parseTaskEvent` accept them
  (marked `unknown: true`), and view and page parsing drops them, while a known type with a
  malformed payload still fails.
- Pure helpers: `activityFromEvent` derives each session's activity line, and `applyTaskEvent`
  folds an event onto a task view so that the view at n plus events n+1..m equals the view at m.
- `taskViewSchema`: `{ task, sessions, messages, artifacts, usage, events, firstSequence,
  hasEarlier, cursor }`. `events` holds at most the latest 500 events, without `tool.finished`
  output previews. `replayCursor` becomes `cursor`; the bot, participant and verification lists
  are removed. New `taskEventPageSchema` for `GET /api/tasks/:id/events`.
- `bootstrapSchema`: `modelConfigured` becomes `capabilities.agentExecution`, `taskStreaming`
  becomes `streaming`; adds `capabilities.verification`, `capabilities.drivers`, `defaultModel`
  and `profiles`; `tasks` are summaries.
- New `apiErrorSchema` (`{ error: { code, message, details? } }`) with `apiErrorCodeSchema`
  (including `GOAL_VERSION_BUDGET`), and `workspaceHintSchema` for the workspace stream.

| Method   | Path                                           | Body → response                                                   |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| `GET`    | `/health`                                      | liveness                                                          |
| `GET`    | `/health/ready`                                | readiness: database and sandbox drivers                           |
| `GET`    | `/api/bootstrap`                               | → `bootstrapSchema`                                               |
| `GET`    | `/api/stream`                                  | SSE of `workspaceHintSchema`; not resumable                       |
| `GET`    | `/api/bots`                                    | → `{ bots: Bot[] }`; archived bots are hidden                     |
| `POST`   | `/api/bots`                                    | `createBotCommandSchema` → `{ bot }`                              |
| `GET`    | `/api/bots/:id`                                | → `{ bot }`                                                       |
| `PATCH`  | `/api/bots/:id`                                | `updateBotCommandSchema` → `{ bot }`                              |
| `DELETE` | `/api/bots/:id`                                | archives; `409 CONFLICT` while `activeTaskIds` is non-empty       |
| `GET`    | `/api/bots/:id/memory`                         | → `botMemorySchema`                                               |
| `PUT`    | `/api/bots/:id/memory`                         | `updateBotMemoryCommandSchema` → `botMemorySchema`                |
| `GET`    | `/api/bots/:id/messages`                       | → `conversationViewSchema`                                        |
| `POST`   | `/api/bots/:id/messages`                       | `sendBotMessageCommandSchema` → `sendBotMessageResultSchema`      |
| `GET`    | `/api/runtime-profiles`                        | → `{ profiles: RuntimeProfile[] }`                                |
| `POST`   | `/api/runtime-profiles`                        | `createRuntimeProfileCommandSchema` → `{ profile }`               |
| `GET`    | `/api/runtime-profiles/:id`                    | → `{ profile }`                                                   |
| `PATCH`  | `/api/runtime-profiles/:id`                    | `updateRuntimeProfileCommandSchema` → `{ profile }`               |
| `DELETE` | `/api/runtime-profiles/:id`                    | `409 PROFILE_IN_USE` while a bot references it                    |
| `GET`    | `/api/sandbox-drivers`                         | → `{ drivers: SandboxDriverInfo[] }`                              |
| `GET`    | `/api/models`                                  | → `modelsViewSchema`                                              |
| `GET`    | `/api/tasks`                                   | → `{ tasks: TaskSummary[] }`                                      |
| `POST`   | `/api/tasks`                                   | `createTaskCommandSchema` → `{ task }`                            |
| `GET`    | `/api/tasks/:id`                               | → `taskViewSchema`                                                |
| `POST`   | `/api/tasks/:id/messages`                      | `postTaskMessageCommandSchema` → `{ message: TaskMessage }`       |
| `POST`   | `/api/tasks/:id/stop`                          | `stopTaskCommandSchema` → `{ task }`                              |
| `GET`    | `/api/tasks/:id/events?after=`                 | → `taskEventPageSchema`, with output previews                     |
| `GET`    | `/api/tasks/:id/stream`                        | SSE of `taskEventSchema`; resumes from `Last-Event-ID` or `after` |
| `GET`    | `/api/tasks/:id/artifacts/:artifactId/content` | artifact content                                                  |

No per-bot stream: workspace hints cover bot and conversation changes.

**Action required (frontend):** build an adapter in `apps/web/src/api` from the 1.0 shapes to the
view models, keep task views current with `applyTaskEvent` over the task stream, and move the
web app off `@jj/contracts/legacy`. Offer only what `capabilities` reports, and label profiles
whose `status.isolated` is false as unisolated.
**Action required (backend):** rewrite `apps/api` and the worker on 1.0: the routes above, the
error envelope, record-carrying events and both streams. Old packages compile against
`@jj/contracts/legacy` until then; delete the legacy entry points with their last importer.

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
