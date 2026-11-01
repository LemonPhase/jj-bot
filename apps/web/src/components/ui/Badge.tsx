import type { ReactNode } from "react";
import type { StatusTone } from "../../lib/status";
import { cx } from "./cx";
import { StatusSquare } from "./Status";
import "./ui.css";

export interface BadgeProps {
  children: ReactNode;
  /** Adds a leading 6px status square ("● live"). */
  tone?: StatusTone;
  /** `step`: the tighter step chip ("3 / 7"). */
  variant?: "default" | "step";
  title?: string;
  className?: string;
}

/**
 * Outline chip (SPEC §4): mono 11.5px muted text in a 1px --line box, radius 6.
 *
 * @example <Badge tone="completed">live</Badge>
 * @example <Badge variant="step">3 / 7</Badge>
 */
export function Badge({
  children,
  tone,
  variant = "default",
  title,
  className,
}: BadgeProps) {
  return (
    <span
      className={cx(
        "ui-badge",
        variant === "step" && "ui-badge--step",
        className,
      )}
      title={title}
    >
      {tone && <StatusSquare tone={tone} />}
      {children}
    </span>
  );
}

/**
 * What the sidebar mode badge reports (frontend brief):
 *   demo      in-browser demo data, no square (as designed: "Demo data")
 *   live      the backend answers and can run agents
 *   no-model  backend, but `capabilities.agentExecution` is false
 *   scripted  backend with only the scripted provider configured
 */
export type ModeBadgeKind = "demo" | "live" | "no-model" | "scripted";

const MODE_BADGES: Readonly<
  Record<ModeBadgeKind, { label: string; tone?: StatusTone; title: string }>
> = {
  demo: {
    label: "Demo data",
    title: "No backend: bots and tasks are simulated in this browser.",
  },
  live: {
    label: "Live",
    tone: "completed",
    title: "Connected to the backend.",
  },
  "no-model": {
    label: "No model configured",
    tone: "verifying",
    title:
      "Connected, but no model provider is configured, so agents cannot run.",
  },
  scripted: {
    label: "Scripted model",
    tone: "verifying",
    title: "Connected to a scripted test model, not a real one.",
  },
};

export interface ModeBadgeProps {
  kind: ModeBadgeKind;
  /** Overrides the default explanation shown on hover. */
  title?: string;
  className?: string;
}

/** The sidebar footer badge. Never pass `live` unless the backend really answered. */
export function ModeBadge({ kind, title, className }: ModeBadgeProps) {
  const badge = MODE_BADGES[kind];
  return (
    <Badge tone={badge.tone} title={title ?? badge.title} className={className}>
      {badge.label}
    </Badge>
  );
}
