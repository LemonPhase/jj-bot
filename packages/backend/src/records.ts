// Row → contract record mappers. Every event payload and every snapshot uses
// these, so a view folded from events equals a fresh snapshot.
import {
  type Activity,
  type Artifact,
  type Bot,
  type BotAppearance,
  type ConversationMessage,
  defaultAppearanceFor,
  type ExecutionSession,
  type ProfileBudgets,
  profileBudgetsSchema,
  type RuntimeProfile,
  type RuntimeProfileStatus,
  type SandboxSpec,
  sandboxSpecSchema,
  type Task,
  type TaskEvent,
  type TaskMessage,
  type ToolName,
} from "@jj/contracts";
import type {
  ArtifactRow,
  BotRow,
  ConversationMessageRow,
  RuntimeProfileRow,
  SessionRow,
  TaskEventRow,
  TaskMessageRow,
  TaskRow,
} from "@jj/db";

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

export interface Presence {
  working: boolean;
  activeTaskIds: string[];
}

export function toBot(row: BotRow, presence: Presence): Bot {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    model: row.model,
    runtimeProfileId: row.runtimeProfileId,
    appearance: appearanceOf(row),
    presence: presence.working ? "working" : "idle",
    activeTaskIds: presence.activeTaskIds,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function appearanceOf(row: BotRow): BotAppearance {
  const stored = row.appearance as Partial<BotAppearance>;
  return { ...defaultAppearanceFor(row.name), ...stored };
}

/** The coordinator first, then the other participants in a stable order. */
export function participantOrder(
  coordinatorBotId: string,
  botIds: readonly string[],
): string[] {
  const others = [...new Set(botIds)]
    .filter((id) => id !== coordinatorBotId)
    .sort();
  return [coordinatorBotId, ...others];
}

export function toTask(row: TaskRow, participantBotIds: string[]): Task {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    goalVersion: row.goalVersion,
    coordinatorBotId: row.coordinatorBotId,
    participantBotIds: participantOrder(
      row.coordinatorBotId,
      participantBotIds,
    ),
    status: row.status,
    result: row.result,
    error: row.error,
    cancelReason: row.cancelReason,
    cancelRequestedAt: isoOrNull(row.cancelRequestedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    finishedAt: isoOrNull(row.finishedAt),
  };
}

export function toSession(row: SessionRow): ExecutionSession {
  return {
    id: row.id,
    taskId: row.taskId,
    botId: row.botId,
    parentSessionId: row.parentSessionId,
    role: row.role,
    brief: row.brief,
    goalVersion: row.goalVersion,
    depth: row.depth,
    status: row.status,
    waitingFor: row.waitingFor,
    result: row.result,
    error: row.error,
    activity: (row.activity as Activity | null) ?? null,
    runCount: row.runCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
  };
}

export function toMessage(row: TaskMessageRow): TaskMessage {
  return {
    id: row.id,
    taskId: row.taskId,
    sequence: row.sequence,
    authorKind: row.authorKind,
    authorBotId: row.authorBotId,
    sessionId: row.sessionId,
    intent: row.intent,
    text: row.text,
    recipientBotIds: row.recipientBotIds,
    createdAt: iso(row.createdAt),
  };
}

/** Artifact metadata; `content` is never part of the record. */
export type ArtifactMeta = Omit<ArtifactRow, "content" | "ownerId">;

export function toArtifact(row: ArtifactMeta): Artifact {
  return {
    id: row.id,
    taskId: row.taskId,
    sessionId: row.sessionId,
    runId: row.runId,
    kind: row.kind,
    path: row.path,
    name: row.name,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    createdAt: iso(row.createdAt),
  };
}

export function toConversationMessage(
  row: ConversationMessageRow,
): ConversationMessage {
  return {
    id: row.id,
    botId: row.botId,
    sequence: row.sequence,
    role: row.role,
    text: row.text,
    taskId: row.taskId,
    createdAt: iso(row.createdAt),
  };
}

/** A stored event as the contract's TaskEvent. The engine writes only known types. */
export function toTaskEvent(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.taskId,
    sequence: row.sequence,
    occurredAt: iso(row.occurredAt),
    botId: row.botId,
    sessionId: row.sessionId,
    runId: row.runId,
    causedBy: row.causedBy,
    type: row.type,
    payload: row.payload,
  } as TaskEvent;
}

export interface StoredProfile {
  sandbox: SandboxSpec;
  tools: ToolName[];
  budgets: ProfileBudgets;
}

/** The profile's stored settings, with contract defaults for anything missing. */
export function profileSettings(row: RuntimeProfileRow): StoredProfile {
  return {
    sandbox: sandboxSpecSchema.parse(row.sandbox),
    tools: row.tools as ToolName[],
    budgets: profileBudgetsSchema.parse(row.budgets),
  };
}

export function toProfile(
  row: RuntimeProfileRow,
  status: RuntimeProfileStatus,
): RuntimeProfile {
  const settings = profileSettings(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sandbox: settings.sandbox,
    tools: settings.tools,
    budgets: settings.budgets,
    isDefault: row.isDefault,
    status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
