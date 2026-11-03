import {
  type Artifact,
  latestAttemptChecks,
  type TaskView,
  type VerificationCheck,
  type VerificationCriterion,
  verificationSummary,
} from "@jj/contracts";
import { useId, useMemo, useState } from "react";
import { useApi } from "../../api/ApiContext";
import {
  Badge,
  Button,
  SectionLabel,
  StatusSquare,
  Tooltip,
} from "../../components/ui";
import { acceptsMessages } from "../../lib/status";
import { ArtifactRows } from "./ArtifactList";
import { ChecksDialog } from "./ChecksDialog";
import {
  checkMeta,
  criterionRule,
  OUTCOME_TONE,
  supersededVersions,
  verificationDisplay,
} from "./verification";

/** The task's verification summary and its display, from the open view. */
export function useVerification(view: TaskView) {
  return useMemo(() => {
    const summary = verificationSummary(view.task, view.verificationChecks);
    return { summary, display: verificationDisplay(view.task, summary) };
  }, [view.task, view.verificationChecks]);
}

/**
 * The header badge: "verified · 3/3", "failed · 1/3", "not checked · 0/2".
 * Shown only for a task with a plan; its tooltip says what the word means.
 */
export function VerificationBadge({ view }: { view: TaskView }) {
  const { display } = useVerification(view);
  if (!display) return null;
  return (
    <Tooltip content={display.sentence} focusable placement="auto">
      <Badge tone={display.tone} className="verification-badge">
        <span className="visually-hidden">Verification: </span>
        {display.word} · {display.count}
      </Badge>
    </Tooltip>
  );
}

/** "Checks" in the header: opens the plan editor while the task takes messages. */
export function ChecksButton({ view }: { view: TaskView }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  if (!api.capabilities.verification || !acceptsMessages(view.task))
    return null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        {view.task.verificationPlan ? "Edit checks" : "Add checks"}
      </Button>
      {open && <ChecksDialog view={view} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The Progress view's verification (shown for a task with a plan, or one
 * with evidence from an earlier version): each criterion of the current plan
 * with its latest check (outcome, exit code, duration, attempt, what was
 * observed, the output and its full artifact), then the checks of earlier
 * goal versions, marked superseded.
 */
export function VerificationSection({ view }: { view: TaskView }) {
  const labelId = useId();
  const { display } = useVerification(view);
  const plan = view.task.verificationPlan;
  const current = latestAttemptChecks(
    view.verificationChecks,
    view.task.goalVersion,
  );
  const earlier = supersededVersions(
    view.verificationChecks,
    view.task.goalVersion,
  );
  if (!plan && earlier.length === 0) return null;
  return (
    <section className="verification" aria-labelledby={labelId}>
      <div className="verification__head">
        <SectionLabel as="h2" id={labelId}>
          Verification · goal v{view.task.goalVersion}
        </SectionLabel>
        {display && (
          <span className="verification__state">
            <StatusSquare tone={display.tone} />
            {display.word} · {display.count}
          </span>
        )}
      </div>
      {display && <p className="verification__sentence">{display.sentence}</p>}
      {plan ? (
        <ul className="verification__list">
          {plan.map((criterion) => (
            <CriterionRow
              key={criterion.id}
              view={view}
              criterion={criterion}
              check={current.find(
                (check) => check.criterionId === criterion.id,
              )}
            />
          ))}
        </ul>
      ) : (
        <p className="verification__sentence">
          No plan for this goal version: the task completes without checks and
          is not shown as verified.
        </p>
      )}
      {earlier.map((version) => (
        <details key={version.goalVersion} className="verification__earlier">
          <summary>
            Goal v{version.goalVersion} · superseded ·{" "}
            {
              version.checks.filter((check) => check.outcome === "passed")
                .length
            }
            /{version.checks.length} passed
          </summary>
          <ul className="verification__list">
            {version.checks.map((check) => (
              <CheckRow key={check.id} view={view} check={check} />
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

function CriterionRow({
  view,
  criterion,
  check,
}: {
  view: TaskView;
  criterion: VerificationCriterion;
  check: VerificationCheck | undefined;
}) {
  return (
    <li className="verification__item">
      <span className="verification__title">
        <StatusSquare tone={check ? OUTCOME_TONE[check.outcome] : "idle"} />
        <span className="verification__desc">{criterion.description}</span>
        <span className="verification__outcome">
          {check ? check.outcome : "not checked"}
        </span>
      </span>
      <span className="verification__rule">{criterionRule(criterion)}</span>
      {check && <CheckEvidence view={view} check={check} />}
    </li>
  );
}

function CheckRow({
  view,
  check,
}: {
  view: TaskView;
  check: VerificationCheck;
}) {
  return (
    <li className="verification__item">
      <span className="verification__title">
        <StatusSquare tone={OUTCOME_TONE[check.outcome]} />
        <span className="verification__desc">{check.criterionId}</span>
        <span className="verification__outcome">{check.outcome}</span>
      </span>
      <CheckEvidence view={view} check={check} />
    </li>
  );
}

/** What a check observed: its meta line and detail, then its output and artifact. */
function CheckEvidence({
  view,
  check,
}: {
  view: TaskView;
  check: VerificationCheck;
}) {
  const artifact: Artifact | undefined = check.artifactId
    ? view.artifacts.find((entry) => entry.id === check.artifactId)
    : undefined;
  return (
    <>
      <span className="verification__meta">{checkMeta(check)}</span>
      <span className="verification__detail">{check.detail}</span>
      {check.output !== null && check.output.trim() !== "" && (
        <details className="verification__output">
          <summary>Output{check.truncated ? " (head and tail)" : ""}</summary>
          <pre>{check.output}</pre>
        </details>
      )}
      {artifact && <ArtifactRows view={view} artifacts={[artifact]} />}
    </>
  );
}
