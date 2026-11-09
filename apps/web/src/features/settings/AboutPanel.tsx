import type { Bootstrap } from "@jj/contracts";
import { useEffect, useId, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { Card, ErrorBanner, Spinner } from "../../components/ui";

/** How long a finished task's activity is kept, as the server reports it. */
export function retentionText(days: number | undefined): string {
  if (days === undefined) return "Not reported by this server";
  if (days === 0) return "Kept for good: compaction is off";
  return `${days} day${days === 1 ? "" : "s"} after a task finishes`;
}

/**
 * Settings → About: the server's contract version and its event retention,
 * read-only. Both are server settings (`JJ_EVENT_RETENTION_DAYS`).
 */
export function AboutPanel() {
  const api = useApi();
  const headingId = useId();
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.bootstrap().then(
      (next) => {
        if (!cancelled) setBoot(next);
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="settings-section__head">
        <h2 className="settings-heading" id={headingId}>
          About this server
        </h2>
      </div>
      {error && (
        <ErrorBanner word="Error">
          The server did not answer: {error}
        </ErrorBanner>
      )}
      {!boot && !error && <Spinner label="Loading…" showLabel />}
      {boot && (
        <Card as="article">
          <dl className="settings-about">
            <dt>Event retention</dt>
            <dd>{retentionText(boot.eventRetentionDays)}</dd>
            <dt>Contract</dt>
            <dd>{boot.contractVersion}</dd>
          </dl>
          <p className="settings-meta">
            Once that long has passed, a completed, failed or cancelled task's
            activity is compacted: output previews and superseded updates are
            removed, while its messages, results, files, checks and usage stay.
            Saved full outputs stay under the task's Artifacts. The server's{" "}
            <code className="settings-code">JJ_EVENT_RETENTION_DAYS</code> sets
            it; 0 turns compaction off.
          </p>
        </Card>
      )}
    </section>
  );
}
