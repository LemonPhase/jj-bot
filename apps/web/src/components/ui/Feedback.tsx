import type { BotAppearance } from "@jj/contracts";
import type { ReactNode } from "react";
import { PixelSprite } from "../sprite/PixelSprite";
import { cx } from "./cx";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import "./ui.css";

export interface EmptyStateProps {
  /** One short line, shown in mono 12px --ink-muted ("No tasks yet."). */
  message: ReactNode;
  /** At most one action, usually a primary `<Button>`. */
  action?: ReactNode;
  /** Optional picture above the message, e.g. a 48px idle sprite of the selected bot. */
  illustration?: ReactNode;
  /** `start` for lists (padding 0 10px), `center` for empty main areas. */
  align?: "start" | "center";
  className?: string;
}

/**
 * Empty state (brief decision 5): one mono line plus one primary action. Never
 * a skeleton that looks like real data.
 */
export function EmptyState({
  message,
  action,
  illustration,
  align = "start",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        "ui-empty",
        align === "center" && "ui-empty--center",
        className,
      )}
    >
      {illustration}
      <p className="ui-empty__message">{message}</p>
      {action}
    </div>
  );
}

/** Three 4×4 squares blinking in turn (SPEC §4 typing dots). Decorative. */
export function TypingDots({ className }: { className?: string }) {
  return (
    <span className={cx("ui-dots", className)} aria-hidden="true">
      <span className="ui-dots__dot" />
      <span className="ui-dots__dot" />
      <span className="ui-dots__dot" />
    </span>
  );
}

export interface SpinnerProps {
  /** Announced to assistive technology; shown when `showLabel`. Default "Loading…". */
  label?: string;
  /** Shows the label in mono 12px --ink-muted next to the dots. */
  showLabel?: boolean;
  className?: string;
}

/** Busy indicator built from the typing dots (the design has no spinner). */
export function Spinner({
  label = "Loading…",
  showLabel = false,
  className,
}: SpinnerProps) {
  return (
    <span className={cx("ui-spinner", className)} role="status">
      <TypingDots />
      <span className={showLabel ? undefined : "visually-hidden"}>{label}</span>
    </span>
  );
}

export interface WorkingIndicatorProps {
  name: string;
  appearance?: Pick<
    BotAppearance,
    "shape" | "face" | "topper" | "colour"
  > | null;
  /** Default "{name} is working". */
  label?: string;
}

/**
 * The typing row (SPEC §4): a 24px working sprite, "{Name} is working" and the
 * dots. Show it only while a real pending turn or running session exists.
 */
export function WorkingIndicator({
  name,
  appearance,
  label,
}: WorkingIndicatorProps) {
  return (
    <div className="ui-working" role="status" aria-live="polite">
      {appearance && (
        <PixelSprite appearance={appearance} mood="working" size={24} />
      )}
      <span>{label ?? `${name} is working`}</span>
      <TypingDots />
    </div>
  );
}

export interface ErrorBannerProps {
  /** The plain message, e.g. a server error shown verbatim. */
  children: ReactNode;
  /** The red lead word. Default "Error". */
  word?: string;
  onDismiss?: () => void;
  className?: string;
}

/**
 * Error banner (brief decision 5): a failed-red lead word plus the plain
 * message, never colour alone. Announced as an alert.
 *
 * @example <ErrorBanner word="PROFILE_UNSUPPORTED" onDismiss={clear}>{error.message}</ErrorBanner>
 */
export function ErrorBanner({
  children,
  word = "Error",
  onDismiss,
  className,
}: ErrorBannerProps) {
  return (
    <div className={cx("ui-error", className)} role="alert">
      <p className="ui-error__text">
        <span className="ui-error__word">{word}</span>
        {children}
      </p>
      {onDismiss && (
        <IconButton
          label="Dismiss"
          icon={<Icon name="close" size={14} />}
          onClick={onDismiss}
        />
      )}
    </div>
  );
}
