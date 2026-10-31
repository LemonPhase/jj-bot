import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { z } from "@jj/contracts";
import type { PiMessage } from "./types";

/** The tool result recorded for a call whose outcome was lost in a crash. */
export const INTERRUPTED_BY_RESTART =
  "Interrupted by a restart; the outcome is unknown. Check the workspace before retrying.";

function interruptedResult(
  call: ToolCall,
  timestamp: number,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: INTERRUPTED_BY_RESTART }],
    details: { interrupted: "unknown", truncated: false, repaired: true },
    isError: true,
    timestamp,
  };
}

/**
 * Makes a stored transcript a valid conversation again:
 *
 * - every tool call without a result (a crash mid-tool) gets one saying it
 *   was interrupted with an unknown outcome; nothing is re-run;
 * - each assistant message's results are put back in call order, since the
 *   executor stores each result as soon as its tool finishes.
 *
 * Results that answer no call of the message are kept after the others.
 * Returns a new array; an intact transcript comes back equal to the input.
 */
export function repairTranscript(messages: readonly PiMessage[]): PiMessage[] {
  const repaired: PiMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as PiMessage;
    repaired.push(message);
    if (message.role !== "assistant") continue;
    const calls = message.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );
    if (calls.length === 0) continue;
    const results: ToolResultMessage[] = [];
    let next = index + 1;
    for (; next < messages.length; next++) {
      const candidate = messages[next] as PiMessage;
      if (candidate.role !== "toolResult") break;
      results.push(candidate);
    }
    const byId = new Map(results.map((result) => [result.toolCallId, result]));
    for (const call of calls)
      repaired.push(
        byId.get(call.id) ?? interruptedResult(call, message.timestamp),
      );
    const callIds = new Set(calls.map((call) => call.id));
    repaired.push(
      ...results.filter((result) => !callIds.has(result.toolCallId)),
    );
    index = next - 1;
  }
  return repaired;
}

/**
 * The results `repairTranscript` made up, when an append-only store can
 * persist them: they answer the last assistant message and nothing but its
 * results follows it. Reloading then repairs the order again. Empty otherwise.
 */
export function appendedRepairs(
  original: readonly PiMessage[],
  repaired: readonly PiMessage[],
): PiMessage[] {
  const kept = new Set(original);
  const added = repaired.filter((message) => !kept.has(message));
  if (added.length === 0) return [];
  let last = original.length - 1;
  while (last >= 0 && original[last]?.role === "toolResult") last--;
  const owner = original[last];
  if (owner?.role !== "assistant") return [];
  const ownerCalls = new Set(
    owner.content.flatMap((block) =>
      block.type === "toolCall" ? [block.id] : [],
    ),
  );
  return added.every(
    (message) =>
      message.role === "toolResult" && ownerCalls.has(message.toolCallId),
  )
    ? added
    : [];
}

/**
 * Transcript entries are pi-ai 1.4 messages stored as JSON. A pi upgrade that
 * changes this shape must migrate stored transcripts or refuse to resume them;
 * `parseTranscript` refuses entries it does not recognise.
 */
export const TRANSCRIPT_FORMAT = "pi-ai-1";

export class TranscriptFormatError extends Error {
  constructor(index: number, detail: string) {
    super(
      `Transcript entry ${index} is not a ${TRANSCRIPT_FORMAT} message: ${detail}`,
    );
    this.name = "TranscriptFormatError";
  }
}

const textBlock = z.looseObject({ type: z.literal("text"), text: z.string() });
const imageBlock = z.looseObject({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});
const usage = z.looseObject({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  cost: z.looseObject({ total: z.number() }),
});
const entrySchema = z.discriminatedUnion("role", [
  z.looseObject({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(z.union([textBlock, imageBlock]))]),
    timestamp: z.number(),
  }),
  z.looseObject({
    role: z.literal("assistant"),
    content: z.array(
      z.union([
        textBlock,
        z.looseObject({ type: z.literal("thinking"), thinking: z.string() }),
        z.looseObject({
          type: z.literal("toolCall"),
          id: z.string(),
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()),
        }),
      ]),
    ),
    api: z.string(),
    provider: z.string(),
    model: z.string(),
    usage,
    stopReason: z.string(),
    timestamp: z.number(),
  }),
  z.looseObject({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(z.union([textBlock, imageBlock])),
    isError: z.boolean(),
    timestamp: z.number(),
  }),
]);

/** A message as JSON for one `session_entries` row. */
export function serializeEntry(message: PiMessage): Record<string, unknown> {
  return JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
}

/** Stored rows back to messages, oldest first. Throws `TranscriptFormatError` on an unknown shape. */
export function parseTranscript(entries: readonly unknown[]): PiMessage[] {
  return entries.map((entry, index) => {
    const parsed = entrySchema.safeParse(entry);
    if (!parsed.success)
      throw new TranscriptFormatError(
        index,
        parsed.error.issues[0]?.message ?? "invalid",
      );
    return parsed.data as unknown as PiMessage;
  });
}
