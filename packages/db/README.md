# Storage (`@jj/db`)

Relational storage for the engine: the Drizzle schema, SQL migrations applied on open, per-task and per-bot sequence allocation, the job queue and the LISTEN/NOTIFY bus. It is infrastructure only: no domain rules or state machines. The engine queries the exported tables with Drizzle directly.

## Opening

`openDatabase(config)` returns `{ mode, db, bus, close }`. `config` is one of:

- `{ mode: "pglite", path? }`: a data directory, or `memory://` (the default).
- `{ mode: "postgres", connectionString, poolSize?, lockTimeoutMs?, idleInTransactionTimeoutMs?, bus? }`.

Both modes take an optional `onError` for errors that have no caller: pool clients that the server disconnects, bus listener drops and missed pings, malformed notifications, and handlers that throw. It defaults to `console.error`.

- Migrations are applied before `openDatabase` resolves. On PostgreSQL, openers serialize on a session advisory lock, so processes booting at once against an empty database are safe.
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
- Records owned by a parent are deleted with it: a task's sessions, runs, inbox, messages, events, artifacts, usage and jobs, and a bot's memory and conversation. References to bots and runtime profiles do not cascade, so deleting a bot that coordinates or participates, or a profile that bots use, is refused. A bot is never silently moved to another profile.
- Attribution columns on append-only records are plain ids, not foreign keys. These are the bot, session and run ids on `task_events`, `task_messages`, `session_entries`, `artifacts` and `usage`, and also `caused_by`, `session_inbox.source_message_id` and `conversation_messages.task_id`. Those rows are append-only and are removed with the record that owns them; keeping the attribution as plain ids keeps the logs immutable and their inserts cheap.
- Active bot names are unique per owner, ignoring case, because tools address bots by name. An archived bot (`archived_at` set) keeps its history and frees its name. Each owner has at most one default runtime profile.
- `sessions.waiting_for` (`delegations` or `user`) is set exactly when `status = 'waiting'`. `tasks.cancel_requested_at` marks a requested stop until the task is cancelled.
- `tasks.created_by_bot_id` is the bot that created the task from direct chat; it is null when the user created the task. The per-bot hourly limit counts it, using the `(created_by_bot_id, created_at)` index. To keep the count honest under concurrent requests, the engine locks the bot row (`SELECT … FOR UPDATE`) before it counts and inserts.
- `artifacts.content` holds the bytes. Select columns explicitly when listing artifacts.

To change the schema, edit `src/schema.ts`, run `npm run db:generate -w @jj/db`, and commit the new SQL in `migrations/` together with `migrations/meta`. Never edit a migration that has been applied; add a new one. All pending migrations apply in one transaction.

## Sequences

`appendEvent(tx, input)` allocates the next per-task sequence with `UPDATE tasks SET event_seq = event_seq + 1 … RETURNING`, inserts the event (the event takes the task's owner, and `occurred_at` is set after the lock is taken), and sends `jj_task_event` (`taskId:sequence`). All three happen in the caller's transaction. `nextMessageSequence(tx, taskId)` and `nextConversationSequence(tx, botId)` allocate the same way for `task_messages` and `conversation_messages`; insert the row in the same transaction. `listEvents(exec, taskId, { after, limit })` replays events strictly after a cursor.

- The allocation row-locks that task or bot until commit. Writers to one task serialize, sequences have no gaps (a rollback releases its number), and writers to other tasks never wait.
- Keep these transactions short. A transaction that locks several rows should take them in a consistent order so that two such transactions cannot deadlock: bots, then tasks, then jobs (an enqueue), with ids ascending.
- Unknown ids throw `RecordNotFoundError`.

## Job queue

Pass `db` for autocommit, or a `tx` to make the job change atomic with other writes. Every operation is one SQL statement, except `claim`, which is two.

- `enqueue(exec, job)` inserts a queued job and returns it, or returns `null` when it was coalesced. `session.run` requires `sessionId`, and `chat.reply` requires `botId`.
- `claim(exec, owner, limit, leaseMs)` returns `{ jobs, exhausted }`:
  - It takes due queued jobs, and running jobs whose lease expired and that have attempts left, with `FOR UPDATE SKIP LOCKED`. Two claimers never get the same job and never wait on each other. Jobs are returned oldest `run_after` first, and times use the database clock.
  - Each claim increments `attempts`, which is also the lease generation. Each claimed job carries `lease = { jobId, owner, attempt, kind }`.
  - An expired job that already used `max_attempts` claims (default 3, set per enqueue with `maxAttempts`) is not reclaimed. It is marked `failed` with `last_error = LEASE_EXHAUSTED_ERROR`, and returned once in `exhausted`. The caller then fails that session or chat visibly. The row stays in that state, so recovery can find it.
- `heartbeat(exec, lease, leaseMs)`, `complete(exec, lease)` and `fail(exec, lease, error, retryAt?)` act only while that exact lease holds: same job, owner and attempt, with status `running`. They return `false` otherwise, even to the same owner after a reclaim, and the caller must then stop without writing results. A holder whose lease expired without being reclaimed can still extend it.
- A write-back must re-check the lease. Start the write-back transaction with `heartbeat(tx, …)`. It returns `false` if the lease was lost, and otherwise it row-locks the job until commit, so a reclaim cannot interleave.
- `cancelWhere(exec, { taskId } | { sessionId })` cancels queued jobs only. Running jobs are left to their owners, which observe the cancellation and stop.
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

The store tests always run on PGlite. When `JJ_TEST_DATABASE_URL` is set, they also run on PostgreSQL, including the concurrency tests: concurrent migrators, competing claimers, wakers racing workers on one session and one bot, 50 concurrent appends, the cross-task lock checks, session timeouts and listener reconnects. Each PostgreSQL suite creates and drops its own database on that server, so the user needs the `CREATEDB` privilege.

## Legacy store

`openStore` (`src/legacy-store.ts`) is the earlier JSONB record store with a global write lock, still used by the current backend. Its tables (`jj_records`, `jj_events`, `jj_write_lock`) are separate from this schema. It is deleted when the engine rewrite lands, and new work should not use it.
