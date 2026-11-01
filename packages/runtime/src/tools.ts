import { posix } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  type Interrupted,
  type Sandbox,
  type SandboxLimits,
  SandboxReleasedError,
  type SandboxStat,
} from "@jj/sandbox";

/**
 * Shared plumbing for the sandbox-bound coding tools: the output cap and
 * spill, lexical workspace paths, and release detection. The tools are in
 * `tools-files.ts` (read, edit, write on `sandbox.fs`), `tools-shell.ts`
 * (bash, grep, find on `sandbox.exec`) and `sandbox-tools.ts` (assembly, and
 * pi's ls on sandbox-backed operations).
 */

/** What JJ records about a tool call, beside the text the model sees. */
export interface ToolCallDetails {
  /** bash and grep: the command's exit code; null when it never exited. */
  exitCode?: number | null;
  /** bash and grep: whether the command was cut short. */
  interrupted?: Interrupted;
  interruptReason?: string;
  /** The full output was over the cap; the model saw a preview. */
  truncated: boolean;
  /** Where the full output was spilled, when it was. */
  artifactId?: string;
}

export interface SandboxToolOptions {
  /**
   * The profile's limits: a model-chosen bash timeout is clamped to
   * `execTimeoutMs`, and bash keeps at most `maxOutputBytes` of output.
   */
  limits: Pick<SandboxLimits, "execTimeoutMs" | "maxOutputBytes">;
  /** Called when the sandbox turns out to be released under the run; the run stops. */
  onReleased(): void;
}

/** True for `SandboxReleasedError`, also from another copy of the sandbox package. */
export const isSandboxReleased = (error: unknown): boolean =>
  error instanceof SandboxReleasedError ||
  (error instanceof Error && error.name === "SandboxReleasedError");

/** Reports a released sandbox before the error becomes the tool's result. */
export async function guarded<T>(
  options: SandboxToolOptions,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isSandboxReleased(error)) options.onReleased();
    throw error;
  }
}

export const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/** Stores output over the cap. Returns the artifact id. */
export type SpillOutput = (text: string, label: string) => Promise<string>;

export interface OutputPolicy {
  /** UTF-8 bytes of tool output the model and the event preview receive. */
  capBytes: number;
  spill: SpillOutput;
  /**
   * Replaces the server's secrets. Applied to the whole output before it is
   * capped or spilled, so a cut can never leave part of a secret behind.
   */
  redact?: (text: string) => string;
}

const encoder = new TextEncoder();
export const byteLength = (text: string) => encoder.encode(text).length;

/** The longest prefix (or suffix) of `text` that fits in `maxBytes` UTF-8 bytes. */
function fitBytes(
  text: string,
  maxBytes: number,
  from: "start" | "end",
): string {
  if (maxBytes <= 0) return "";
  if (byteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice =
      from === "start" ? text.slice(0, mid) : text.slice(text.length - mid);
    if (byteLength(slice) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  const slice =
    from === "start" ? text.slice(0, low) : text.slice(text.length - low);
  // Never split a surrogate pair.
  return slice.replace(
    from === "start" ? /[\uD800-\uDBFF]$/ : /^[\uDC00-\uDFFF]/,
    "",
  );
}

/**
 * Caps model-visible output at `capBytes`. Larger output is spilled whole and
 * replaced by its head and tail plus a note naming the artifact.
 */
export async function capToolOutput(
  raw: string,
  policy: OutputPolicy,
  rawLabel: string,
): Promise<{ text: string; truncated: boolean; artifactId?: string }> {
  const text = policy.redact ? policy.redact(raw) : raw;
  const label = policy.redact ? policy.redact(rawLabel) : rawLabel;
  const total = byteLength(text);
  if (total <= policy.capBytes) return { text, truncated: false };
  let artifactId: string | undefined;
  try {
    artifactId = await policy.spill(text, label);
  } catch {
    artifactId = undefined;
  }
  const note = artifactId
    ? `[Output truncated: ${total} bytes in total. The full output is saved as artifact ${artifactId}, which you cannot read; rerun with a narrower command (for example piping through tail, head or grep) to see other parts.]`
    : `[Output truncated: ${total} bytes in total, and the full output could not be saved. Rerun with a narrower command to see other parts.]`;
  const marker = "\n[… middle of the output omitted …]\n";
  const budget = policy.capBytes - byteLength(note) - byteLength(marker) - 2;
  const head = fitBytes(text, Math.floor(budget / 2), "start");
  const tail = fitBytes(text, budget - byteLength(head), "end");
  return {
    text: `${head}${marker}${tail}\n\n${note}`,
    truncated: true,
    ...(artifactId ? { artifactId } : {}),
  };
}

const contentText = (content: (TextContent | ImageContent)[]) =>
  content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");

/** Applies the output cap to a tool result and records JJ's details. */
export async function finalizeResult(
  result: AgentToolResult<unknown>,
  policy: OutputPolicy,
  label: string,
  extra: Omit<ToolCallDetails, "truncated" | "artifactId"> = {},
): Promise<AgentToolResult<ToolCallDetails>> {
  const text = contentText(result.content);
  const capped = await capToolOutput(text, policy, label);
  const images = result.content.filter(
    (block): block is ImageContent => block.type === "image",
  );
  return {
    content: [
      ...(capped.text.length > 0 || images.length === 0
        ? [{ type: "text" as const, text: capped.text }]
        : []),
      ...images,
    ],
    details: {
      ...extra,
      truncated: capped.truncated,
      ...(capped.artifactId ? { artifactId: capped.artifactId } : {}),
    },
    ...(result.isError ? { isError: true } : {}),
    ...(result.terminate ? { terminate: true } : {}),
  };
}

/**
 * Resolves a tool path against the workspace, lexically: no `~` expansion and
 * no host filesystem access. Escapes are rejected here; the sandbox fs then
 * re-checks containment on the real path inside the sandbox.
 */
export function workspacePath(
  sandbox: Pick<Sandbox, "workspaceDir">,
  input?: unknown,
): string {
  const root = posix.normalize(sandbox.workspaceDir);
  const raw =
    typeof input === "string" && input.trim() !== "" ? input.trim() : ".";
  const resolved = posix.isAbsolute(raw)
    ? posix.normalize(raw)
    : posix.join(root, raw);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (resolved !== root && !resolved.startsWith(prefix))
    throw new Error(`Path is outside the workspace ${root}: ${raw}`);
  return resolved.length > 1 && resolved.endsWith("/")
    ? resolved.slice(0, -1)
    : resolved;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const missing = (path: string) =>
  Object.assign(new Error(`ENOENT: no such file or directory, ${path}`), {
    code: "ENOENT",
  });

export async function statOrThrow(
  sandbox: Sandbox,
  path: string,
): Promise<SandboxStat> {
  const info = await sandbox.fs.stat(path);
  if (!info) throw missing(path);
  return info;
}

/** A finite integer of at least `min`, else `fallback`. */
export function boundedInt(value: unknown, fallback: number, min = 1): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min
    ? Math.floor(value)
    : fallback;
}
