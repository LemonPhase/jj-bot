# Engine (`@jj/backend`)

The JJ Bot engine: domain services (bots, memory, profiles, tasks, messages, chat, artifacts, views) and the worker (job loop, per-task sandboxes, run lifecycle, wakes, steering, stop, recovery, chat replies) over `@jj/db`. `apps/api` is a thin HTTP and SSE layer over it.

## Wiring

The engine depends on its ports in `src/ports.ts`, never on `@jj/runtime` or a concrete driver. The runtime's classes satisfy them (checked at compile time by `src/runtime-ports.test.ts`). The composition the API and the standalone worker share is `openServices` in `apps/api/src/wiring.ts`; in outline:

```ts
const database = await openDatabase(/* pglite or postgres */);
const models = new ModelRegistry({ env, enableScripted });
const engine = await createEngine({
  db: database,
  drivers: createDriverRegistry([
    { driver: new DockerSandboxDriver({ namespace }), label: "Docker" },
    {
      driver: new LocalSandboxDriver({ root, env: {} }),
      label: "Local (unisolated)",
    },
  ]),
  executor: new PiSessionExecutor({ models, outputCapBytes }),
  chat: new ChatResponder({ models, outputCapBytes }),
  models,
  config: configFromEnv(env),
});
await engine.worker.start(); // unless the worker runs in its own process
// On shutdown: await engine.worker.stop(); await database.close();
```

- `createEngine` seeds the default profiles on first boot and returns one method per contract route, each returning that route's response body. Commands are parsed with their contract schemas; refusals throw `DomainError` (`code`, `message`, `details`, `status`).
- The task stream is `engine.tasks.subscribe(taskId, { after, onEvent })`: send each event as an SSE frame (`id` = sequence, `event` = type, `data` = the event) and `close()` on disconnect. The workspace stream is `engine.subscribeHints(handler)`.
- `worker.stop()` hands running work to the next worker; `worker.abandon()` stops like a crash (tests).

## Invariants

- **Records travel with events.** Every task or session change goes through `updateTask`/`updateSession`, which emit `task.updated`/`session.updated` with the whole record in the same transaction; activity is stored exactly as `activityFromEvent` folds it. A view plus later events folds into a fresh view.
- **Every write-back is fenced.** A run's writes start with `heartbeat(tx, lease)`; once the lease is lost nothing more is written. Write transactions lock the task row first.
- **No lost wakes.** An inbox item that should wake its session is inserted in the same transaction as its `session.run` enqueue. A running session drains its inbox at each turn boundary, and the end-of-run write-back re-checks the inbox under the task lock and continues the run when a brief, result or steering arrived.
- **Visibility is not activation.** Only briefs, results and steering start or continue a run. A plain `message` is delivered to the addressee's active session without a wake and rides along with its next run; a coalesced wake whose input was already taken completes as a no-op even if a message is waiting.
- **Delegation is a child session.** The brief is the child's `brief` and goes in its system prompt (last, under `## Your brief`), which is rebuilt every run, so context compaction never paraphrases it; the brief inbox item that starts the child only points at it, while the task chat's assignment message carries the brief as written. When the assignee has already reported to the delegating session, that item starts with a handoff note (`worker/handoff.ts`): `readLatestReport` picks the bot's latest session under the same parent that completed or failed, and `formatHandoffNote` quotes its id, brief and report or error, redacted and then clipped, with the `read_report` call that shows them in full. The note is built once in the `delegate` transaction and stored only in that inbox item. Results and failures reach the parent inbox with the first line `Result from <bot> (session <id>):` or `Failure from <bot> (session <id>):`. A parent with open children waits (`waitingFor: delegations`) and holds no job; a coordinator's text at that point is posted as a discussion message.
- **Task lookup is read-only and task-scoped.** Every task session gets `task_state`, `task_log`, `read_entry` and `read_report` (`worker/lookup-tools.ts`) over `services/task-log.ts`, which reads one task's state, log and session briefs and reports by task id, and never a transcript. Entry ids are task message ids. An entry's kind comes from one SQL expression over the message's intent, author and relay (steering or relayed from direct chat: `user`; assignment: `brief`; result or system: `report`; otherwise `message`), so filters and labels agree. `listTaskLog` pages from the oldest or the newest entry, after or before an entry id, and counts the matches on either side of the page. The formatters (`indexLine`, `formatTaskLogPage`, `formatEntry`, `formatTaskState`, `formatSessionReport`) are the one text format, and each takes the redactor and redacts before it clips. The tools' definitions are constants; a NUL in an argument or a failed read is a plain refusal; the runtime caps and spills the result like any tool output.
- **Completion.** Only the root coordinator has `complete_task`. It is refused while delegations are open, while a stop is requested, or when the session's goal version is behind the task's. Any input the session takes after recording a completion voids it, across hand-offs and crashes too. A coordinator that ends its turn with nothing open and no completion posts its text and the task waits for the user.
- **Stop is two-phase.** The request sets `cancelRequestedAt`, cancels queued jobs and tells running runs to abort (a sandbox still starting is aborted too). Nothing launches afterwards: the run-start transaction refuses a session whose task is stopping or finished, or whose parent has finished, and the heartbeat tick stops such runs. When no run is active the task is cancelled with `cancellation.completed` (`stopped` from each run's interrupted command, `neverStarted` for sessions that never ran).
- **One sandbox per task** in a worker, acquired with the coordinator's profile (`workspaceKey = taskId`). It is released when the task finishes (checked against the database, so a task finished on another worker counts) or after `sandboxIdleMs` unused, ephemeral ones included.
- **Ephemeral workspaces** live only in the sandbox that created them. The holding worker records itself on the task (`tasks.sandbox_holder`, a lease refreshed by its heartbeat tick and cleared on release). A session whose task already used one, claimed by another worker, is handed back while that lease is live; otherwise it fails visibly with the reason (released here, or a restart or a stopped holder).
- **Recovery.** A reclaimed job resumes with reason `recovery` from the persisted transcript; the crashed run is closed as failed and its unfinished tools are reported `interrupted: unknown`. Inbox items stay undelivered until the executor persists them, so a crash re-delivers them. Lease-exhausted jobs fail their session visibly.
- **Artifacts.** A run's snapshot stores the files modified since it started, one transaction each, deduplicated by path and SHA-256 per task (at most `maxFilesPerRun` = 50 new artifacts per snapshot, counted after deduplication; `maxFileBytes` = 5 MiB each; 2000 entries listed; `node_modules`, `.git`, `dist`, `build`, `.cache` and `.tmp` skipped). Every run starts with `runs.snapshot_pending` set, and a snapshot that records its files clears it. A run handed back by a graceful stop or cut off by a crash stays pending, so its session's next snapshot reaches back to the earliest pending run's start. When a task finishes, a worker still holding its sandbox takes a final snapshot of the task's remaining pending runs before releasing it; with no sandbox held, nothing is recorded and the runs stay pending. A file is credited to the run whose successful `write`/`edit` call last touched it, among the covered runs and the task's other finished pending runs; other changed files are stored at task level (no session or run), except those a still-running teammate's `write`/`edit` call touched or is still touching (started, its result not yet recorded) that changed no earlier than that run's start less the skew: that run's own scan reaches them, and credits them when it ends. An older file such a call names (it failed, or has not written yet) is stored now, so no file is left to a scan that cannot see it. Credits are read once the scan has read its first file; deciding on a file no one is credited with, the snapshot reads them again, inside the transaction that would store it and under the task lock, if a `write` or `edit` call started since. The scan allows 2 s of clock skew against run start times that other workers may have written, so worker and sandbox clocks must be NTP-synced. Tool output over `JJ_OUTPUT_CAP_BYTES` becomes an `output` artifact and the event keeps a capped preview.
- **Direct chat.** Side effects are keyed by the user message being answered, so a reply that runs again after a hand-off or crash repeats none: `create_task` makes at most one task per message (`tasks.created_from_message_id`, unique per bot) and `send_to_task` relays at most once per message and task (`task_messages.relayed_from_message_id`). `create_task` locks the bot row before counting the tasks it created in the last hour (`JJ_TASKS_PER_BOT_PER_HOUR`). Rosters and active tasks are enums in the tool schemas.

## Tests

`npm test` runs the suites on PGlite with the `local` driver and a deterministic `FakeExecutor` (`src/testing/`). `JJ_TEST_DATABASE_URL` switches them to PostgreSQL (each suite creates and drops its own database). The docker variant skips without a reachable daemon.
