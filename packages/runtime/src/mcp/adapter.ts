import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type CallToolResult, toLlmContent } from "@earendil-works/pi-mcp";
import { canonicalJson, type McpTool, visibleText } from "@jj/contracts";
import { finalizeResult, type OutputPolicy } from "../tools";
import type { McpConnector } from "./connector";
import { McpServerError } from "./errors";

/** Most images one MCP result keeps; more become a placeholder line. */
export const MCP_MAX_IMAGES = 4;
/** Largest image one MCP result keeps, in decoded bytes. */
export const MCP_MAX_IMAGE_BYTES = 1024 * 1024;
/** Image types a result keeps: the ones every provider accepts. */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * One MCP tool a session declares: a tool of its pinned snapshot, and how to
 * reach its server. The engine supplies these; the runtime never decides
 * which tools a session has.
 */
export interface McpToolBinding {
  /** The server's name in the profile. */
  server: string;
  /** The tool as the pinned snapshot holds it; its declaration comes only from here. */
  tool: McpTool;
  /** Bounds each call (the server's `timeoutSec`); progress renews it, and the run's deadline caps it. */
  timeoutMs: number;
  /** The server's connection, started on first use; the engine owns it and its restarts. */
  connect(signal: AbortSignal): Promise<McpConnector>;
  /**
   * Why this tool may no longer be called (taken away from the profile
   * after the session pinned it), or undefined. A refused call gets the
   * reason as its error; the tool stays declared.
   */
  refusal?(): string | undefined;
}

/** A copy of a JSON value with object keys sorted at every depth, so stored key order never changes its bytes. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  // An own property even when named `__proto__`.
  for (const key of Object.keys(value).sort())
    Object.defineProperty(out, key, {
      value: sortedKeys((value as Record<string, unknown>)[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return out;
}

/** What the model is told about the tool: its snapshot's text, or a line naming it when that is empty. */
const describe = (binding: McpToolBinding) =>
  binding.tool.description ||
  `Tool ${visibleText(binding.tool.name)} of MCP server ${binding.server}.`;

/**
 * The call's activity summary, as approvals and `tool.started` show it:
 * `<server>/<tool>` and its arguments as canonical one-line JSON, redacted,
 * invisible characters written out, at most 300 characters.
 */
export function summarizeMcpCall(
  binding: Pick<McpToolBinding, "server" | "tool">,
  args: Record<string, unknown>,
  redact: (text: string) => string = (text) => text,
): string {
  const json =
    canonicalJson(args) ?? "(arguments that cannot be shown as JSON)";
  const summary = visibleText(
    redact(`${binding.server}/${binding.tool.name} ${json}`),
  )
    .replace(/\s+/g, " ")
    .trim();
  return summary.length > 300 ? `${summary.slice(0, 299)}…` : summary;
}

const placeholder = (text: string): TextContent => ({ type: "text", text });

/** Decoded bytes of base64 data, or undefined when it is not base64. */
function base64Bytes(data: string): number | undefined {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/**
 * A result as the model receives it: pi-mcp's `toLlmContent` (text, images,
 * embedded text resources; other blocks, and `structuredContent` alone,
 * become text), with at most MCP_MAX_IMAGES images of at most
 * MCP_MAX_IMAGE_BYTES each, in a type every provider accepts. Others become
 * a line saying so, since a malformed image in a stored result would make
 * every later model call of the session fail.
 */
export function mcpResultContent(
  result: Pick<CallToolResult, "content" | "structuredContent">,
): (TextContent | ImageContent)[] {
  let images = 0;
  const content = toLlmContent(result).map((block) => {
    if (block.type === "text") return block;
    const data = block.data.replace(/\s+/g, "");
    const bytes = base64Bytes(data);
    if (!IMAGE_TYPES.has(block.mimeType))
      return placeholder(
        `[Image omitted: type ${visibleText(String(block.mimeType)).slice(0, 80)} is not PNG, JPEG, GIF or WebP.]`,
      );
    if (bytes === undefined)
      return placeholder("[Image omitted: its data is not valid base64.]");
    if (bytes > MCP_MAX_IMAGE_BYTES)
      return placeholder(
        `[Image omitted: ${bytes} bytes, over the ${MCP_MAX_IMAGE_BYTES}-byte limit for one image.]`,
      );
    if (images >= MCP_MAX_IMAGES)
      return placeholder(
        `[Image omitted: a result keeps at most ${MCP_MAX_IMAGES} images.]`,
      );
    images++;
    return { type: "image" as const, data, mimeType: block.mimeType };
  });
  return content.length > 0 ? content : [placeholder("(no output)")];
}

/**
 * The bindings as pi tools, sorted by exposed name (UTF-16 code units), so a
 * session's MCP declarations follow its built-in tools in the same order on
 * every run. A declaration is the snapshot's name, description and input
 * schema with keys sorted at every depth: the same snapshot always gives
 * the same bytes, whatever order its stored JSON comes back in.
 *
 * A call goes through the run like any tool call (`reviewToolCall` sees it
 * first). Its arguments reach the server as validated, unchanged. Its result
 * is `mcpResultContent`, then redacted and capped (`finalizeResult` with the
 * run's policy: redaction before the cap, spill past it); `isError` makes
 * it a tool error. A call cut short by the run's stop or deadline, its
 * timeout or the server's exit is cancelled (`notifications/cancelled`) and
 * reported with `interrupted: "unknown"`; it is never run again.
 */
export function createMcpTools(
  bindings: readonly McpToolBinding[],
  policy: OutputPolicy,
): AgentTool[] {
  const sorted = [...bindings].sort((a, b) =>
    a.tool.exposedName < b.tool.exposedName
      ? -1
      : a.tool.exposedName > b.tool.exposedName
        ? 1
        : 0,
  );
  for (let index = 1; index < sorted.length; index++)
    if (sorted[index]?.tool.exposedName === sorted[index - 1]?.tool.exposedName)
      throw new Error(
        `Two MCP tools are both named ${sorted[index]?.tool.exposedName}.`,
      );
  return sorted.map((binding) => {
    const { server, tool } = binding;
    const label = `mcp: ${server}/${tool.name}`;
    const failed = (text: string, interrupted?: "yes" | "unknown") =>
      finalizeResult(
        {
          content: [{ type: "text", text }],
          details: undefined,
          isError: true,
        },
        policy,
        label,
        interrupted ? { interrupted } : {},
      );
    return {
      name: tool.exposedName,
      label: `${server}/${tool.name}`,
      description: describe(binding),
      parameters: sortedKeys(tool.inputSchema) as AgentTool["parameters"],
      executionMode: "parallel",
      // Its effects are outside the transcript: never replayed.
      replay: "never",
      async execute(_toolCallId, params, signal) {
        const refusal = binding.refusal?.();
        if (refusal !== undefined) return failed(refusal);
        const runSignal = signal ?? new AbortController().signal;
        let result: CallToolResult;
        try {
          const connector = await binding.connect(runSignal);
          result = await connector.callTool(
            tool.name,
            params as Record<string, unknown>,
            { signal: runSignal, timeoutMs: binding.timeoutMs },
          );
        } catch (error) {
          const interrupted =
            error instanceof McpServerError && error.interrupted !== "no"
              ? error.interrupted
              : undefined;
          return failed(
            error instanceof Error ? error.message : String(error),
            interrupted,
          );
        }
        return finalizeResult(
          {
            content: mcpResultContent(result),
            details: undefined,
            ...(result.isError === true ? { isError: true } : {}),
          },
          policy,
          label,
        );
      },
    } satisfies AgentTool;
  });
}
