import { MAX_SPEND_CAP_USD, SPEND_SOFT_THRESHOLD } from "@jj/contracts";
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

/** The share of a cap past which the question is asked, as people read it: "80%". */
export const THRESHOLD_PERCENT = `${Math.round(SPEND_SOFT_THRESHOLD * 100)}%`;

/**
 * The option to be asked before a task spends past 80% of its cap: no model
 * call starts there until the user approves it in the task.
 */
export function SpendQuestion({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="task-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      Ask before spending past {THRESHOLD_PERCENT} of a cap
    </label>
  );
}
