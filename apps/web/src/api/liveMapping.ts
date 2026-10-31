/**
 * Maps the backend's contract shapes (`@jj/contracts`) onto UI view models.
 * Pure functions, so they can be tested without a running API.
 */
import type {
  Bot,
  TaskView as ContractTaskView,
  ExecutionSession,
  TaskEvent,
} from "@jj/contracts/legacy";
import {
  BOT_COLORS,
  BOT_GLYPHS,
  type BotGlyph,
  type BotProfile,
  type CheckView,
  type SessionView,
  type TaskView,
} from "./types";

/**
 * Presentation-only bot fields the backend does not store yet.
 * TODO(backend): move role/colour/glyph onto the bot record when the contract has them.
 */
export interface BotAppearance {
  role?: string;
  color?: string;
  glyph?: BotGlyph;
}

function hash(value: string) {
  let h = 0;
  for (const char of value) h = (h * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export function toBotProfile(
  bot: Bot,
  memory: string,
  appearance: BotAppearance = {},
  busy = false,
): BotProfile {
  const h = hash(bot.id);
  return {
    id: bot.id,
    name: bot.name,
    instructions: bot.instructions,
    memory,
    role: appearance.role ?? "Bot",
    color: appearance.color ?? BOT_COLORS[h % BOT_COLORS.length] ?? "#2563EB",
    glyph: appearance.glyph ?? BOT_GLYPHS[h % BOT_GLYPHS.length] ?? "visor",
    presence: busy ? "busy" : "online",
  };
}

const MAX_EVIDENCE = 280;
const clip = (text: string) =>
  text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE - 1)}…` : text;

const EVENT_LABEL: Partial<Record<TaskEvent["type"], string>> = {
  "session.started": "Session started",
  "model.started": "Model call in progress…",
  "model.finished": "Model responded",
  "tool.started": "Running a tool…",
  "tool.finished": "Tool finished",
  "verification.started": "Verifying output…",
  "verification.recorded": "Verification recorded",
  "session.revising": "Revising after a failed check…",
};

function sessionEvidence(session: ExecutionSession, events: TaskEvent[]) {
  if (session.result) return clip(session.result);
  if (session.error) return clip(`Error: ${session.error}`);
  const last = events.at(-1);
  const label = last ? EVENT_LABEL[last.type] : undefined;
  if (label) return label;
  return session.status === "queued" ? "Queued" : "No output yet";
}

function toSessions(view: ContractTaskView): SessionView[] {
  const sorted = [...view.sessions].sort((a, b) =>
    (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
  );
  return sorted.map((session, index) => {
    const events = view.events.filter((e) => e.sessionId === session.id);
    const tools = events
      .filter((e) => e.type === "tool.started")
      .map((e) => {
        const tool = e.payload.tool;
        return typeof tool === "string" ? tool : "tool";
      });
    return {
      id: session.id,
      botId: session.botId,
      parentSessionId: session.parentSessionId,
      label: `s-${index + 1} · ${session.kind === "synthesis" ? "Synthesis" : "Work"}`,
      status: session.status,
      brief: session.brief,
      tools,
      evidence: sessionEvidence(session, events),
    };
  });
}

/** One row per criterion in the task's plan, using results for the current goal version. */
function toChecks(view: ContractTaskView): CheckView[] {
  const { task } = view;
  const results = [
    ...(view.verificationResults.length
      ? view.verificationResults
      : view.checks),
  ].filter((r) => r.goalVersion === task.goalVersion);
  return task.verificationPlan.map((criterion) => {
    const latest = results.filter((r) => r.criterionId === criterion.id).at(-1);
    return {
      id: criterion.id,
      description: criterion.description,
      outcome: latest?.outcome ?? "inconclusive",
      evidence: latest
        ? clip(latest.evidence.join(" · ") || "No evidence recorded")
        : "Not run yet",
    };
  });
}

export function toTaskView(view: ContractTaskView): TaskView {
  const { task } = view;
  const fallbackTime = task.createdAt ?? new Date(0).toISOString();
  return {
    id: task.id,
    goal: task.goal,
    goalVersion: task.goalVersion,
    status: task.status,
    coordinatorBotId: task.coordinatorBotId,
    participantBotIds: task.participantBotIds,
    updatedAt: task.updatedAt ?? fallbackTime,
    sessions: toSessions(view),
    checks: toChecks(view),
    messages: view.messages.map((m) => ({
      id: m.id,
      authorId: m.authorId,
      authorKind: m.authorKind,
      intent: m.intent,
      text: m.text,
      createdAt: m.createdAt ?? fallbackTime,
    })),
  };
}

export const TERMINAL_STATUSES = new Set<TaskView["status"]>([
  "completed",
  "failed",
  "cancelled",
]);
