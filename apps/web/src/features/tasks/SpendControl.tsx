import { MAX_SPEND_CAP_USD, type TaskView } from "@jj/contracts";
import { type FormEvent, useId, useState } from "react";
import { useApi } from "../../api/ApiContext";
import {
  Button,
  Dialog,
  ErrorBanner,
  Input,
  StatusSquare,
  Tooltip,
} from "../../components/ui";
import {
  formatCap,
  formatCount,
  spendLevel,
  spendLine,
  tokenTotal,
  unpricedNote,
  usageDetail,
} from "./format";
import "./tasks.css";

/** What a cap input holds: empty is no cap; otherwise an amount the contract accepts. */
export function readCapInput(
  text: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_SPEND_CAP_USD)
    return {
      ok: false,
      error: `Enter an amount above 0 and at most ${MAX_SPEND_CAP_USD}, or leave it empty for no cap.`,
    };
  return { ok: true, value };
}

/**
 * True while the task waits because its own cap, as it is now, refused a
 * model call: a `spend.capped` of the task's scope for the current cap since
 * the user last continued it, with the spend still at or past that cap. A cap
 * raised (or cleared) after the stop no longer counts.
 */
export function stoppedAtCap(view: TaskView): boolean {
  const { task, usage } = view;
  if (task.status !== "waiting" || task.spendCapUsd === null) return false;
  if (usage.total.costUsd < task.spendCapUsd) return false;
  for (let index = view.events.length - 1; index >= 0; index -= 1) {
    const event = view.events[index];
    if (event?.type === "task.reopened") return false;
    if (
      event?.type === "spend.capped" &&
      event.payload.scope === "task" &&
      event.payload.capUsd === task.spendCapUsd
    )
      return true;
  }
  return false;
}

const LEVEL_TONE = {
  ok: undefined,
  warning: "verifying",
  reached: "failed",
} as const;

/**
 * The task header's usage and spend: tokens, cost against the task's cap
 * (amber past the soft threshold, red at the cap), and a dialog that changes
 * the cap. Changing it continues nothing: the user's next message does.
 */
export function SpendControl({ view }: { view: TaskView }) {
  const api = useApi();
  const { task, usage } = view;
  const cap = task.spendCapUsd;
  const level = spendLevel(usage.total.costUsd, cap);
  const unpriced = unpricedNote(usage.total);
  const [editing, setEditing] = useState(false);
  const editable = task.status !== "cancelled" && !task.cancelRequestedAt;

  const tip = [
    usageDetail(usage.total),
    cap === null
      ? "No spend cap."
      : stoppedAtCap(view)
        ? `Stopped at its spend cap of ${formatCap(cap)}: no further model call starts until it is raised.`
        : level === "reached"
          ? `At or past its spend cap of ${formatCap(cap)}: no further model call starts until it is raised.`
          : `Spend cap ${formatCap(cap)}; it counts priced calls only.`,
    ...(unpriced ? [`${unpriced}.`] : []),
  ].join(" ");

  return (
    <>
      <Tooltip content={tip} placement="bottom">
        <button
          type="button"
          className={`ui-badge task-spend task-spend--${level}`}
          // Not disabled: the tip, with the usage breakdown, stays reachable.
          onClick={() => {
            if (editable) setEditing(true);
          }}
          aria-disabled={editable ? undefined : true}
          aria-haspopup={editable ? "dialog" : undefined}
        >
          {LEVEL_TONE[level] && <StatusSquare tone={LEVEL_TONE[level]} />}
          <span className="visually-hidden">Usage: </span>
          {formatCount(tokenTotal(usage.total))} tokens ·{" "}
          {spendLine(usage.total.costUsd, cap)}
          {unpriced && ` · ${usage.total.unpricedCalls} unpriced`}
          {level === "reached" && (
            <span className="task-spend__reached"> · cap reached</span>
          )}
        </button>
      </Tooltip>
      {editing && (
        <SpendCapDialog
          view={view}
          onClose={() => setEditing(false)}
          save={(spendCapUsd) => api.updateTask(task.id, { spendCapUsd })}
        />
      )}
    </>
  );
}

function SpendCapDialog({
  view,
  onClose,
  save,
}: {
  view: TaskView;
  onClose: () => void;
  save: (spendCapUsd: number | null) => Promise<unknown>;
}) {
  const formId = useId();
  const { task, usage } = view;
  const [text, setText] = useState(
    task.spendCapUsd === null ? "" : String(task.spendCapUsd),
  );
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stopped = stoppedAtCap(view);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = readCapInput(text);
    if (!read.ok) {
      setFieldError(read.error);
      return;
    }
    setFieldError(null);
    setBusy(true);
    setFailure(null);
    try {
      await save(read.value);
      onClose();
    } catch (reason) {
      setFailure(
        reason instanceof Error ? reason.message : "The cap was not changed.",
      );
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Spend cap"
      description={`This task has spent ${spendLine(usage.total.costUsd, task.spendCapUsd)} on priced model calls. No model call starts once it reaches the cap.`}
      width={440}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save cap"}
          </Button>
        </>
      }
    >
      <form id={formId} className="new-task-form" onSubmit={submit} noValidate>
        <Input
          label="Spend cap (USD)"
          type="number"
          inputMode="decimal"
          step="any"
          min={0}
          placeholder="No cap"
          hint="Empty for no cap."
          error={fieldError ?? undefined}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {stopped && (
          <p className="new-task-form__note">
            The task stopped at its cap. After raising it, send a message in the
            task chat to continue.
          </p>
        )}
        {failure && <ErrorBanner word="Not saved">{failure}</ErrorBanner>}
      </form>
    </Dialog>
  );
}
