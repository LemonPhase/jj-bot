# Storage (`@jj/db`)

Relational storage for the engine: the Drizzle schema, SQL migrations applied on open, per-task and per-bot sequence allocation, the job queue and the LISTEN/NOTIFY bus. It is infrastructure only: no domain rules or state machines. The engine queries the exported tables with Drizzle directly.

## Opening

`openDatabase(config)` returns `{ mode, db, bus, close }`. `config` is one of:

- `{ mode: "pglite", path? }`: a data directory, or `memory://` (the default).
- `{ mode: "postgres", connectionString, poolSize?, lockTimeoutMs?, idleInTransactionTimeoutMs?, bus? }`.

Both modes take an optional `onError` for errors that have no caller: pool clients that the server disconnects, bus listener drops and missed pings, malformed notifications, and handlers that throw. It defaults to `console.error`.

- Migrations are applied before `openDatabase` resolves. On PostgreSQL, openers serialize on a session advisory lock, so processes booting at once against an empty database are safe.
- A PostgreSQL database must be encoded as UTF8 (`server_encoding`); PGlite always is. Migration 0012 refuses any other encoding before it changes anything: its character patterns mean characters only in UTF8, and on SQL_ASCII they would corrupt valid text such as `€uro`.
- Migrations are forward-only. Before applying any, `openDatabase` reads the migration record and refuses a database that records a migration newer than the newest this build ships, with `SchemaTooNewError` ("This database was written by a newer version of JJ Bot: …"), on PGlite and inside PostgreSQL's advisory lock; nothing is applied or changed. `readSchemaLevel(exec)` returns that record against the shipped migrations (applied, the newest applied tag, pending, newer), and `migrationStatus` its counts for readiness.
- `inspectDatabase(where, read)` runs `read` on a database of any schema version without migrating it, in read-only sessions, then closes it: the data check (`npm run data:check`) reads a restored backup this way. It refuses a PGlite directory that holds no database rather than create one, and locks one that does.
- PGlite runs in-process on a single connection, so it is single-process. A data directory is locked to the process that opens it by `jj-db.lock` (opened `wx`, holding the pid). A second open while that pid is alive fails with `DatabaseInUseError`; a lock left by a dead pid is taken over. Use PostgreSQL for a separate worker, or for replicas.
- On PostgreSQL, pooled connections set `lock_timeout` (`lockTimeoutMs`, default 10 s) and `idle_in_transaction_session_timeout` (`idleInTransactionTimeoutMs`, default 60 s); 0 disables either. A statement stuck waiting on a lock, or a transaction left open, therefore fails instead of hanging. Migrations wait on their advisory lock without a timeout.
- `close()` closes the bus, then the pool or PGlite, and releases the PGlite lock. It resolves once the connections have closed. Repeat calls are safe; callers own shutdown.

`Db` is the Drizzle database for either driver, `Tx` is a transaction from `db.transaction(...)`, and `Executor` is either one. Inside a transaction callback, use only `tx`. On PGlite, using the top-level `db` (or `bus.subscribe`) inside a transaction throws a "use the transaction handle" error, because on one connection it would wait forever. On PostgreSQL the same call runs on another connection, so it is bounded by `lock_timeout` if it waits on a row that the transaction holds.

## Schema

`src/schema.ts` defines every table, exports each table plus `tables`, and exports row types (`TaskRow`, `NewTask`, …) and the string unions (`TaskStatus`, `JobStatus`, …).

- Columns are snake_case. Ids are text in the form `prefix_ULID`, from `newId(kind)`: time-sortable and monotonic within a process. The database never generates ids.
- Every domain table has `owner_id` (default `'local'`), so multi-user support is additive. `jobs` is queue infrastructure and has none.
- `timestamptz` columns read as `Date`, `jsonb` as typed objects, and `bytea` as `Uint8Array` on both drivers.
- Status, kind, role and intent columns are text with CHECK constraints built from the constant unions in `schema.ts`. Adding a value is a schema change. Event `type` is open.
- Records owned by a parent are deleted with it: a task's sessions, runs, inbox, messages, events, artifacts, verification checks, usage, jobs and chat task updates, and a bot's memory, conversation and chat task updates. References to bots and runtime profiles do not cascade, so deleting a bot that coordinates or participates, or a profile that bots use, is refused. A bot is never silently moved to another profile.
- Attribution columns on append-only records are plain ids, not foreign keys. These are the bot, session and run ids on `task_events`, `task_messages`, `session_entries`, `artifacts` and `usage`, and also `caused_by`, `session_inbox.source_message_id` and `conversation_messages.task_id`. Those rows are append-only and are removed with the record that owns them; keeping the attribution as plain ids keeps the logs immutable and their inserts cheap.
- Active bot names are unique per owner, ignoring case, because tools address bots by name. An archived bot (`archived_at` set) keeps its history and frees its name. Each owner has at most one default runtime profile.
- Bot names and roles are one line of plain text, as the contract's schema requires. Migration 0012 normalised those stored before that rule, archived bots' too, refusing the contract's exact set of characters (a test compares the two over every code point): each run of refused characters became one space and the value was trimmed (an empty name became `Bot`; an empty role stayed empty), and an active bot whose new name another active bot of its owner held, ignoring case, took the first free ` (2)`, ` (3)`, …, the oldest renamed bot first, within 60 characters. Names that were already valid did not change, and roles took no number. Only the bot records changed: text stored before the upgrade keeps the old names and roles as they were, in queued inbox items, first inputs, approval texts and transcripts.
- `sessions.waiting_for` (`delegations`, `user` or `approval`) is set exactly when `status = 'waiting'`. `tasks.cancel_requested_at` marks a requested stop until the task is cancelled.
- `tasks.created_by_bot_id` is the bot that created the task from direct chat; it is null when the user created the task. The per-bot hourly limit counts it, using the `(created_by_bot_id, created_at)` index. To keep the count honest under concurrent requests, the engine locks the bot row (`SELECT … FOR UPDATE`) before it counts and inserts.
- `tasks.created_from_message_id` and `task_messages.relayed_from_message_id` record the conversation message whose reply created the task or relayed the message. They are unique per creating bot and per task, so a chat reply that runs again after a hand-off or crash repeats neither.
- `conversation_messages.handled_at` is set on a user message once a chat reply has taken it up, answered or failed; one that arrives during a reply stays null until the next reply answers it. A partial index on `(bot_id, sequence)` finds a bot's waiting messages.
- `verification_checks` holds verification evidence, append-only: one row per criterion evaluated at one gate attempt of one goal version, unique on `(task_id, goal_version, attempt, criterion_id)`, with its plan `position`, outcome, exit code, interruption, duration, detail, output preview and the `output` artifact holding its full output (an attribution id, like its session and run). A check constraint refuses a passing command check without exit code 0 and no interruption. The plan itself is jsonb on `tasks.verification_plan` (the current goal version's) and `task_goal_versions.verification_plan` (each version's). Rows go with their task.
- `chat_task_updates` holds what a coordinator's direct chat is told: one row per task event (`completed`, `failed` or `waiting` for the user, or `approval` for a call waiting for the user's approval, with its `approval_id`), unique on `(task_id, task_event_seq)`, with the result, error or question as stored then. `answered_at` is null while it is pending; it is set with `message_id` when a chat reply (or the engine's fallback) tells it, or alone when a later event of its task overtook it. The partial index on `(bot_id, created_at)` finds a bot's pending updates. A chat reply job records in `payload.answering` the message or update it answers; `jobs_chat_reply_answering_idx` on `(bot_id, payload->>'answering')` lets the conversation view find the reply to a message. Rows go with their task or bot.
- `tasks.spend_cap_usd` is the task's spend cap in US dollars, null for none; migration 0006 gave the tasks before it the default $5. `usage.priced` is false for a call on a model with no listed price, whose `cost_usd` is then 0 and its real cost unknown; 0006 set it false on earlier rows with tokens but no cost. `usage (bot_id, created_at)` and `usage (created_at)` serve the spend guard's rolling 24 hours.
- `approvals` holds the calls a run held for the user's approval: one row per session and tool call (`approvals_session_call`), at most one `pending` per session (the partial unique index `approvals_one_pending`), with the call's redacted `args`, its `rule`, the goal version and the answer (`status`, `reason`, `decided_at`). `started_at` and `started_run_id` are set once, when a run claims the approved call; `outcome` when its result is stored; `resolved_at` when the decision's result reached the session's transcript, so a run applies it once. Rows go with their task and session; `runtime_profiles.approvals` holds a profile's rules (empty by default).
- `tasks.sandbox_holder` and `sandbox_holder_until` name the worker holding the task's ephemeral sandbox and how long that claim lasts; the holder refreshes it and clears it on release.
- `runs.snapshot_pending` is true from a run's insert until an artifact snapshot has recorded its files. It stays true for a run handed back by a graceful stop or cut off by a crash; the session's next snapshot, or the task's final one, covers it.
- `artifacts.content` holds the bytes. Select columns explicitly when listing artifacts.
- `secrets` holds values entered in settings, keyed by `(owner_id, kind, name)`: `provider` keys named by provider id and `sandbox` secrets named by their variable. Values are stored as ciphertext: `nonce`, `ciphertext` (AES-256-GCM, tag appended, so its length gives the value's) and `key_id`, which names the master key that sealed it; `hint` is the value's last four characters, kept readable. The master key is never in the database. `runtime_profiles.secrets` lists the sandbox secrets a profile grants, by name; the engine removes a name from every profile when its secret is removed.
- `retired_secrets` keeps values `secrets` no longer holds (replaced or removed), for redaction only: one row per value of a name (`id`, the `kind` and `name` it had, and `retired_at`, which retiring the value again moves), sealed like `secrets` but with this table in the associated data, so a ciphertext moved between the tables does not open. Rows older than 90 days, and those of a name past its 10 most recently retired, are deleted at boot and whenever a value is retired.
- `runtime_profiles.mcp_servers` holds a profile's MCP servers (empty by default). `mcp_tool_snapshots` holds the reviewed tool list of one server of one profile for one configuration (`config_hash`), written once and never updated. `mcp_discoveries` holds each test of a server configuration: the configuration tested (`config`, secrets by name only), its `config_hash`, `status` (`queued`, `running`, `succeeded`, `failed`), the redacted `error` and `stderr_tail`, its `snapshot_id` (only a succeeded one holds one; a deleted snapshot sets it null), `duration_ms` and its times; an `mcp.discover` job names it in `payload.discoveryId`. A server of a profile has at most one discovery `queued` or `running` (the partial unique index `mcp_discoveries_one_active`). Both go with their profile.
- `instance_settings` holds instance-wide values the server creates for itself, by key, such as the generated API token (`api_token`). It has no owner. `instanceSetting(exec, key, initial)` returns the stored value, creating it with `initial()` once; concurrent first calls, across processes too, agree on one value.
- `worker_heartbeats` has one row per live job loop, keyed by worker id, with `started_at` and `seen_at` in the database clock, so processes on different hosts agree on its age. It has no owner. `recordWorkerHeartbeat` upserts `seen_at = now()`, `removeWorkerHeartbeat` deletes the row of a worker that stopped, `pruneWorkerHeartbeats` deletes rows not seen for a while, and `workerHeartbeatStatus(exec, freshMs)` counts the rows seen within `freshMs` and gives the newest one's age, for readiness.

To change the schema, edit `src/schema.ts`, run `npm run db:generate -w @jj/db`, and commit the new SQL in `migrations/` together with `migrations/meta`. Never edit a migration that has been applied; add a new one, which the data already in the field must pass through (a new `NOT NULL` column needs a default or a backfill). All pending migrations apply in one transaction.

## Sequences

`appendEvent(tx, input)` allocates the next per-task sequence with `UPDATE tasks SET event_seq = event_seq + 1 … RETURNING`, inserts the event (the event takes the task's owner, and `occurred_at` is set after the lock is taken), and sends `jj_task_event` (`taskId:sequence`). All three happen in the caller's transaction. `nextMessageSequence(tx, taskId)` and `nextConversationSequence(tx, botId)` allocate the same way for `task_messages` and `conversation_messages`; insert the row in the same transaction. `listEvents(exec, taskId, { after, limit })` replays events strictly after a cursor.

- The allocation row-locks that task or bot until commit. Writers to one task serialize, sequences have no gaps (a rollback releases its number), and writers to other tasks never wait.
- Keep these transactions short. A transaction that locks several rows should take them in a consistent order so that two such transactions cannot deadlock: bots, then tasks, then jobs (an enqueue), with ids ascending.
- Unknown ids throw `RecordNotFoundError`.

## Job queue

Pass `db` for autocommit, or a `tx` to make the job change atomic with other writes. Every operation is one SQL statement, except `claim`, which is two.

- `enqueue(exec, job)` inserts a queued job and returns it, or returns `null` when it was coalesced. `session.run` requires `sessionId`, and `chat.reply` requires `botId`.
- `claim(exec, owner, limit, leaseMs, { running, kinds })` returns `{ jobs, exhausted }`:
  - With `kinds`, it claims only jobs of those kinds; exhausted jobs of every kind are still failed and returned. The worker claims session runs and chat replies first, and MCP discoveries only into slots of their own.
  - It takes due queued jobs, and running jobs whose lease expired and that have attempts left, with `FOR UPDATE SKIP LOCKED`. Two claimers never get the same job and never wait on each other. Jobs are returned oldest `run_after` first, and times use the database clock.
  - Each claim increments `attempts`, which is also the lease generation. Each claimed job carries `lease = { jobId, owner, attempt, kind }`.
  - `running` lists the jobs the claimer is still running. They are neither reclaimed nor failed as exhausted by that claim, even once their lease expired: their owner is alive, its heartbeats only fell behind, and it can still extend the lease. Another claimer takes them over as usual.
  - An expired job that already used `max_attempts` claims (default 3, set per enqueue with `maxAttempts`) is not reclaimed. It is marked `failed` with `last_error = LEASE_EXHAUSTED_ERROR`, and returned once in `exhausted`. The caller then fails that session or chat visibly. The row stays in that state, so recovery can find it.
- `heartbeat(exec, lease, leaseMs)`, `complete(exec, lease)` and `fail(exec, lease, error, retryAt?)` act only while that exact lease holds: same job, owner and attempt, with status `running`. They return `false` otherwise, even to the same owner after a reclaim, and the caller must then stop without writing results. A holder whose lease expired without being reclaimed can still extend it.
- A write-back must re-check the lease. Start the write-back transaction with `heartbeat(tx, …)`. It returns `false` if the lease was lost, and otherwise it row-locks the job until commit, so a reclaim cannot interleave.
- `cancelWhere(exec, { taskId } | { sessionId })` cancels queued jobs only. Running jobs are left to their owners, which observe the cancellation and stop.
- `queueDepth(exec)` counts queued jobs whose `run_after` has passed, by kind, for the metrics.
- Delivery is at least once. A reclaimed job runs again, and the engine resumes from durable state.

### One run per session, without losing wakes

At most one `session.run` is queued and at most one is running per session, enforced by partial unique indexes. The same holds for `chat.reply` per bot.

- Coalescing. Enqueueing while one is already queued inserts nothing and returns `null`, because the pending job will see everything committed before it runs. The coalescing enqueue row-locks the pending job until the caller commits, so the job cannot be claimed, and its inbox read, before the new work is visible. A plain `ON CONFLICT DO NOTHING` would leave that window open and could lose a wake.
- Ordering. `claim` skips a queued job whose session (or bot) has one running. The next run starts only after the current one ends, and the running index never makes a claim fail.
- Engine rules:
  - Always enqueue the wake in the same transaction as the inbox item or user message it is for.
  - A run drains everything undelivered. A run whose inbox turns out to be empty completes as a no-op.
  - `fail(…, retryAt)` refuses to requeue these kinds, because a requeued job would collide with a pending wake. Fail or complete the job and enqueue a new one.

## Bus

`bus.subscribe(channel, handler)` resolves once the channel is being listened to, and returns an async unsubscribe. `bus.notify(exec, channel, message)`, or the standalone `notify`, sends with `pg_notify` through `exec`. PGlite and PostgreSQL share the same code path, with only the listening connection differing.

| Channel         | Message                                                       | Wire format       |
| --------------- | ------------------------------------------------------------- | ----------------- |
| `jj_task_event` | `{ taskId, sequence }`, sent by `appendEvent`                 | `taskId:sequence` |
| `jj_control`    | `{ kind: "steer" \| "cancel" \| "wake", taskId, sessionId? }` | JSON              |
| `jj_hint`       | `{ kind, ... }` workspace hint                                | JSON              |

- A notification sent in a transaction is delivered only after commit and never after a rollback. Persist first; the notification only says where to look.
- Notifications are hints, not data. Subscribe first, then read durable rows, for example events after a cursor, so that nothing is missed in between. Payloads are limited to 7999 bytes.
- On PostgreSQL the bus listens on one dedicated connection outside the pool (`application_name = jj-bus-listener`, TCP keepalive on), opened on the first subscription. It runs `SELECT 1` every `bus.pingIntervalMs` (default 30 s); a ping slower than `bus.pingTimeoutMs` (default 10 s) counts as a dead connection. When the connection errors, ends or misses a ping, the bus reconnects with backoff, listens again and calls the `bus.onReconnect` handlers. Notifications sent while it was down are lost, so those handlers re-read state.
- A malformed payload, or a handler that throws, goes to `onError` and does not affect other handlers.

## Tests

The upgrade tests (`src/upgrade.test.ts`, and `apps/api/src/upgrade.test.ts` through the server) start from `PREVIOUS_RELEASE` in `src/testing.ts`: the previous release's newest migration and a fixture of data its build wrote through its own API (`fixtures/`, never edited). `@jj/db/testing` exports it, with `seedPreviousRelease(location)`, which migrates a new database to that level the way that build did and loads the fixture. They open it through `openDatabase` and check that every record keeps every value, the current schema reads every table, the backfills, that counters carry on, and that the schema equals a new install's; the newer-schema refusal is tested on both drivers. Each release moves `PREVIOUS_RELEASE` forward with a fixture its own build writes.

The store tests always run on PGlite. When `JJ_TEST_DATABASE_URL` is set, they also run on PostgreSQL, including the concurrency tests: concurrent migrators, competing claimers, wakers racing workers on one session and one bot, 50 concurrent appends, the cross-task lock checks, session timeouts and listener reconnects. Each PostgreSQL suite creates and drops its own database on that server, so the user needs the `CREATEDB` privilege.
