import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  contentText,
  isRecoverableLength,
  type Model,
  type RetryPolicy,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  calculateContextTokens,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  type FileOperations,
  findCutPoint,
  type SessionMessageEntry,
  shouldCompact,
} from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "@jj/contracts";
import { classifyModelError, retryingStreamFn, streamOf } from "./errors";
import { toContractUsage } from "./loop";
import type {
  CompactionEntry,
  ExecutorEvent,
  PiMessage,
  TranscriptEntry,
} from "./types";

/**
 * Context compaction for execution sessions, on pi's compaction functions
 * (`findCutPoint`, `compact`, `shouldCompact`, `estimateTokens`) over the
 * transcript the engine stores. The stored transcript stays append-only: a
 * compaction appends one entry, and the model's context is rebuilt from the
 * latest one as [summary] + the entries it keeps + every entry after it.
 */

export const isCompaction = (entry: unknown): entry is CompactionEntry =>
  typeof entry === "object" &&
  entry !== null &&
  (entry as { role?: unknown }).role === "compaction";

const isMessage = (entry: TranscriptEntry): entry is PiMessage =>
  !isCompaction(entry);

/** The model's view of a stored transcript. */
export interface TranscriptView {
  /** The latest compaction; its summary leads the context. */
  compaction?: CompactionEntry;
  /** The stored messages the model sees after the summary, oldest first, unrepaired. */
  messages: PiMessage[];
  /** How many of `messages` were kept from before the latest compaction. */
  kept: number;
}

/** Builds the view from stored entries: [summary] + kept entries + entries after it. */
export function viewTranscript(
  stored: readonly TranscriptEntry[],
): TranscriptView {
  let last = -1;
  for (let index = stored.length - 1; index >= 0; index--)
    if (isCompaction(stored[index])) {
      last = index;
      break;
    }
  if (last < 0) return { messages: stored.filter(isMessage), kept: 0 };
  const compaction = stored[last] as CompactionEntry;
  const keep = Math.max(0, Math.floor(compaction.keptEntries) || 0);
  const before = stored.slice(Math.max(0, last - keep), last).filter(isMessage);
  const after = stored.slice(last + 1).filter(isMessage);
  return { compaction, messages: [...before, ...after], kept: before.length };
}

// pi's wording for a compaction summary in context (messages.ts, not exported).
const SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

/** The user message that stands for a compaction's summary in the model's context. */
export function summaryMessage(entry: CompactionEntry): UserMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${SUMMARY_PREFIX}${entry.summary}${SUMMARY_SUFFIX}`,
      },
    ],
    timestamp: entry.timestamp,
  };
}

/** What a JJ session needs from a summary beyond pi's format. */
export const COMPACTION_INSTRUCTIONS =
  "This is one execution session of a multi-bot task. Keep the brief or goal as given, " +
  "every delegation still open (the bot, its brief and session id) and every result or failure " +
  "already received, steering and messages from the user or teammates, and whether complete_task " +
  "was called. The summarised tool calls already ran and their effects are in the shared workspace.";

export interface CompactionOptions {
  /** Default true. */
  enabled?: boolean;
  /** Tokens kept free below the context window (pi's default 16384; at least `MIN_RESERVE_TOKENS`). */
  reserveTokens?: number;
  /** Recent tokens kept as they are (pi's default 20000). */
  keepRecentTokens?: number;
}

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

const nonNegative = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;

/**
 * Tokens pi-ai's providers keep free below the window: they cap a request's
 * output at the window less the context estimate less this
 * (`clampMaxTokensToContext`).
 */
export const PROVIDER_SAFETY_TOKENS = 4096;
/** The smallest reserve: the providers' margin plus room for a real answer. */
export const MIN_RESERVE_TOKENS = PROVIDER_SAFETY_TOKENS + 4096;
/**
 * Below this window compaction is off: with the reserve the threshold would
 * leave too little for the prompt, a summary and the kept part. Sessions on
 * such a model grow until the window is exceeded, as without compaction.
 */
export const MIN_COMPACTION_WINDOW = 2 * MIN_RESERVE_TOKENS;

/**
 * pi's defaults, fitted to the window: the reserve is at least
 * `MIN_RESERVE_TOKENS` (so the call at the threshold still has room to
 * answer) and at most half the window, and the kept part at most half of
 * what is left below the threshold. At 128k and above these are pi's
 * defaults. A window under `MIN_COMPACTION_WINDOW`, or unknown (0), disables
 * compaction.
 */
export function compactionSettings(
  contextWindow: number,
  options: CompactionOptions = {},
): CompactionSettings {
  const window = Math.max(0, Math.floor(contextWindow) || 0);
  const reserveTokens = Math.min(
    Math.max(
      nonNegative(
        options.reserveTokens,
        DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      ),
      MIN_RESERVE_TOKENS,
    ),
    Math.floor(window / 2),
  );
  const keepRecentTokens = Math.min(
    nonNegative(
      options.keepRecentTokens,
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    ),
    Math.floor((window - reserveTokens) / 2),
  );
  return {
    enabled: options.enabled !== false && window >= MIN_COMPACTION_WINDOW,
    reserveTokens,
    keepRecentTokens,
  };
}

/**
 * A response the provider cut short because the context left it no room:
 * pi's recoverable length stop (`isRecoverableLength`: a `length` stop below
 * the model's own output limit) on a request whose context was big enough
 * for the providers' output cap to bite. The runtime reports it as a context
 * overflow, so it is compacted and retried like one.
 */
export function cutByContext(
  message: AssistantMessage,
  model: Model<Api>,
  contextTokens: number,
): boolean {
  return (
    model.contextWindow > 0 &&
    isRecoverableLength(message, model.maxTokens) &&
    model.contextWindow - contextTokens - PROVIDER_SAFETY_TOKENS <
      model.maxTokens
  );
}

export interface ContextCompactorOptions {
  model: Model<Api>;
  ref: ModelRef;
  getApiKey(): string | undefined;
  /** The registry's stream function; retries are added here. */
  streamFn: StreamFn;
  retry: RetryPolicy;
  sessionId?: string;
  settings: CompactionSettings;
  /** Persists entries in order, like every other transcript entry. */
  persist(entries: TranscriptEntry[]): Promise<void>;
  onEvent(event: ExecutorEvent): Promise<void>;
  /** The server's secrets, replaced in event text before it is clipped. */
  scrub(text: string): string;
  /** Provider keys and key-shaped text, replaced in error text. */
  redactError(text: string): string;
}

/** Why a compaction did not happen: there was nothing to summarise, or the summary call failed. */
export type CompactionFailure = "nothing_to_summarize" | "summary_failed";

const usable = (message: AgentMessage): message is AssistantMessage =>
  message.role === "assistant" &&
  message.stopReason !== "error" &&
  message.stopReason !== "aborted" &&
  calculateContextTokens(message.usage) > 0;

const failedAssistant = (message: AgentMessage | undefined) =>
  message?.role === "assistant" &&
  (message.stopReason === "error" || message.stopReason === "aborted");

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function addFileOps(message: AgentMessage, ops: FileOperations) {
  if (message.role !== "assistant") return;
  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    const path = block.arguments?.path;
    if (typeof path !== "string" || !path) continue;
    if (block.name === "read") ops.read.add(path);
    else if (block.name === "write") ops.written.add(path);
    else if (block.name === "edit") ops.edited.add(path);
  }
}

/**
 * Compacts one run's context. It mirrors what is stored (`record` after each
 * persisted batch), so it can say which stored entries a cut keeps, and holds
 * the latest summary the context starts with.
 */
export class ContextCompactor {
  private readonly options: ContextCompactorOptions;
  /** Stored index of each entry handed over or persisted in this run. */
  private readonly index = new Map<object, number>();
  private stored = 0;
  private latest?: CompactionEntry;
  /** The summary message at the head of the context, when there is one. */
  private summary?: UserMessage;
  /** Messages kept from before the latest compaction: their usage predates it. */
  private stale = new Set<object>();
  /** A hook (persist, onEvent) failed; the run must end. */
  private hookError?: unknown;

  constructor(
    stored: readonly TranscriptEntry[],
    view: TranscriptView,
    options: ContextCompactorOptions,
  ) {
    this.options = options;
    for (const entry of stored) this.index.set(entry, this.stored++);
    if (view.compaction) {
      this.latest = view.compaction;
      this.summary = summaryMessage(view.compaction);
      this.stale = new Set(view.messages.slice(0, view.kept));
    }
  }

  get settings(): CompactionSettings {
    return this.options.settings;
  }

  /** The summary message the context starts with, if any. */
  get summaryMessage(): UserMessage | undefined {
    return this.summary;
  }

  /** Records entries the run just persisted, in order. */
  record(entries: readonly TranscriptEntry[]) {
    for (const entry of entries) this.index.set(entry, this.stored++);
  }

  /**
   * Estimated context tokens of `messages` (system message included): the
   * latest response's usage plus estimates for what came after it, unless that
   * usage predates the latest compaction; then an estimate of every message.
   */
  estimate(messages: readonly AgentMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as AgentMessage;
      if (!usable(message)) continue;
      if (this.stale.has(message)) break;
      let tokens = calculateContextTokens(message.usage);
      for (const later of messages.slice(index + 1))
        tokens += estimateTokens(later);
      return tokens;
    }
    return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  }

  /**
   * How much of the conversation to keep, in pi's estimate (what
   * `findCutPoint` counts): at most `keepRecentTokens`, and at most half of
   * what the threshold leaves beside the system prompt, tools and the latest
   * summary. Both are scaled by how far the provider's count runs above the
   * estimate, so a dense context still has an older part to summarise.
   */
  keepBudget(messages: readonly AgentMessage[]): number {
    const { settings, model } = this.options;
    const fixed = messages
      .filter(
        (message) => message.role === "system" || message === this.summary,
      )
      .reduce((sum, message) => sum + estimateTokens(message), 0);
    const ratio = this.usageRatio(messages);
    const threshold = model.contextWindow - settings.reserveTokens;
    const keep = Math.min(
      settings.keepRecentTokens,
      Math.floor((threshold - fixed * ratio) / 2),
    );
    return Math.max(0, Math.floor(keep / ratio));
  }

  /**
   * The provider's tokens per estimated token, from the latest response that
   * postdates the latest compaction: its usage over the estimate of what it
   * was sent. Between 1 and 8; 1 without such a response.
   */
  private usageRatio(messages: readonly AgentMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as AgentMessage;
      if (!usable(message)) continue;
      if (this.stale.has(message)) return 1;
      const estimated = messages
        .slice(0, index + 1)
        .reduce((sum, earlier) => sum + estimateTokens(earlier), 0);
      if (estimated <= 0) return 1;
      return Math.min(
        8,
        Math.max(1, calculateContextTokens(message.usage) / estimated),
      );
    }
    return 1;
  }

  /** True when `messages` are past the threshold (the window minus the reserve). */
  overThreshold(messages: readonly AgentMessage[]): boolean {
    const { settings, model } = this.options;
    return (
      settings.enabled &&
      shouldCompact(this.estimate(messages), model.contextWindow, settings)
    );
  }

  /**
   * Summarises the older part of `messages` (a run's context, system message
   * first) with the session's model, persists the compaction entry and
   * returns the compacted context. A trailing failed response (the overflowed
   * call) is dropped. Everything the context holds must already be persisted.
   * Rejects when a hook fails or the signal aborts; a summary the model could
   * not produce is reported as `summary_failed`.
   */
  async compact(
    messages: readonly AgentMessage[],
    signal: AbortSignal,
  ): Promise<
    | { ok: true; messages: AgentMessage[]; entry: CompactionEntry }
    | { ok: false; reason: CompactionFailure; error?: string }
  > {
    const { options } = this;
    this.hookError = undefined;
    // System messages declare the tool loadout; all of them stay, in order,
    // so replaying them still yields the same tools (JJ runs have one).
    const system = messages.filter((message) => message.role === "system");
    const conversation = messages.filter(
      (message) => message.role !== "system" && message !== this.summary,
    );
    while (failedAssistant(conversation.at(-1))) conversation.pop();
    const entries: SessionMessageEntry[] = conversation.map((message, i) => ({
      type: "message",
      id: String(i),
      parentId: i === 0 ? null : String(i - 1),
      timestamp: new Date(message.timestamp || 0).toISOString(),
      message,
    }));
    const cut = findCutPoint(
      entries,
      0,
      entries.length,
      this.keepBudget(messages),
    );
    const historyEnd = cut.isSplitTurn
      ? cut.turnStartIndex
      : cut.firstKeptEntryIndex;
    const toSummarize = conversation.slice(0, historyEnd);
    const turnPrefix = cut.isSplitTurn
      ? conversation.slice(cut.turnStartIndex, cut.firstKeptEntryIndex)
      : [];
    const firstKept = conversation[cut.firstKeptEntryIndex];
    const keptFrom = firstKept ? this.index.get(firstKept) : undefined;
    if (
      (toSummarize.length === 0 && turnPrefix.length === 0) ||
      keptFrom === undefined
    )
      return { ok: false, reason: "nothing_to_summarize" };

    const fileOps: FileOperations = {
      read: new Set(this.latest?.readFiles ?? []),
      written: new Set(),
      edited: new Set(this.latest?.modifiedFiles ?? []),
    };
    for (const message of [...toSummarize, ...turnPrefix])
      addFileOps(message, fileOps);
    const tokensBefore = this.estimate(messages);

    let result: Awaited<ReturnType<typeof compact>>;
    try {
      result = await compact(
        {
          firstKeptEntryId: String(cut.firstKeptEntryIndex),
          messagesToSummarize: toSummarize,
          turnPrefixMessages: turnPrefix,
          isSplitTurn: cut.isSplitTurn,
          tokensBefore,
          ...(this.latest ? { previousSummary: this.latest.summary } : {}),
          fileOps,
          settings: options.settings,
        },
        options.model,
        options.getApiKey(),
        undefined,
        COMPACTION_INSTRUCTIONS,
        signal,
        undefined,
        this.summaryStream(tokensBefore),
        undefined,
        // Retries happen in summaryStream, so each call is reported once.
        undefined,
        undefined,
        options.sessionId,
      );
    } catch (error) {
      if (this.hookError !== undefined) throw this.hookError;
      signal.throwIfAborted();
      return {
        ok: false,
        reason: "summary_failed",
        error: options.redactError(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
    signal.throwIfAborted();

    const details = result.details as
      | { readFiles?: string[]; modifiedFiles?: string[] }
      | undefined;
    const entry: CompactionEntry = {
      role: "compaction",
      summary: result.summary,
      keptEntries: this.stored - keptFrom,
      tokensBefore,
      readFiles: details?.readFiles ?? [],
      modifiedFiles: details?.modifiedFiles ?? [],
      timestamp: Date.now(),
    };
    // One entry in one write: a crash before it leaves no trace but the
    // summary call's usage, and the next run compacts again.
    await options.persist([entry]);
    this.record([entry]);
    const kept = conversation.slice(cut.firstKeptEntryIndex);
    this.latest = entry;
    this.summary = summaryMessage(entry);
    this.stale = new Set(kept);
    return { ok: true, messages: [...system, this.summary, ...kept], entry };
  }

  /**
   * The summary calls' stream: retried like every model call, and reported
   * as `model.started` and `model.finished` (usage included) around each one.
   */
  private summaryStream(tokensBefore: number): StreamFn {
    const { options } = this;
    const retrying = retryingStreamFn(options.streamFn, options.retry);
    const hook = async (event: ExecutorEvent) => {
      try {
        await options.onEvent(event);
      } catch (error) {
        this.hookError ??= error;
        throw error;
      }
    };
    return async (model, context, streamOptions) => {
      await hook({ type: "model.started", model: options.ref });
      const message = await (
        await retrying(model, context, {
          ...streamOptions,
          identity: { attribution: null },
        })
      ).result();
      const failed = message.stopReason === "error";
      const text = options.scrub(contentText(message.content).trim());
      // What pi refuses (error, length, a tool call) and what JJ refuses
      // (aborted, empty) is no summary, and is reported as a failure.
      const failure = failed
        ? options.redactError(message.errorMessage || "the call failed")
        : message.stopReason === "length"
          ? "the summary was cut at the output limit"
          : message.stopReason === "aborted"
            ? "the call was aborted"
            : message.content.some((block) => block.type === "toolCall")
              ? "the model called a tool instead of summarising"
              : !text
                ? "the answer was empty"
                : undefined;
      await hook({
        type: "model.finished",
        model: options.ref,
        stopReason: message.stopReason,
        usage: toContractUsage(message.usage),
        text: clip(
          failure
            ? `Context compaction failed (about ${tokensBefore} tokens): ${failure}. Nothing was compacted.`
            : `Context compaction (about ${tokensBefore} tokens): ${text}`,
          2000,
        ),
        ...(failure
          ? { warning: `Context compaction failed: ${failure}` }
          : {}),
        ...(failed && message.errorMessage
          ? { error: options.redactError(message.errorMessage) }
          : {}),
        ...(failed
          ? {
              errorCode: classifyModelError(
                message,
                options.model.contextWindow,
              ),
            }
          : {}),
      });
      // pi rejects error and length stops; an aborted or empty answer is no
      // summary either (pi would append its file lists to it and keep it).
      const answer: AssistantMessage =
        message.stopReason === "aborted" ||
        (message.stopReason !== "error" &&
          message.stopReason !== "length" &&
          !text)
          ? {
              ...message,
              stopReason: "error",
              errorMessage: `The summary call returned no summary (${message.stopReason}).`,
            }
          : message;
      return streamOf(answer);
    };
  }
}
