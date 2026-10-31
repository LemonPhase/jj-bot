# Contract Changelog

Every change to `packages/contracts` must bump `CONTRACT_VERSION` and record any required backend/frontend coordination notes here.

## `0.2.0` — 2026-10-31

### Added

- `createTaskCommandSchema` (`CreateTaskCommand`): Validates task creation payloads (`goal`, `coordinatorBotId`, `participantBotIds`, `verificationPlan`, optional `checks` and `autoStart`), enforcing that the coordinator belongs to the unique participant roster.
- `postTaskMessageCommandSchema` (`PostTaskMessageCommand`): Validates shared task messages (`text`, `authorId`, `authorKind`, `intent`, and explicit `activateBotIds`). Shared visibility never implies bot activation unless `activateBotIds` is non-empty.
- `steerTaskCommandSchema` (`SteerTaskCommand`): Validates steering requests (`text`, optional `authorId`, `observedGoalVersion`, `goal`, `verificationPlan`, `checks`). When `observedGoalVersion` is provided, the backend rejects stale steering against a mismatched `goalVersion` with `409 STALE_GOAL_VERSION`.
- `stopTaskCommandSchema` (`StopTaskCommand`): Validates task stop/cancellation requests (`reason`, `authorId`, `requestedBy`).
- `taskViewSchema` (`TaskView`): Shared read model backing both task chat and collaboration views (`task`, `bots`/`participants`, `sessions`, `messages`, `checks`, `events`, and `replayCursor` for ordered event replay after reload).
- `checkDefinitionSchema` (`CheckDefinition`): Executable check specification (`contains`, `regex`, `json`, `model`).

### Action Required (Backend / Frontend Alignment)

- Backend exposes `GET /api/tasks/:id` and `GET /api/tasks/:id/view` returning `TaskView` (with `replayCursor`), `POST /api/tasks/:id/messages`, `POST /api/tasks/:id/steer` (enforcing `observedGoalVersion` when supplied), and `POST /api/tasks/:id/stop` (plus `/api/tasks/:id/cancel`).

## `0.1.0` — 2026-10-31

### Added

- Initial domain schemas: `botSchema`, `taskSchema`, `executionSessionSchema`, `taskMessageSchema`, `taskEventSchema`, `verificationCriterionSchema`, `verificationPlanSchema`, `verificationResultSchema`, and `bootstrapSchema`.
