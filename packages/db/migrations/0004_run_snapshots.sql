ALTER TABLE "runs" ADD COLUMN "snapshot_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Runs from before this column snapshotted as they ended, except the ones
-- another actor closed: running (a crash), handed back by a graceful stop,
-- closed after a restart, or stopped by the launch guard or lease exhaustion
-- (their notes are in packages/backend/src/worker). Only those rows are
-- written, so the update is short and rewrites nothing else.
UPDATE "runs"
SET "snapshot_pending" = true
WHERE "status" = 'running'
  OR "error" IN (
    'The worker stopped; the session resumes from its last completed turn.',
    'Interrupted by a worker restart; the session resumes from its last completed turn.',
    'Interrupted: the worker stopped and the task was stopped meanwhile.',
    'The session was interrupted too many times (its worker kept stopping) and was given up.'
  );
