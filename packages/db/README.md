# Durable storage

`openStore` exposes one storage API over embedded PGlite or server PostgreSQL. It creates the idempotent v1 tables on open: namespaced JSONB records, ordered per-task events, and a transaction lock row. Domain validation belongs in the application service before writes.

- `transaction(fn)` atomically reads/writes records and appends events. PostgreSQL takes a shared lock row before application writes; PGlite serializes operations in-process. Job claim/renew/finish decisions must happen inside one transaction, not in a read followed by a later write.
- `read(fn)` provides a consistent read scope and rejects write operations. Transaction handles expire after the callback returns.
- `events(taskId, after)` returns events strictly after the cursor in ascending sequence order. Sequences are allocated within the same transaction as product updates.
- `close()` flushes/closes the underlying store; callers own shutdown.

PGlite takes a file directory (`memory://` for tests). It is a **single owning process** local database: embed the worker with the API. Use server PostgreSQL mode for separate API/worker processes or replicas. The coarse PostgreSQL write lock favors correctness and a small prototype over high write throughput; partitioned locks/indexed domain repositories can follow when load justifies them.

This store does not promise exactly-once external effects. Persist job ownership/idempotency state before tools execute, renew leases, and reconcile ambiguous effects after crashes. Task/session records can use collection namespaces without collapsing their domain identities.

`createDatabase` remains available for direct PostgreSQL/Drizzle access. Do not use it to bypass the store's transaction protocol for competing job/event writes.
