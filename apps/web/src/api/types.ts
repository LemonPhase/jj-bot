/**
 * UI view models for the workspace.
 *
 * These extend the canonical contracts in `@jj/contracts` with the extra
 * presentation fields the UI needs (colour, glyph, labels, evidence text).
 * When the backend lands, the HTTP adapter should map API payloads into these
 * shapes so components never depend on transport details.
 */
import type {
  ExecutionSession,
  Task,
  TaskMessage,
  VerificationResult,
} from "@jj/contracts";

export const BOT_COLORS = [
  "#E05A47",
  "#2563EB",
  "#10B981",
  "#7C3AED",
  "#D97706",
  "#0D9488",
] as const;

export const BOT_GLYPHS = ["visor", "radar", "pixel", "prism", "wave"] as const;
export type BotGlyph = (typeof BOT_GLYPHS)[number];

export type BotPresence = "online" | "busy";

export interface BotProfile {
  id: string;
  name: string;
  role: string;
  color: string;
  glyph: BotGlyph;
  presence: BotPresence;
  instructions: string;
  /** Scoped memory as free text. TODO(backend): replace with structured memory entries. */
  memory: string;
}

export interface NewBotInput {
  name: string;
  role: string;
  instructions: string;
}

export type BotPatch = Partial<
  Pick<
    BotProfile,
    "name" | "role" | "color" | "glyph" | "instructions" | "memory"
  >
>;

export interface DirectMessage {
  id: string;
  botId: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** A task this message started or references, rendered as an inline card. */
  taskId?: string;
}

/** A task-chat message that has been submitted but not yet acknowledged. */
export interface PendingTaskSend {
  text: string;
  steering: boolean;
}

export type TaskStatus = Task["status"];
export type SessionStatus = ExecutionSession["status"];
export type CheckOutcome = VerificationResult["outcome"];

export interface SessionView {
  id: string;
  botId: string;
  parentSessionId?: string;
  label: string;
  status: SessionStatus;
  brief: string;
  tools: string[];
  evidence: string;
}

export interface CheckView {
  id: string;
  description: string;
  outcome: CheckOutcome;
  evidence: string;
}

export interface TaskMessageView {
  id: string;
  authorId: string;
  authorKind: TaskMessage["authorKind"];
  intent: TaskMessage["intent"];
  text: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

export interface TaskView {
  id: string;
  goal: string;
  goalVersion: number;
  status: TaskStatus;
  coordinatorBotId: string;
  participantBotIds: string[];
  /** ISO 8601 timestamp. */
  updatedAt: string;
  sessions: SessionView[];
  checks: CheckView[];
  messages: TaskMessageView[];
}

export interface NewTaskInput {
  goal: string;
  /** First entry is the coordinator. */
  participantBotIds: string[];
  /**
   * Single free-text criterion from the form.
   * TODO(backend): map to `verificationPlanSchema` (description/method/expectedEvidence).
   */
  verificationCriterion: string;
}

export interface TaskMessageInput {
  text: string;
  /** Steering bumps the goal version and refreshes verification. */
  steering: boolean;
  /** Goal version the user was looking at; the backend rejects stale steering. */
  observedGoalVersion: number;
}
