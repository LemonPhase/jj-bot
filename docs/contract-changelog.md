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

## 1.12.0 — 2026-11-09 — MCP servers in sessions; a discovery's configuration hash

**Changed by:** backend ([#29](https://github.com/LemonPhase/jj-bot/issues/29), step 4b) · **Compatibility:** additive (a new response field; a client before 1.12.0 ignores it)

- `mcpDiscoverySchema.configHash` (SHA-256, required): the hash of what the test runs, the one its
  snapshot will carry, present from the moment the test is queued. A client can match a running
  test to the snapshot it will give and to other tests and snapshots of the same configuration.
  Testing a server while a test of another `configHash` is queued or running is refused with 409
  `CONFLICT`, whose `details` name the running test (`discoveryId`, `configHash`); testing the same
  `configHash` again still answers with the running test.
- `capabilitiesSchema.mcp`: the docstring states when each kind is true, now that servers reach
  sessions. `stdio` is true when the server has an MCP client and an available driver declares
  `spawn`; `remote` when it has an MCP client and `JJ_MCP_REMOTE` is not `off`. No schema change.

**Action required (frontend):** none to keep working; the demo API gives its failed discoveries a
hash of what they were asked to test. The profile editor (step 6) says so when a test of another
configuration is running, and follows the running test the `CONFLICT` names.
**Action required (backend):** none beyond this change: discoveries return the stored hash, and
bootstrap reports `capabilities.mcp` per kind from the MCP client, the drivers and `JJ_MCP_REMOTE`.

## 1.11.0 — 2026-11-09 — Uploads

**Changed by:** backend and frontend ([#88](https://github.com/LemonPhase/jj-bot/issues/88), agreed in [this comment](https://github.com/LemonPhase/jj-bot/issues/88#issuecomment-6613492421)) · **Compatibility:** additive

The upload routes are part of the contract, but a server serves them only while it reports
`capabilities.uploads`; a server that reports null answers them 404.

- New `uploads.ts`. `uploadPathProblem(path)` (pure) and `uploadPathSchema`: a workspace-relative
  POSIX path in Unicode NFC, of 1 to `UPLOAD_PATH_MAX_SEGMENTS` = 8 segments of 1 to
  `UPLOAD_SEGMENT_MAX_BYTES` = 255 UTF-8 bytes each, and at most `UPLOAD_PATH_MAX_LENGTH` = 1024
  characters. Refused: an absolute path; an empty, `.` or `..` segment; a backslash, NUL, any
  control character (`\p{Cc}`, LS, PS), a character `hasInvisible` reports, or a lone surrogate;
  a segment that starts with `-` or ends with a space or a dot; a first segment in
  `RESERVED_UPLOAD_ROOTS` (`.git`, `.jj`, `.jj-bot`) in any case. `uploadNameProblem(name)` checks a
  staged file's name: one such segment, whose default path `defaultUploadPath(name)`
  (`uploads/<name>`, `DEFAULT_UPLOAD_DIR`) is valid.
- `stagedUploadSchema`: `id`, `name`, `sizeBytes`, `sha256`, `contentType` (derived by the server,
  never taken from the client) and `expiresAt`; `stagedUploadResultSchema` (`{ upload }`).
- `uploadEntrySchema`: `{ uploadId, path? }`. `uploadEntryListSchema`: at most `MAX_UPLOAD_FILES` =
  20 entries, each upload once, explicit paths unique ignoring case (`sameUploadPath`).
- Commands: `createTaskCommandObjectSchema.uploads` (default `[]`, and so `POST /api/tasks`);
  `startTemplateCommandSchema.uploads` (default `[]`; `templateTaskCommand` passes them on);
  `uploadToTaskCommandSchema` (`{ files }`, 1 to 20 entries). A template's own create and update
  commands take no uploads: a template carries no files.
- `artifactSchema.upload`: `{ messageId, state, placedAt, error } | null` (`artifactUploadSchema`),
  null by default, so records stored before 1.11.0 parse; `state` is `uploadStateSchema`
  (`pending`, `placed`, `failed`). An uploaded file is an artifact of kind `file` with no session or
  run, so 1.10.1 readers still parse task views.
- New event `artifact.updated` (`{ artifact, previousState }`): an upload was placed or could not
  be, once. `applyTaskEvent` upserts it like `artifact.created`.
- `capabilitiesSchema.uploads`: `uploadLimitsSchema` (`maxFileBytes`, `maxFiles`, `maxTaskBytes`) or
  null, parsed as null from servers before uploads. A command also attaches at most
  `UPLOAD_COMMAND_MAX_BYTES` = 64 MiB.
- Routes: `POST /api/uploads?name=…` with the file's bytes as `Content-Type:
  application/octet-stream` and a `Content-Length` (411 without one; `Expect: 100-continue` is
  answered only once the limits pass) → 201 `stagedUploadResultSchema`. It is the only write
  whose body is not JSON; JSON, multipart and form bodies answer 415. `DELETE /api/uploads/:id` →
  204. `POST /api/tasks/:id/uploads` with `uploadToTaskCommandSchema` → 201
  `uploadToTaskResultSchema` (`{ artifacts, message }`).
- API error code `UPLOAD_TOO_LARGE` (413): a file, a command's files, a task's uploads in all, or
  the server's staging space over its limit. Existing codes cover the rest: `NOT_FOUND` (an
  unknown, expired or removed staged upload), `CONFLICT` (already attached, or an upload waiting
  to be placed at that path), `TASK_TERMINAL`, `VALIDATION_FAILED` (408 for a body that comes too
  slowly) and `RATE_LIMITED` (too many uploads in flight).
- `formatUploadSize` and `uploadAnnouncement` word sizes and the task log's announcement
  ("Uploaded 2 files: uploads/a.csv (1.2 KB), …") the same way on every side.

**Action required (frontend):** a drop zone in New task, a paperclip in the task chat, an upload
card with each file's state, and "Uploaded by you" in the artifact list. Done in the same change,
the demo included.
**Action required (backend):** none beyond this change; a client built against 1.10.1 ignores
`artifact.updated` and the new capability. Migration 0016 adds `staged_uploads` and the upload
columns of `artifacts`, with their indexes and check.

## 1.10.1 — 2026-11-04 — Disabled MCP servers and draft sandboxes in discoveries

**Changed by:** backend ([#29](https://github.com/LemonPhase/jj-bot/issues/29), agreed in the comments "Contract refinement for step 4a (#136): 1.9.1" and "… 1.9.2, discovery takes a draft sandbox", shipped together as 1.10.1) · **Compatibility:** additive (no wire change for existing clients; commands that were refused can now be accepted)

- `ungrantedMcpSecrets`, and so `refineMcpSecretGrants` in `createRuntimeProfileCommandSchema` and
  `updateRuntimeProfileCommandSchema`, check enabled servers only. Removing a stored secret disables
  every MCP server that uses it but keeps its `secretEnv` reference, so a create, or a patch that
  carries both `secrets` and `mcpServers`, with such a server is accepted. Enabling it again is
  checked: its secret must be granted. No field records why a server was disabled.
- `startMcpDiscoveryCommandSchema` takes an optional `sandbox` (`sandboxSpecSchema`): a draft of the
  profile's sandbox settings, in the shape of the profile's `sandbox`. The test runs on it and the
  snapshot's `configHash` is computed from it; without it, the profile's stored sandbox is used. A
  stdio server's `configHash` covers its sandbox (driver, image, network, `env`), so a profile save
  that changes the sandbox can pin the snapshot found with the same draft, in the same save; the
  `MCP_SNAPSHOT_MISMATCH` message says so.

**Action required (frontend):** none to keep working. The profile editor may send a disabled server
whose secret is gone, and should say that enabling it needs the secret stored and granted again; it
sends its draft sandbox with a test once the sandbox is edited (step 6).
**Action required (backend):** none beyond this change: the server checks grants on the enabled
servers of the merged profile, and validates a draft sandbox with its driver (`PROFILE_UNSUPPORTED`
on refusal) and stores it with the discovery.

## 1.10.0 — 2026-11-03 — Event retention and payload limits

**Changed by:** backend and frontend ([#32](https://github.com/LemonPhase/jj-bot/issues/32), agreed in [this comment](https://github.com/LemonPhase/jj-bot/issues/32#issuecomment-6613592061)) · **Compatibility:** additive; a compacted task's log has gaps in its sequences at or below `compactedThrough`, which a reader that assumed gap-free logs must allow

- `task.compacted` (`{ through, removed, stripped }`, integers): a marker the server appends after
  compacting a finished task's events at or below `through`. `applyTaskEvent` folds it into the
  view's `compactedThrough` (the larger of the two).
- `taskViewSchema.compactedThrough` and `taskEventPageSchema.compactedThrough`: integers, default 0
  (parsed as 0 from servers before 1.10.0). Events at or below it were compacted: activity and
  superseded snapshots were deleted, and `tool.finished` output and `model.finished` text dropped.
  For any cursor n, the kept events after n fold onto the view at n into the latest view, its
  records compared by id, so a stream resumed from any `Last-Event-ID` converges.
- `eventBaseSchema.payloadArtifactId`, optional: the event's payload was over the server's cap
  and clipped; its full payload is that `output` artifact, as JSON, at `savedPayloadPath(type)`
  (`<type> payload`; `savedPayloadType(artifact)` reads it back). Only what no record bounds is
  clipped (tool output previews, error and stop texts, a held call's arguments), each string over
  4 KiB within its field's limit and marked (`… [N more characters in the saved copy]`); record
  snapshots are stored whole, over the cap too, and every stored payload parses with its type's
  schema. A client folds a clipped event, then refetches the view, whose records are whole.
- `EVENT_PAYLOAD_CAP_BYTES` = 1 MiB: the ceiling of the server's payload cap.
- `bootstrapSchema.eventRetentionDays`, optional (absent from servers before 1.10.0): the server's
  `JJ_EVENT_RETENTION_DAYS`, 0 to 3650, 0 meaning never, so Settings → About can show it.

**Action required (frontend):** none beyond this change: the web app reloads the view after a
spilled event, notes a compacted task's Progress ("Activity before … was compacted"), marks its
tool rows "output not kept", links a spilled event's saved copy and shows the retention in
Settings → About.
**Action required (backend):** none beyond this change: the `maintenance.compact` job compacts
finished tasks hourly, and `emit` spills payloads over `JJ_EVENT_PAYLOAD_CAP_BYTES`. Migration
0014 adds `tasks.events_compacted_through`, `task_events.payload_artifact_id`, the finished-tasks
index and the job kind.

## 1.9.0 — 2026-11-03 — Task templates

**Changed by:** backend and frontend ([#91](https://github.com/LemonPhase/jj-bot/issues/91), agreed in [this comment](https://github.com/LemonPhase/jj-bot/issues/91#issuecomment-6613485332)) · **Compatibility:** additive

- New `templates.ts`. `taskTemplateSchema`: `id`, `title` (1–120 characters), `goal` (at most
  `COMMAND_TEXT_LIMIT`), `coordinatorBotId` and `participantBotIds` (the coordinator included, the
  same refinement as tasks, `coordinatorParticipates`), `verificationPlan` (null by default),
  `spendCapUsd` (omitted: the coordinator's profile's `maxUsdPerTask` at start; null: no cap; the
  `createTaskCommandSchema` semantics), `problems` (derived on read, empty by default) and
  `createdAt`, `updatedAt`. `MAX_TASK_TEMPLATES` = 200.
- `templateProblemSchema`, a union on `kind`: `bot_archived` (`botId`, `name`),
  `model_not_configured` (`botId`, `message`) and `verification_unavailable`. An empty list means
  the template can start now; spend caps are checked at start and are not problems.
  `describeTemplateProblem` words one.
- Commands: `createTaskTemplateCommandSchema` (the create-task fields with `title` required, and
  the same coordinator transform, now the exported `withCoordinator`);
  `updateTaskTemplateCommandSchema` (partial, at least one field; `participantBotIds` replaced
  whole; `spendCapUsd` also takes `PROFILE_SPEND_CAP` = `"profile"` to go back to the profile's cap,
  which a patch could not otherwise say); `startTemplateCommandSchema` (`instructions` of 1 to
  `TEMPLATE_INSTRUCTIONS_LIMIT` = 4000 characters, `title`, `spendCapUsd`, all optional).
- `templateRunGoal` appends a run's instructions to the goal under
  `TEMPLATE_INSTRUCTIONS_HEADING` (`Instructions for this run:`); `templateTaskCommand` builds the
  `CreateTaskCommand` a start makes; `templateGoalTooLong` says when the combined goal is over
  `COMMAND_TEXT_LIMIT`, which a start answers with 422 `VALIDATION_FAILED`.
- `taskObjectSchema.templateId` (and so tasks, summaries and `task.created`): the template a task
  was started from, null otherwise and for records stored before 1.9.0.
- Routes: `GET /api/task-templates` → `taskTemplateListSchema` (`{ templates }`, oldest first);
  `POST` → 201 `taskTemplateResultSchema` (`{ template }`); `GET` and `PATCH
  /api/task-templates/:id` → `{ template }`; `DELETE` → 204, leaving its tasks and their
  `templateId` as they are; `POST /api/task-templates/:id/tasks` with `startTemplateCommandSchema` →
  201 `{ task }`.
- API error code `TEMPLATE_UNUSABLE` (409, `details` per `templateUnusableDetailsSchema`:
  `{ problems }`), answered to a start while the template has any problem. Saves answer
  `VALIDATION_FAILED` for an unknown or archived bot and `CONFLICT` past the limit; a start can
  also answer `SPEND_CAP_REACHED` for a coordinator at its cap, as task creation does.
- `workspaceHintSchema`: adds `templates.changed`, sent when a template is saved, changed or
  deleted. Older clients ignore it.

**Action required (frontend):** list, edit, delete and start templates, save a task as one, and
show "From template X" on a task. Done in the same change, the demo included.
**Action required (backend):** none beyond this change; a client built against 1.8.0 that parses
tasks strictly must accept `templateId`.

## 1.8.0 — 2026-11-03 — Bot names and roles are a single line

**Changed by:** backend and frontend ([#100](https://github.com/LemonPhase/jj-bot/issues/100), agreed in [this comment](https://github.com/LemonPhase/jj-bot/issues/100#issuecomment-6607691571) and amended in [this one](https://github.com/LemonPhase/jj-bot/issues/100#issuecomment-6613746021)) · **Compatibility:** tightens validation: a 1.7.0 writer that sends a multi-line name or role is now refused, and a 1.8.0 reader refuses a bot record holding one, which a 1.8.0 server never sends

- `botNameSchema` and the bot's role schema (bot records, `createBotCommandSchema` and
  `updateBotCommandSchema`): still trimmed, a name 1 to 60 characters and a role at most 80 once
  trimmed, and now each one line of plain text. Both refuse every control character (`\p{Cc}`:
  LF, CR, VT, FF and NEL among them), LS (U+2028) and PS (U+2029); Unicode's Bidi_Control set
  (U+061C, U+200E, U+200F, U+202A to U+202E and U+2066 to U+2069); the invisible U+180E, U+200B,
  U+2060 to U+2064, U+206A to U+206F, U+FEFF and U+FFF9 to U+FFFB; the tag characters U+E0000 to
  U+E007F, which can hide text a model reads but a reader does not see; and lone surrogates. ZWNJ
  and ZWJ (U+200C, U+200D) are allowed, since scripts and emoji sequences need them. Names and
  roles appear unquoted in model-facing text (the persona line, the team roster, the `delegate`
  and `message` tool descriptions, entry headers, `task_log` index lines and handoff notes), where
  a line break could forge a line. A refused value is a `VALIDATION_FAILED` field error on `name`
  or `role` that names the first refused character as `U+XXXX`, such as "A bot name is one line
  of plain text: remove U+000A (a line break)." A break at either end is trimmed away like other
  surrounding whitespace.

**Action required (frontend):** none: Bot Studio checks a draft with the contract's schema and
shows the field error under the name or role, and the demo API applies the same schema.
**Action required (backend):** none: create and update refuse such a name or role, and migration
0012 normalises those stored before, refusing exactly the contract's set: each run of refused
characters becomes one space, then the value is trimmed; an empty name becomes `Bot` and an empty
role stays empty; an active bot whose new name another active bot of its owner holds, ignoring
case, takes the first free ` (2)`, ` (3)`, …, the oldest first, so names that were already valid
never change; roles take no number. The migration refuses a database whose `server_encoding` is
not `UTF8`, which JJ Bot requires. No read path rewrites a bot record, so its stored and shown
name and role agree. Text stored before the upgrade keeps the old names and roles as they were:
queued inbox items, first inputs, approval texts and transcripts.

## 1.7.0 — 2026-11-03 — MCP servers and skills per profile

**Changed by:** backend and frontend ([#29](https://github.com/LemonPhase/jj-bot/issues/29), agreed in [this comment](https://github.com/LemonPhase/jj-bot/issues/29#issuecomment-6602672162)) · **Compatibility:** additive for writers; a 1.6.0 reader that parses profiles strictly cannot parse one holding an approval rule on an MCP tool (`approvalRuleSchema.tool` was the coding tools only)

`capabilities.mcp` says, per kind, whether sessions can use MCP servers of that kind. While it is
false, servers of that kind may still be stored and discovered, through the MCP routes below, but
they reach no session. The skills routes are served only once a server reports
`capabilities.skills`; until then they answer 404, and a profile granting a skill is refused with
`MCP_UNAVAILABLE`.

- New `mcp.ts`. `mcpServerSchema`, a union on `transport` of `mcpStdioServerSchema` (`command`,
  `args`, `cwd`, `env`, `secretEnv`, `startupTimeoutSec`) and `mcpHttpServerSchema` (an https `url`
  without credentials, `headers`, `secretHeaders`), sharing `name` (`mcpServerNameSchema`:
  `^[a-z](?:_?[a-z0-9])*$`, at most 24 characters, so never `__`), `description`, `enabled`,
  `exposure` and `toolExposure` (`direct` | `hidden`), `timeoutSec`, `askUnlessReadOnly` (default
  true for `http`, false for `stdio`) and `snapshotId`. `env` and `secretEnv` variables take any
  POSIX name except `JJ_*` (`mcpEnvNameSchema`); `secretEnv` values are sandbox secret names.
  `cwd` has no empty, `.` or `..` part. Credentials belong in `secretHeaders`; a check of names
  refuses a `url` with a user or password or with a query, fragment or path `;` parameter (split
  on `&` and `;`) named like a key, token, secret, password, auth, signature or code, and plain
  `Authorization`, `Proxy-Authorization` and `Cookie` headers and any header named that way. It
  checks names only: a secret under an unusual name, or in the path itself, is not detected. A URL with control characters or backslashes is refused, and the URL is stored
  normalized (`new URL(url).href`, punycode hosts). Headers the transport sets, `Accept` and
  `Content-Type` included, are refused, and header names ignore case. `mcpServersSchema` holds at
  most `MAX_MCP_SERVERS` = 8 with unique names.
- `runtimeProfileSchema.mcpServers` and `.skills` (both parsed as empty from servers before
  1.7.0), also in `createRuntimeProfileCommandSchema` and, replaced whole,
  `updateRuntimeProfileCommandSchema`. A stdio server's `secretEnv` must name secrets the same
  profile grants (`ungrantedMcpSecrets`, `refineMcpSecretGrants`): the create command checks it,
  a patch checks it when it carries both lists, and the server checks the merged profile.
- Records `mcpToolSchema`, `mcpToolSnapshotSchema` (immutable; sanitized tools with a hash and
  an `exposedName` that starts with `mcp__<server>__` and is unique within the snapshot,
  `configHash`, warnings) and `mcpDiscoverySchema` (`queued`, `running`,
  `succeeded`, `failed`; redacted `error` and `stderrTail`). Routes:
  `POST /api/runtime-profiles/:id/mcp-discoveries` with `startMcpDiscoveryCommandSchema` → 202
  `mcpDiscoveryResultSchema`; `GET /api/mcp-discoveries/:id` → `mcpDiscoveryResultSchema`;
  `GET /api/mcp-snapshots/:id` → `mcpSnapshotResultSchema`.
- New `skills.ts`: `skillNameSchema` (the Agent Skills format), `skillGrantsSchema` (unique, at
  most `MAX_PROFILE_SKILLS` = 32), `skillFilePathSchema` (relative, no `.` or `..` parts),
  `putSkillCommandSchema` (at most 100 files with base64 content, a root `SKILL.md` of at most
  64 KiB, at most 1 MiB in all) and `skillSchema` (content-addressed by `hash`). Routes:
  `GET /api/skills` → `skillsViewSchema`; `GET` and `PUT /api/skills/:name` →
  `skillResultSchema`; `DELETE /api/skills/:name` → 204, removing the skill's grants.
- Naming: `mcpToolName` and `mcpToolNames` give pi's `mcp__<server>__<tool>` (characters outside
  `[A-Za-z0-9_]` become `_`; over 64 characters, or a name tools of a server share, ends in an
  8-hex SHA-256 suffix), assigned in tool-name order so the list's order never changes a name;
  `MCP_TOOL_PREFIX`, which no built-in tool starts with. Names are stable only within a snapshot:
  a new one can rename a tool. `declaredMcpTools` lists what a profile would declare; a save that
  would declare more than `MAX_MCP_DIRECT_TOOLS` = 64 is refused. New `canonical.ts`:
  `canonicalForm` (canonical one-line JSON with keys sorted by code units, and its keys and string
  and number values as `words`, or why there is none: a cycle, depth over
  `CANONICAL_DEPTH_LIMIT` = 64, length over `CANONICAL_LENGTH_LIMIT` = 1 MiB characters, or a value
  JSON cannot hold; it never throws), `canonicalJson` (`string | undefined`) and a
  dependency-free `sha256Hex`.
- `approvalRuleSchema.tool` also takes `mcpToolSelectorSchema` (`mcp__<server>__<tool>` or
  `mcp__<server>__*`). An MCP call keeps two texts: the approval card shows its arguments as
  canonical one-line JSON, and `approvalSubject` (now `string | undefined`) is their unescaped
  `words`, which a rule's `match` is looked for in, so JSON escaping hides nothing from it.
  Arguments without a canonical form fail closed: `matchingApprovalRule` then holds the call
  under the first rule for its tool, whatever its `match`, and `approvalSubjectProblem` says why.
  `matchingApprovalRule` matches a server's `*` (`toolSelectorMatches`), and
  `describeApprovalRule` words it. `mcpRulesWithoutTool` finds exact rules that name no tool of
  their server's pinned snapshot, which a profile save refuses.
- Event `mcp.server` (`profileId`, `server`, `state`: `starting` | `ready` | `failed` | `exited`,
  `durationMs?`, `error?`, `stderrTail?`, `drift?`); `activityFromEvent` shows "Starting MCP
  server x" and then "Using MCP server x".
- `capabilitiesSchema.mcp` (`{ stdio, remote }`) and `.skills`, false when absent;
  `driverCapabilitiesSchema.spawn` (with `DriverCapabilities.spawn` in the driver contract), false
  when absent.
- API error codes `MCP_UNAVAILABLE` (422: a profile asks for MCP servers or skills the server or its
  driver cannot run) and `MCP_SNAPSHOT_MISMATCH` (409: a pinned snapshot was discovered for another
  configuration).

**Action required (frontend):** none to keep working: the profile editor carries `mcpServers` and
`skills` as stored and keeps a stored MCP approval rule's tool among its options, the approval card
shows an MCP call as canonical JSON and says when its arguments could not be checked, and the demo
refuses MCP servers, skills and exact MCP rules like a server without them. The settings UI comes
with #29's later steps.
**Action required (backend):** none in this change: bootstrap reports `mcp` and `skills` false,
every driver reports `spawn: false`, and the API refuses a profile with any MCP server or skill
with `MCP_UNAVAILABLE` instead of storing it, and an exact MCP approval rule with
`VALIDATION_FAILED`, since no snapshot is pinned. The engine steps of #29 lift each refusal as its
capability becomes real.

## 1.6.0 — 2026-11-03 — Approvals for held tool calls

**Changed by:** backend and frontend ([#87](https://github.com/LemonPhase/jj-bot/issues/87), agreed in [this comment](https://github.com/LemonPhase/jj-bot/issues/87#issuecomment-6595622906)) · **Compatibility:** additive

- `approvalRuleSchema` (`{ tool, match? }`, `match` at most `APPROVAL_MATCH_LIMIT` = 200
  characters) and `runtimeProfileSchema.approvals` (at most `MAX_APPROVAL_RULES` = 50, default
  empty), also in `createRuntimeProfileCommandSchema` and, replaced whole,
  `updateRuntimeProfileCommandSchema`, next to 1.5.0's `secrets` grants. The pure matchers `approvalSubject`, `approvalRuleMatches`,
  `matchingApprovalRule` and `describeApprovalRule` decide which calls a rule holds, on the server
  and in the profile editor alike.
- `waitingForSchema` gains `approval`: a session waiting for the user's answer to the call it
  holds.
- `approvalSchema`, `approvalStatusSchema` (`pending`, `approved`, `denied`, `expired`,
  `cancelled`), `approvalOutcomeSchema` (`ok`, `exitCode`, `interrupted`, and `refused` for an
  approved call refused before it ran) and `pendingApprovalSchema` (with `shownInFull`: the
  summary is the whole call, with no character a reader cannot see, so a client may offer
  Approve from it). `pendingApprovalOf` and `shownInFull` build them; `visibleText` writes the
  characters a reader cannot see as code points, and `hasInvisible` finds them.
- `taskSummarySchema.pendingApprovals` and `taskViewSchema.approvals`, both parsed as empty from
  servers before approvals; `applyTaskEvent` folds approvals into the view.
- Events `approval.requested` and `approval.updated`, each carrying the whole record.
- `decideApprovalCommandSchema` (`{ decision: "approve" | "deny", reason? }`, a reason only with a
  denial) for `POST /api/tasks/:taskId/approvals/:approvalId`, which answers `{ approval }`.
- API error code `APPROVAL_NOT_PENDING` (409) for an approval answered, expired or cancelled; a
  stopping or stopped task answers `TASK_TERMINAL` (409).

**Action required (frontend):** show held calls and answer them (task chat card, header badge,
task list, chat task card); edit approval rules in the profile editor. Done in the same change.
**Action required (backend):** none beyond this change; a client built against 1.5.0 that parses
sessions strictly must accept `waitingFor: "approval"`.

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
