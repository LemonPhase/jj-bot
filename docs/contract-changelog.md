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

## 1.5.0 — 2026-11-03 — Secrets store: encrypted provider keys and sandbox secrets

**Changed by:** backend and frontend ([#30](https://github.com/LemonPhase/jj-bot/issues/30), design agreed on the issue) · **Compatibility:** additive

- New `secrets.ts`: `secretNameSchema` (an environment variable name, `SECRET_NAME_PATTERN`, refusing
  the names `isReservedSecretName` reserves: `PATH`, `HOME`, `*_PROXY`, `JJ_*`, `LD_*`, …),
  `secretValueSchema` (one trimmed line of `MIN_SECRET_LENGTH` = 16 to `MAX_SECRET_LENGTH` = 4096
  characters; issues never repeat the value), `putSecretCommandSchema` (`{ value }`),
  `storedSecretSchema` (`{ hint, readable, updatedAt }`: the last four characters, and whether the
  server's current `JJ_SECRET_KEY` opens it), `secretInfoSchema` (adds `name`, `createdAt`),
  `secretsViewSchema` (`{ available, secrets }`) and `secretGrantsSchema` (unique names, at most 64).
- Routes: `GET /api/secrets` → `secretsViewSchema`; `PUT /api/secrets/:name` with
  `putSecretCommandSchema` → `{ secret }` (201 when new, 200 when replaced); `DELETE
  /api/secrets/:name` → 204, which also removes every profile's grant of it;
  `PUT /api/models/providers/:providerId/key` with `putSecretCommandSchema` and `DELETE` the same
  path → `modelsViewSchema`. No answer ever carries a value. A provider its server variable
  configures refuses a stored key with `409 CONFLICT`; an unknown or keyless provider is
  `404 NOT_FOUND`.
- `providerInfoSchema`: adds `keySource` (`env`, `stored` or null) and `storedKey`
  (`storedSecretSchema` or null), both parsing as null when missing. `configured` also counts a
  readable stored key; the variable wins when both exist.
- `runtimeProfileSchema`: adds `secrets`, the sandbox secrets granted by name (default `[]`).
  `createRuntimeProfileCommandSchema` and `updateRuntimeProfileCommandSchema` take
  `secrets: secretGrantsSchema` (replaced whole); a name that is not stored, or that is also a
  `sandbox.env` key, is `VALIDATION_FAILED`.
- `capabilitiesSchema`: adds `secretStore` (the server has `JJ_SECRET_KEY`), false when missing.
- `API_ERROR_CODES`: adds `SECRET_STORE_UNAVAILABLE` (409), answered to a write without
  `JJ_SECRET_KEY`.
- `workspaceHintSchema`: adds `secrets.changed`, sent when a secret or a stored provider key is
  stored, replaced or removed. Older clients ignore it.

**Action required (frontend):** Settings shows where each provider's key comes from and stores,
replaces or removes one; a Secrets section lists, stores and removes sandbox secrets; the profile
editor grants them. Values are typed once and never shown again.
**Action required (backend):** none beyond this change.
## 1.4.0 — 2026-11-03 — Verification plans and checks

**Changed by:** backend & frontend ([#31](https://github.com/LemonPhase/jj-bot/issues/31), agreed in [this comment](https://github.com/LemonPhase/jj-bot/issues/31#issuecomment-6594684999)) · **Compatibility:** additive (one reshaped command schema; see below)

- `verificationCriterionSchema` (new module `verification`) becomes a union on `method`, replacing
  the free-text `method` and `expectedEvidence`: `command` (`command`, optional `timeoutSeconds`),
  `file` (`path`, `expect`: `exists` | `contains` | `matches` | `json`, with `value`, `flags` or a
  JSON `schema`) and `result` (the same assertions on the `complete_task` result). Every criterion
  has an `id` (a slug, unique in its plan) and a `description`; `verificationPlanSchema` holds 1 to
  `VERIFICATION_PLAN_LIMIT` (20). A JSON `schema` may not use references (`$ref`, `$dynamicRef`,
  `$recursiveRef`) and is at most `CHECK_SCHEMA_LIMIT` (20000) characters and 32 levels deep. This is a minor change although the shape changed: every server
  so far refused any plan with `422 VERIFICATION_UNAVAILABLE`, so no stored data or working client
  depends on the old shape.
- `taskSchema`: adds `verificationPlan`, the current goal version's plan or null (parsed as null
  from events stored before it). `createTaskCommandSchema.verificationPlan` may be null.
  `postTaskMessageCommandSchema.verificationPlan` replaces the plan (null removes it) and, like
  `goal`, requires `observedGoalVersion`; a changed plan starts a new goal version.
- `task.goal_changed` carries `verificationPlan` (default null), so the event log is the history of
  goals and plans.
- New `verificationCheckSchema`: one check's evidence (criterion, method, goal version, attempt,
  outcome `passed` | `failed` | `inconclusive`, exit code, interruption, duration, detail, output
  preview of at most `CHECK_OUTPUT_PREVIEW_LIMIT` bytes, artifact, session, run, timestamps). A
  command check passes only on exit code 0 with no interruption.
- New events: `verification.started` (goal version, attempt, criteria), `verification.checked`
  (the check record) and `verification.finished` (outcome and counts).
- `taskViewSchema` adds `verificationChecks` (default `[]`): the latest attempt of each goal
  version, which `applyTaskEvent` keeps current. `taskSummarySchema` adds `verification`
  (`verificationSummarySchema`), present exactly when the task has a plan.
- Pure helpers: `verificationSummary` (where a task stands for its current goal version),
  `latestAttemptChecks`, `isVerified` (the one rule for showing a task as verified) and
  `samePlan` (plans equal whatever their key order; a repeated plan starts no new version).
- `ACTIVITY_KINDS` adds `verifying`; `verification.started` sets it ("Running the verification
  checks (n)").
- `capabilities.verification` is true on the backend: plans are accepted and enforced.

**Action required (frontend):** none beyond this release: the new-task dialog and the task header
edit checks, the header, the Progress view and the chat task card show where they stand, and the
demo keeps `verification: false`.
**Action required (backend):** none beyond this release.

## 1.3.0 — 2026-11-03 — Spend caps and usage reporting

**Changed by:** backend and frontend ([#28](https://github.com/LemonPhase/jj-bot/issues/28), agreed in [this comment](https://github.com/LemonPhase/jj-bot/issues/28#issuecomment-6593254682)) · **Compatibility:** additive

- `profileBudgetsSchema`: adds `maxUsdPerTask` (default 5) and `maxUsdPerBotPerDay` (default 20,
  over any rolling 24 hours, task sessions and chat together), US dollars from `spendCapUsdSchema`
  (positive, at most `MAX_SPEND_CAP_USD` = 10000), `null` for no cap. Stored profiles without the
  keys take the defaults. `updateRuntimeProfileCommandSchema.budgets` takes both keys, no defaults.
- `taskObjectSchema` (so `taskSchema` and `taskSummarySchema`): adds `spendCapUsd`, the task's cap
  (null for none), copied from the coordinator's profile at creation. It parses as `null` when
  missing, so events stored before this version still parse.
- `createTaskCommandObjectSchema`: optional `spendCapUsd` (omitted: the coordinator's profile's
  cap; `null`: no cap). New `updateTaskCommandSchema` (`{ spendCapUsd }`, at least one field) for
  `PATCH /api/tasks/:id` → `{ task }`; a cancelled or stopping task answers `409 TASK_TERMINAL`.
- `usageSchema`: adds `unpricedCalls`, the calls on models with no listed price, whose cost is
  unknown and not in `costUsd`. It parses as 0 when missing; `emptyUsage` and `addUsage` carry it,
  so `applyTaskEvent` folds it from `model.finished`.
- `taskEventSchema`: new markers `spend.capped` (`{ scope, spentUsd, capUsd }`, attributed to the
  session whose model call was refused) and `spend.threshold` (`{ spentUsd, capUsd }`, once per cap
  value past `SPEND_SOFT_THRESHOLD` = 0.8 of the task's cap). `spendScopeSchema`: `task`, `bot`,
  `instance`. Older clients ignore both as unknown types.
- `API_ERROR_CODES`: adds `SPEND_CAP_REACHED` (409, `details` per `spendCapReachedDetailsSchema`:
  `{ scope, spentUsd, capUsd, botId? }`), answered to a message that would continue a task at a
  cap, a task whose coordinator is at its daily cap, and a direct message to a bot at its cap.
- New `usageReportSchema` for `GET /api/usage`: `{ asOf, instance: { last24h, last7d, last30d,
  capUsdPerDay }, bots: [{ botId, name, archived, last24h, last30d, chatLast30d, capUsdPerDay }],
  models: [{ model, last30d }] }`.
- New pure helpers `formatUsd` and `formatSpendAgainstCap`, so the server's cap messages and the
  clients show amounts alike: spend next to a cap gets enough places that over never reads as at or
  under it (`$4.996 of $5.00`).

**Action required (frontend):** none beyond this change, which shows the cap in the task header and
new-task dialog, the caps in the profile editor, spend on the bot inspector and a Usage tab in
Settings, and never shows unpriced calls as free.
**Action required (backend):** none.

## 1.2.0 — 2026-11-03 — A waiting task's question in its summary

**Changed by:** backend ([#81](https://github.com/LemonPhase/jj-bot/issues/81), agreed in [this comment](https://github.com/LemonPhase/jj-bot/issues/81#issuecomment-6592902366)) · **Compatibility:** additive

- `taskSummarySchema`: adds an optional `question`, set only while the task is `waiting` (the
  schema refuses it on any other status): the coordinator's last message to the user, redacted
  and clipped to `TASK_QUESTION_LIMIT` (240) on one line. It is derived from the task log, so no
  stored record changes; a task that continues or finishes no longer carries it.
- New pure helpers: `questionExcerpt` (the clip), `isCoordinatorToUser` (which task message is
  the coordinator talking to the user) and `waitingQuestion`, which derives `question` from a
  task view, so a client keeps the summary of a task it follows in step with the server's.

**Action required (frontend):** none; the inline task card shows it as `Question · …`.
**Action required (backend):** none; task summaries (`GET /api/tasks`, bootstrap) set it.

## 1.1.0 — 2026-11-02 — Task lookup tools

**Changed by:** backend ([#77](https://github.com/LemonPhase/jj-bot/issues/77), agreed in [this comment](https://github.com/LemonPhase/jj-bot/issues/77#issuecomment-6590262115) and [its addendum](https://github.com/LemonPhase/jj-bot/issues/77#issuecomment-6590794101)) · **Compatibility:** additive

- `COLLABORATION_TOOLS`: adds `task_state`, `task_log`, `read_entry` and `read_report`, the
  read-only lookup tools every task session has. Profiles never list collaboration tools
  (`toolNameSchema` stays the coding tools), so no stored profile changes.
- `activityFromEvent`: a lookup tool's `tool.started` is a `reading` activity ("Checking the task
  state", "Reading the task log", "Reading task log entry <id>", "Reading the report of
  <bot or session>") instead of the generic `command` line "Using <tool>".
- `taskMessageSchema.intent`: a bot's broadcast (`message` with no recipient) is now posted as
  `notification`, a value the enum already had, so it can be told apart from a coordinator's reply
  to the user, which is `discussion` with no recipient too. Earlier broadcasts stay `discussion`.

**Action required (frontend):** none. The task chat labels broadcasts "notification", and the
office view's speech bubble reads "<bot> · notification" for them (`bubbleWho`).
**Action required (backend):** none.

## 1.0.2 — 2026-11-01 — Validate network allowlist hosts

**Changed by:** backend ([#63](https://github.com/LemonPhase/jj-bot/issues/63)) · **Compatibility:** clarifying

- `networkPolicySchema` (`mode: "allowlist"`): each of `hosts` must be a host name (letters,
  digits, hyphens and dots, IPv4 literals included), optionally prefixed with `*.` (every
  subdomain of a name with at least two labels whose last label is not numeric, decimal or `0x`
  hex, so a wildcard never covers an IP address; not the name itself) and optionally followed by
  `:port` (1–65535). No scheme, path, whitespace, IPv6 literal or bare `*`. Entries are trimmed,
  lowercased and deduplicated; an invalid one is a field error at `sandbox.network.hosts.<index>`.
  The pattern is exported as `NETWORK_HOST_PATTERN` and appears as the items' `pattern` in the
  driver spec JSON Schema. A bare entry allows ports 80 and 443; `host:port` allows that port.
- No stored profile is invalidated: no driver accepted `allowlist` before this version, so no
  profile with one could be saved.

**Action required (frontend):** none; the generated form checks each line against the pattern.
**Action required (backend):** none.

## 1.0.1 — 2026-11-01 — Remove the legacy entry points

**Changed by:** backend · **Compatibility:** clarifying

- `@jj/contracts/legacy` and `@jj/contracts/legacy/backend` are removed, as 1.0.0 planned: nothing
  imported them once `apps/api` and `apps/worker` ran on the engine. No schema or wire shape
  changes.

**Action required (frontend):** none.
**Action required (backend):** none.

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
| `GET`    | `/health/ready`                                | readiness: database, migrations, worker heartbeat, drivers        |
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
