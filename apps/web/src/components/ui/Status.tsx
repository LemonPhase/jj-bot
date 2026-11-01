import type { ReactNode } from "react";
import {
  describeStatus,
  type StatusInput,
  type StatusTone,
} from "../../lib/status";
import { cx } from "./cx";
import { Tooltip } from "./Tooltip";
import "./ui.css";

export interface StatusSquareProps {
  tone: StatusTone;
  className?: string;
}

/** The 6×6 status square: no radius, colour from `--status-<tone>`. Decorative. */
export function StatusSquare({ tone, className }: StatusSquareProps) {
  return (
    <span
      className={cx("ui-square", className)}
      data-tone={tone}
      aria-hidden="true"
    />
  );
}

interface StatusTagBase {
  /**
   * `lg` mono 12px (page headers), `md` mono 11.5px (lists, progress; default),
   * `sm` mono 11px (graph nodes), `sans` 12.5px (sidebar bot status lines).
   */
  size?: "sm" | "md" | "lg" | "sans";
  /**
   * Makes the tooltip (the "waiting for…" explanation, or `title`) reachable
   * by keyboard by wrapping the tag in a button. Leave it off inside another
   * interactive element such as a ListItem: there the tip shows on hover and
   * the text is also read to assistive technology.
   */
  focusableTooltip?: boolean;
  className?: string;
}

export interface StatusTagFromStatus extends StatusTagBase {
  /** A status value or record (task, session, bot presence); see src/lib/status.ts. */
  status: StatusInput;
  /** Appended after " · ", e.g. the bot name or "v2". */
  detail?: ReactNode;
  tone?: never;
  children?: never;
}

export interface StatusTagCustom extends StatusTagBase {
  /** A tone for words outside the status vocabulary (e.g. "live", "passed"). */
  tone: StatusTone;
  children: ReactNode;
  /** Tooltip text, shown with Tooltip (not the native `title`). */
  title?: string;
  status?: never;
  detail?: never;
}

export type StatusTagProps = StatusTagFromStatus | StatusTagCustom;

/**
 * Status indicator (SPEC §7, brief decision 2): a 6px square plus a mono word.
 * The word is always present, so colour is never the only signal. A waiting
 * status gets its "waiting for you" / "waiting on delegated work" tooltip.
 *
 * @example <StatusTag status={task} detail={`v${task.goalVersion}`} />
 * @example <StatusTag status={session} detail={bot.name} />
 * @example <StatusTag tone="completed">live</StatusTag>
 */
export function StatusTag(props: StatusTagProps) {
  const { size = "md", focusableTooltip = false, className } = props;
  let tone: StatusTone;
  let text: ReactNode;
  let tip: string | undefined;
  if (props.status !== undefined) {
    const display = describeStatus(props.status);
    tone = display.tone;
    tip = display.title;
    text =
      props.detail !== undefined ? (
        <>
          {display.word} · {props.detail}
        </>
      ) : (
        display.word
      );
  } else {
    tone = props.tone;
    tip = props.title;
    text = props.children;
  }
  const tag = (
    <span
      className={cx(
        "ui-status",
        size !== "md" && `ui-status--${size}`,
        className,
      )}
    >
      <StatusSquare tone={tone} />
      <span className="clamp1">
        {text}
        {tip && !focusableTooltip && (
          <span className="visually-hidden"> ({tip})</span>
        )}
      </span>
    </span>
  );
  if (!tip) return tag;
  return (
    <Tooltip
      content={tip}
      focusable={focusableTooltip}
      describe={focusableTooltip}
    >
      {tag}
    </Tooltip>
  );
}
