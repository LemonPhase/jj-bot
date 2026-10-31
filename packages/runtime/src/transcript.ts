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
 * Gives every tool call without a result (a crash mid-tool) a result saying
 * it was interrupted with an unknown outcome, placed after the results that do
 * exist for that assistant message. Nothing is re-run. Returns a new array;
 * an intact transcript comes back equal to the input.
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
    const answered = new Set<string>();
    let next = index + 1;
    for (; next < messages.length; next++) {
      const candidate = messages[next] as PiMessage;
      if (candidate.role !== "toolResult") break;
      answered.add(candidate.toolCallId);
      repaired.push(candidate);
    }
    for (const call of calls)
      if (!answered.has(call.id))
        repaired.push(interruptedResult(call, message.timestamp));
    index = next - 1;
  }
  return repaired;
}

/**
 * Entries `repairTranscript` appended at the end of the transcript, which an
 * append-only store can persist. Empty when nothing was repaired.
 */
export function appendedRepairs(
  original: readonly PiMessage[],
  repaired: readonly PiMessage[],
): PiMessage[] {
  if (repaired.length === original.length) return [];
  const prefixIntact = original.every(
    (message, index) => repaired[index] === message,
  );
  return prefixIntact ? repaired.slice(original.length) : [];
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
