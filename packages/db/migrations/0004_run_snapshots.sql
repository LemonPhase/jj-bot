ALTER TABLE "runs" ADD COLUMN "snapshotted_at" timestamp with time zone;--> statement-breakpoint
-- Runs that ended before this column existed count as snapshotted, except the
-- ones a graceful stop handed back or a restart closed after a crash (their
-- notes from worker/outcomes.ts and session-run.ts): those stay null, so the
-- next run of their session still snapshots their files.
UPDATE "runs"
SET "snapshotted_at" = coalesce("finished_at", "started_at")
WHERE "status" <> 'running'
  AND "error" IS DISTINCT FROM 'The worker stopped; the session resumes from its last completed turn.'
  AND "error" IS DISTINCT FROM 'Interrupted by a worker restart; the session resumes from its last completed turn.';
