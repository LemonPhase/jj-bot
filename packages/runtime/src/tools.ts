import { posix } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  type ImageContent,
  type TextContent,
  Type,
} from "@earendil-works/pi-ai";
import {
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { ToolName } from "@jj/contracts";
import {
  type Interrupted,
  resolveExecTimeoutMs,
  type Sandbox,
  type SandboxLimits,
  SandboxReleasedError,
  type SandboxStat,
} from "@jj/sandbox";

/**
 * Coding tools bound to a `Sandbox`. Every file access goes through
 * `sandbox.fs` (containment-checked) and every command through `sandbox.exec`
 * (environment built by the driver). pi's read, edit, write, ls and find run
 * on sandbox-backed operations; bash and grep are JJ implementations because
 * pi's versions cannot be fully redirected (see pi-notes: bash passes the host
 * environment and writes host temp files; grep always spawns a host ripgrep).
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
  /** The profile's limits: a model-chosen bash timeout is clamped to `execTimeoutMs`. */
  limits: Pick<SandboxLimits, "execTimeoutMs">;
  /** Called when the sandbox turns out to be released under the run; the run stops. */
  onReleased(): void;
}

/** True for `SandboxReleasedError`, also from another copy of the sandbox package. */
export const isSandboxReleased = (error: unknown): boolean =>
  error instanceof SandboxReleasedError ||
  (error instanceof Error && error.name === "SandboxReleasedError");

/** Reports a released sandbox before the error becomes the tool's result. */
async function guarded<T>(
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

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/** Stores output over the cap. Returns the artifact id. */
export type SpillOutput = (text: string, label: string) => Promise<string>;

export interface OutputPolicy {
  /** UTF-8 bytes of tool output the model and the event preview receive. */
  capBytes: number;
  spill: SpillOutput;
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

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
  text: string,
  policy: OutputPolicy,
  label: string,
): Promise<{ text: string; truncated: boolean; artifactId?: string }> {
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
 * Resolves a tool path against the workspace and rejects lexical escapes
 * before pi sees it, so pi's own path handling (`~` expansion, host-side
 * existence probes) only ever meets an absolute path inside the workspace.
 * The sandbox fs then re-checks containment on the real path.
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const missing = (path: string) =>
  Object.assign(new Error(`ENOENT: no such file or directory, ${path}`), {
    code: "ENOENT",
  });

async function statOrThrow(
  sandbox: Sandbox,
  path: string,
): Promise<SandboxStat> {
  const info = await sandbox.fs.stat(path);
  if (!info) throw missing(path);
  return info;
}

function sniffImage(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  )
    return "image/jpeg";
  if (buffer.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return undefined;
}

const absoluteEntry = (directory: string, entryPath: string) =>
  posix.isAbsolute(entryPath) ? entryPath : posix.join(directory, entryPath);

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git"]);

function bashTool(
  sandbox: Sandbox,
  policy: OutputPolicy,
  options: SandboxToolOptions,
): AgentTool {
  const limitMs = resolveExecTimeoutMs(options.limits);
  const parameters = Type.Object({
    command: Type.String({ description: "Shell command to run" }),
    timeout: Type.Optional(
      Type.Number({
        description: `Timeout in seconds. At most ${seconds(limitMs)}, the sandbox's limit.`,
      }),
    ),
  });
  return {
    name: "bash",
    label: "bash",
    description: `Run a shell command (sh -c) in the task workspace ${sandbox.workspaceDir}, which is the working directory of every command. Returns combined stdout and stderr. Output over ${Math.floor(policy.capBytes / 1024)} KiB is truncated to its head and tail. Each call starts a fresh shell; files persist, shell state does not. Commands time out after ${seconds(limitMs)}.`,
    parameters,
    async execute(_toolCallId, params, signal) {
      const { command, timeout } = params as {
        command: string;
        timeout?: number;
      };
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0))
        throw new Error("Invalid timeout: use a positive number of seconds.");
      const label = `bash: ${command.slice(0, 120)}`;
      if (signal?.aborted)
        return finalizeResult(
          {
            content: [
              {
                type: "text",
                text: "Command not started: the run was stopped.",
              },
            ],
            details: undefined,
            isError: true,
          },
          policy,
          label,
          { exitCode: null, interrupted: "yes", interruptReason: "abort" },
        );
      const chunks: Buffer[] = [];
      const timeoutMs = resolveExecTimeoutMs(
        options.limits,
        timeout === undefined ? undefined : timeout * 1000,
      );
      const result = await guarded(options, () =>
        sandbox.exec(command, {
          ...(signal ? { signal } : {}),
          timeoutMs,
          onData: (chunk) => {
            chunks.push(chunk);
          },
        }),
      );
      if (result.interruptReason === "release") options.onReleased();
      const streamed = Buffer.concat(chunks).toString("utf8");
      let output =
        streamed.length > 0
          ? streamed
          : [result.stdout, result.stderr]
              .filter((part) => part.length > 0)
              .join("\n");
      output = output.replace(/\n$/, "");
      const status: string[] = [];
      if (result.truncated)
        status.push("[The sandbox stopped capturing output at its limit.]");
      if (result.interrupted !== "no") {
        const why =
          result.interruptReason === "timeout"
            ? `Command timed out after ${seconds(timeoutMs)}.`
            : result.interruptReason === "release"
              ? "Command stopped: the sandbox was released."
              : "Command stopped: the run was cancelled.";
        status.push(
          result.interrupted === "unknown"
            ? `${why} Its processes may still be running, so its effects are unknown.`
            : why,
        );
      } else if (result.exitCode !== 0) {
        status.push(`Command exited with code ${result.exitCode}.`);
      }
      const text = [output || "(no output)", ...status].join("\n\n");
      return finalizeResult(
        {
          content: [{ type: "text", text }],
          details: undefined,
          ...(result.interrupted !== "no" || result.exitCode !== 0
            ? { isError: true }
            : {}),
        },
        policy,
        label,
        {
          exitCode: result.exitCode,
          interrupted: result.interrupted,
          ...(result.interruptReason
            ? { interruptReason: result.interruptReason }
            : {}),
        },
      );
    },
  };
}

const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_LINE = 500;

function grepTool(
  sandbox: Sandbox,
  policy: OutputPolicy,
  options: SandboxToolOptions,
): AgentTool {
  const parameters = Type.Object({
    pattern: Type.String({
      description:
        "Search pattern (regex, or a literal string with literal: true)",
    }),
    path: Type.Optional(
      Type.String({
        description: "Directory or file to search (default: the workspace)",
      }),
    ),
    glob: Type.Optional(
      Type.String({
        description: "Only search files matching this glob, e.g. '*.ts'",
      }),
    ),
    ignoreCase: Type.Optional(
      Type.Boolean({ description: "Case-insensitive search (default: false)" }),
    ),
    literal: Type.Optional(
      Type.Boolean({
        description: "Treat the pattern as a literal string (default: false)",
      }),
    ),
    context: Type.Optional(
      Type.Number({
        description: "Lines of context around each match (default: 0)",
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: `Maximum matches to return (default: ${GREP_DEFAULT_LIMIT})`,
      }),
    ),
  });
  return {
    name: "grep",
    label: "grep",
    description: `Search file contents in the workspace. Returns matching lines as path:line: text. Skips .git and, with ripgrep, ignored files. Returns at most ${GREP_DEFAULT_LIMIT} matches by default; long lines are cut to ${GREP_MAX_LINE} characters.`,
    parameters,
    async execute(_toolCallId, params, signal) {
      const args = params as {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        limit?: number;
      };
      const target = workspacePath(sandbox, args.path);
      const info = await guarded(options, () => statOrThrow(sandbox, target));
      const isDirectory = info.kind === "directory";
      const context = Math.max(0, Math.floor(args.context ?? 0));
      const limit = Math.max(1, Math.floor(args.limit ?? GREP_DEFAULT_LIMIT));
      const where = isDirectory ? "." : shellQuote(target);
      const rg = [
        "rg --no-config --line-number --with-filename --color=never --hidden --glob '!.git'",
        args.ignoreCase ? "--ignore-case" : "",
        args.literal ? "--fixed-strings" : "",
        context > 0 ? `--context ${context}` : "",
        args.glob ? `--glob ${shellQuote(args.glob)}` : "",
        `-e ${shellQuote(args.pattern)} -- ${where}`,
      ];
      const grep = [
        "grep -rnHI --color=never --exclude-dir=.git",
        args.ignoreCase ? "-i" : "",
        args.literal ? "-F" : "-E",
        context > 0 ? `-C ${context}` : "",
        args.glob ? `--include=${shellQuote(args.glob)}` : "",
        `-e ${shellQuote(args.pattern)} -- ${where}`,
      ];
      const join = (parts: string[]) => parts.filter(Boolean).join(" ");
      const command = `if command -v rg >/dev/null 2>&1; then ${join(rg)}; else ${join(grep)}; fi`;
      const result = await guarded(options, () =>
        sandbox.exec(command, {
          ...(isDirectory ? { cwd: target } : {}),
          ...(signal ? { signal } : {}),
        }),
      );
      if (result.interruptReason === "release") options.onReleased();
      const extra = {
        exitCode: result.exitCode,
        interrupted: result.interrupted,
        ...(result.interruptReason
          ? { interruptReason: result.interruptReason }
          : {}),
      };
      const label = `grep: ${args.pattern.slice(0, 120)}`;
      if (result.interrupted !== "no")
        return finalizeResult(
          {
            content: [
              { type: "text", text: "Search stopped: the run was cancelled." },
            ],
            details: undefined,
            isError: true,
          },
          policy,
          label,
          extra,
        );
      if (result.exitCode === 1)
        return finalizeResult(
          {
            content: [{ type: "text", text: "No matches found" }],
            details: undefined,
          },
          policy,
          label,
          extra,
        );
      if (result.exitCode !== 0)
        return finalizeResult(
          {
            content: [
              {
                type: "text",
                text:
                  result.stderr.trim() ||
                  `Search failed with exit code ${result.exitCode}`,
              },
            ],
            details: undefined,
            isError: true,
          },
          policy,
          label,
          extra,
        );
      const lines: string[] = [];
      let matches = 0;
      let limited = false;
      let cutLines = false;
      for (const raw of result.stdout.split("\n")) {
        if (raw.length === 0) continue;
        const line = raw.startsWith("./") ? raw.slice(2) : raw;
        // Match lines are path:N:text; context lines path-N-text; group separators "--".
        if (/^.+?:\d+:/.test(line)) {
          if (matches >= limit) {
            limited = true;
            break;
          }
          matches++;
        }
        if (line.length > GREP_MAX_LINE) cutLines = true;
        lines.push(
          line.length > GREP_MAX_LINE
            ? `${line.slice(0, GREP_MAX_LINE)}…`
            : line,
        );
      }
      const notes = [
        limited
          ? `${limit} matches limit reached; use limit=${limit * 2} for more, or refine the pattern`
          : "",
        cutLines
          ? `some lines were cut to ${GREP_MAX_LINE} characters; use read to see them in full`
          : "",
        result.truncated
          ? "the sandbox stopped capturing output at its limit"
          : "",
      ].filter(Boolean);
      const text =
        lines.join("\n") +
        (notes.length > 0 ? `\n\n[${notes.join(". ")}]` : "");
      return finalizeResult(
        { content: [{ type: "text", text }], details: undefined },
        policy,
        label,
        extra,
      );
    },
  };
}

/** Wraps a pi tool: contains its path argument and applies the output cap. */
function contained(
  tool: AgentTool,
  sandbox: Sandbox,
  policy: OutputPolicy,
  options: SandboxToolOptions,
): AgentTool {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const args = { ...(params as Record<string, unknown>) };
      args.path = workspacePath(sandbox, args.path);
      const result = await guarded(options, () =>
        tool.execute(toolCallId, args as never, signal, onUpdate),
      );
      return finalizeResult(
        result,
        policy,
        `${tool.name}: ${String(args.path).slice(0, 120)}`,
      );
    },
  };
}

function piTools(
  sandbox: Sandbox,
): Record<"read" | "edit" | "write" | "ls" | "find", AgentTool> {
  const cwd = sandbox.workspaceDir;
  const { fs } = sandbox;
  // read detects images and then reads the file; keep the first read for the second call.
  const prefetched = new Map<string, Buffer>();
  const kinds = new Map<string, SandboxStat["kind"]>();
  return {
    read: createReadTool(cwd, {
      operations: {
        readFile: async (path) => {
          const cached = prefetched.get(path);
          prefetched.delete(path);
          return cached ?? fs.read(path);
        },
        access: async (path) => {
          const info = await statOrThrow(sandbox, path);
          if (info.kind === "directory")
            throw Object.assign(
              new Error(
                `EISDIR: illegal operation on a directory, read ${path}`,
              ),
              { code: "EISDIR" },
            );
        },
        detectImageMimeType: async (path) => {
          const buffer = await fs.read(path);
          prefetched.set(path, buffer);
          return sniffImage(buffer);
        },
      },
    }),
    edit: createEditTool(cwd, {
      operations: {
        readFile: (path) => fs.read(path),
        writeFile: (path, content) => fs.write(path, content),
        access: async (path) => {
          const info = await statOrThrow(sandbox, path);
          if (info.kind !== "file") throw missing(path);
        },
      },
    }),
    write: createWriteTool(cwd, {
      operations: {
        writeFile: (path, content) => fs.write(path, content),
        mkdir: (directory) => fs.mkdir(directory),
      },
    }),
    ls: createLsTool(cwd, {
      operations: {
        exists: async (path) => (await fs.stat(path)) !== undefined,
        stat: async (path) => {
          const known = kinds.get(path);
          const kind = known ?? (await statOrThrow(sandbox, path)).kind;
          return { isDirectory: () => kind === "directory" };
        },
        readdir: async (path) => {
          kinds.clear();
          const entries = await fs.list(path);
          return entries.map((entry) => {
            const absolute = absoluteEntry(path, entry.path);
            kinds.set(absolute, entry.kind);
            return posix.basename(absolute);
          });
        },
      },
    }),
    find: createFindTool(cwd, {
      operations: {
        exists: async (path) => (await fs.stat(path)) !== undefined,
        glob: async (pattern, searchDir, { limit }) => {
          const entries = await fs.list(searchDir, { recursive: true });
          const results: string[] = [];
          const withSlash = pattern.includes("/");
          for (const entry of entries) {
            const absolute = absoluteEntry(searchDir, entry.path);
            const relative = posix.relative(searchDir, absolute);
            if (relative.startsWith("..") || relative === "") continue;
            if (
              relative
                .split("/")
                .some((segment) => IGNORED_DIRECTORIES.has(segment))
            )
              continue;
            const matches = withSlash
              ? posix.matchesGlob(relative, pattern) ||
                posix.matchesGlob(relative, `**/${pattern}`)
              : posix.matchesGlob(posix.basename(relative), pattern);
            if (matches)
              results.push(
                entry.kind === "directory" ? `${absolute}/` : absolute,
              );
          }
          return results.sort().slice(0, limit);
        },
      },
    }),
  };
}

/** The coding tools a profile grants, bound to the task's sandbox. */
export function createSandboxTools(
  sandbox: Sandbox,
  names: readonly ToolName[],
  policy: OutputPolicy,
  options: SandboxToolOptions,
): AgentTool[] {
  const pi = piTools(sandbox);
  const build: Record<ToolName, () => AgentTool> = {
    bash: () => bashTool(sandbox, policy, options),
    grep: () => grepTool(sandbox, policy, options),
    read: () => contained(pi.read, sandbox, policy, options),
    edit: () => contained(pi.edit, sandbox, policy, options),
    write: () => contained(pi.write, sandbox, policy, options),
    ls: () => contained(pi.ls, sandbox, policy, options),
    find: () => contained(pi.find, sandbox, policy, options),
  };
  return [...new Set(names)].map((name) => build[name]());
}
