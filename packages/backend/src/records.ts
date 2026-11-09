// Row → contract record mappers. Every event payload and every snapshot uses
// these, so a view folded from events equals a fresh snapshot.
import {
  type Activity,
  type ApprovalRule,
  type Artifact,
  approvalRuleSchema,
  type Bot,
  type BotAppearance,
  type ConversationMessage,
  defaultAppearanceFor,
  type ExecutionSession,
  type McpDiscovery,
  type McpServer,
  type McpTool,
  type McpToolSnapshot,
  mcpServersSchema,
  type ProfileBudgets,
  profileBudgetsSchema,
  type RuntimeProfile,
  type RuntimeProfileStatus,
  type SandboxSpec,
  sandboxSpecSchema,
  type Task,
  type TaskEvent,
  type TaskMessage,
  type TaskTemplate,
  type TemplateProblem,
  type ToolName,
  type VerificationCheck,
  type VerificationPlan,
} from "@jj/contracts";
import type {
  ArtifactRow,
  BotRow,
  ConversationMessageRow,
  McpDiscoveryRow,
  McpToolSnapshotRow,
  RuntimeProfileRow,
  SessionRow,
  TaskEventRow,
  TaskMessageRow,
  TaskRow,
  TaskTemplateRow,
  VerificationCheckRow,
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
    verificationPlan: planOf(row.verificationPlan),
    spendCapUsd: row.spendCapUsd,
    templateId: row.templateId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    finishedAt: isoOrNull(row.finishedAt),
  };
}

/** A stored template with the problems derived for it now. */
export function toTaskTemplate(
  row: TaskTemplateRow,
  problems: TemplateProblem[],
): TaskTemplate {
  return {
    id: row.id,
    title: row.title,
    goal: row.goal,
    coordinatorBotId: row.coordinatorBotId,
    participantBotIds: participantOrder(
      row.coordinatorBotId,
      row.participantBotIds,
    ),
    verificationPlan: planOf(row.verificationPlan),
    // Omitted while a start takes the coordinator's profile's cap.
    ...(row.spendCapInherit ? {} : { spendCapUsd: row.spendCapUsd }),
    problems,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** A stored plan (validated when it was written); null for none. */
export function planOf(
  stored: readonly object[] | null | undefined,
): VerificationPlan | null {
  return stored && stored.length > 0
    ? (stored as unknown as VerificationPlan)
    : null;
}

export function toVerificationCheck(
  row: VerificationCheckRow,
): VerificationCheck {
  return {
    id: row.id,
    taskId: row.taskId,
    goalVersion: row.goalVersion,
    attempt: row.attempt,
    criterionId: row.criterionId,
    method: row.method,
    outcome: row.outcome,
    exitCode: row.exitCode,
    interrupted: (row.interrupted as VerificationCheck["interrupted"]) ?? null,
    durationMs: row.durationMs,
    detail: row.detail,
    output: row.output,
    truncated: row.truncated,
    artifactId: row.artifactId,
    sessionId: row.sessionId,
    runId: row.runId,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
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
    upload:
      row.uploadMessageId && row.uploadState
        ? {
            messageId: row.uploadMessageId,
            state: row.uploadState,
            placedAt: row.placedAt ? iso(row.placedAt) : null,
            error: row.uploadError,
          }
        : null,
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
    ...(row.payloadArtifactId
      ? { payloadArtifactId: row.payloadArtifactId }
      : {}),
    type: row.type,
    payload: row.payload,
  } as TaskEvent;
}

export interface StoredProfile {
  sandbox: SandboxSpec;
  tools: ToolName[];
  budgets: ProfileBudgets;
  approvals: ApprovalRule[];
  /** Granted sandbox secrets, by name. */
  secrets: string[];
  mcpServers: McpServer[];
}

/** The profile's stored settings, with contract defaults for anything missing. */
export function profileSettings(row: RuntimeProfileRow): StoredProfile {
  return {
    sandbox: sandboxSpecSchema.parse(row.sandbox),
    tools: row.tools as ToolName[],
    budgets: profileBudgetsSchema.parse(row.budgets),
    approvals: approvalRuleSchema.array().parse(row.approvals ?? []),
    secrets: Array.isArray(row.secrets)
      ? row.secrets.filter((name) => typeof name === "string")
      : [],
    mcpServers: mcpServersSchema.parse(row.mcpServers ?? []),
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
    approvals: settings.approvals,
    secrets: settings.secrets,
    mcpServers: settings.mcpServers,
    // Never stored: the profile service refuses any skill (MCP_UNAVAILABLE).
    skills: [],
    isDefault: row.isDefault,
    status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toMcpSnapshot(row: McpToolSnapshotRow): McpToolSnapshot {
  return {
    id: row.id,
    profileId: row.profileId,
    server: row.server,
    configHash: row.configHash,
    serverInfo: row.serverInfo as McpToolSnapshot["serverInfo"],
    tools: row.tools as unknown as McpTool[],
    warnings: row.warnings,
    discoveredAt: iso(row.discoveredAt),
  };
}

export function toMcpDiscovery(
  row: McpDiscoveryRow,
  snapshot: McpToolSnapshotRow | undefined,
): McpDiscovery {
  return {
    id: row.id,
    profileId: row.profileId,
    server: row.server,
    status: row.status,
    error: row.error,
    stderrTail: row.stderrTail,
    snapshot: snapshot ? toMcpSnapshot(snapshot) : null,
    durationMs: row.durationMs,
    createdAt: iso(row.createdAt),
    finishedAt: isoOrNull(row.finishedAt),
  };
}
