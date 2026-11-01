import { posix } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  type ExecResult,
  resolveExecTimeoutMs,
  type Sandbox,
} from "@jj/sandbox";
import {
  boundedInt,
  finalizeResult,
  guarded,
  type OutputPolicy,
  type SandboxToolOptions,
  seconds,
  shellQuote,
  statOrThrow,
  workspacePath,
} from "./tools";

/**
 * bash, grep and find run as commands inside the sandbox. pi's bash passes the
 * host environment to its operations and writes host temp files, pi's grep
 * always spawns a host ripgrep, and listing a whole tree through the fs API to
 * glob it is too slow once a workspace has node_modules.
 */

const text = (value: string) => ({ type: "text" as const, text: value });

const execDetails = (result: ExecResult) => ({
  exitCode: result.exitCode,
  interrupted: result.interrupted,
  ...(result.interruptReason
    ? { interruptReason: result.interruptReason }
    : {}),
});

/**
 * Collects a command's combined output in arrival order, keeping at most
 * `maxBytes`: drivers call `onData` for every chunk, before their own cap.
 */
export function boundedCollector(maxBytes: number) {
  const chunks: Buffer[] = [];
  let kept = 0;
  let cut = false;
  return {
    onData(chunk: Buffer) {
      if (cut) return;
      const room = maxBytes - kept;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        kept = maxBytes;
        cut = true;
        return;
      }
      chunks.push(chunk);
      kept += chunk.length;
    },
    get cut() {
      return cut;
    },
    get bytes() {
      return kept;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function bashTool(
  sandbox: Sandbox,
  policy: OutputPolicy,
  options: SandboxToolOptions,
): AgentTool {
  const limitMs = resolveExecTimeoutMs(options.limits);
  const maxBytes = boundedInt(options.limits.maxOutputBytes, 262_144);
  return {
    name: "bash",
    label: "bash",
    description: `Run a shell command (sh -c) in the task workspace ${sandbox.workspaceDir}, which is the working directory of every command. Returns combined stdout and stderr. Output over ${Math.floor(policy.capBytes / 1024)} KiB is truncated to its head and tail, and output past ${Math.floor(maxBytes / 1024)} KiB is not kept. Each call starts a fresh shell; files persist, shell state does not. Commands time out after ${seconds(limitMs)}.`,
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run" }),
      timeout: Type.Optional(
        Type.Number({
          description: `Timeout in seconds. At most ${seconds(limitMs)}, the sandbox's limit.`,
        }),
      ),
    }),
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
            content: [text("Command not started: the run was stopped.")],
            details: undefined,
            isError: true,
          },
          policy,
          label,
          { exitCode: null, interrupted: "yes", interruptReason: "abort" },
        );
      const timeoutMs = resolveExecTimeoutMs(
        options.limits,
        timeout === undefined ? undefined : timeout * 1000,
      );
      const output = boundedCollector(maxBytes);
      const result = await guarded(options, () =>
        sandbox.exec(command, {
          ...(signal ? { signal } : {}),
          timeoutMs,
          onData: (chunk) => output.onData(chunk),
        }),
      );
      if (result.interruptReason === "release") options.onReleased();
      let body =
        output.bytes > 0
          ? output.text()
          : [result.stdout, result.stderr].filter(Boolean).join("\n");
      body = body.replace(/\n$/, "");
      const status: string[] = [];
      if (output.cut || result.truncated)
        status.push(
          `[Output was cut at ${Math.floor(maxBytes / 1024)} KiB, the sandbox's output limit; the rest was not kept.]`,
        );
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
      } else if (result.exitCode !== 0)
        status.push(`Command exited with code ${result.exitCode}.`);
      return finalizeResult(
        {
          content: [text([body || "(no output)", ...status].join("\n\n"))],
          details: undefined,
          ...(result.interrupted !== "no" || result.exitCode !== 0
            ? { isError: true }
            : {}),
        },
        policy,
        label,
        execDetails(result),
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
  return {
    name: "grep",
    label: "grep",
    description: `Search file contents in the workspace. Returns matching lines as path:line: text. Skips .git and, with ripgrep, ignored files. Returns at most ${GREP_DEFAULT_LIMIT} matches by default; long lines are cut to ${GREP_MAX_LINE} characters.`,
    parameters: Type.Object({
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
        Type.Boolean({
          description: "Case-insensitive search (default: false)",
        }),
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
    }),
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
      const context = boundedInt(args.context, 0, 0);
      const limit = boundedInt(args.limit, GREP_DEFAULT_LIMIT);
      const where = isDirectory ? "." : shellQuote(target);
      const join = (parts: string[]) => parts.filter(Boolean).join(" ");
      const rg = join([
        "rg --no-config --line-number --with-filename --color=never --hidden --glob '!.git'",
        args.ignoreCase ? "--ignore-case" : "",
        args.literal ? "--fixed-strings" : "",
        context > 0 ? `--context ${context}` : "",
        args.glob ? `--glob ${shellQuote(args.glob)}` : "",
        `-e ${shellQuote(args.pattern)} -- ${where}`,
      ]);
      const grep = join([
        "grep -rnHI --color=never --exclude-dir=.git",
        args.ignoreCase ? "-i" : "",
        args.literal ? "-F" : "-E",
        context > 0 ? `-C ${context}` : "",
        args.glob ? `--include=${shellQuote(args.glob)}` : "",
        `-e ${shellQuote(args.pattern)} -- ${where}`,
      ]);
      const result = await guarded(options, () =>
        sandbox.exec(
          `if command -v rg >/dev/null 2>&1; then ${rg}; else ${grep}; fi`,
          {
            ...(isDirectory ? { cwd: target } : {}),
            ...(signal ? { signal } : {}),
          },
        ),
      );
      if (result.interruptReason === "release") options.onReleased();
      const label = `grep: ${args.pattern.slice(0, 120)}`;
      const details = execDetails(result);
      if (result.interrupted !== "no")
        return finalizeResult(
          {
            content: [text("Search stopped: the run was cancelled.")],
            details: undefined,
            isError: true,
          },
          policy,
          label,
          details,
        );
      if (result.exitCode === 1)
        return finalizeResult(
          { content: [text("No matches found")], details: undefined },
          policy,
          label,
          details,
        );
      if (result.exitCode !== 0)
        return finalizeResult(
          {
            content: [
              text(
                result.stderr.trim() ||
                  `Search failed with exit code ${result.exitCode}`,
              ),
            ],
            details: undefined,
            isError: true,
          },
          policy,
          label,
          details,
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
      return finalizeResult(
        {
          content: [
            text(
              lines.join("\n") +
                (notes.length > 0 ? `\n\n[${notes.join(". ")}]` : ""),
            ),
          ],
          details: undefined,
        },
        policy,
        label,
        details,
      );
    },
  };
}

/** Directories find never descends into. */
export const FIND_PRUNED = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".cache",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  "target",
] as const;
/** Most entries find reports before matching; bounds work on huge trees. */
const FIND_SCAN_LIMIT = 20_000;
const FIND_DEFAULT_LIMIT = 1000;

function findTool(
  sandbox: Sandbox,
  policy: OutputPolicy,
  options: SandboxToolOptions,
): AgentTool {
  return {
    name: "find",
    label: "find",
    description: `Find files and directories by glob pattern, e.g. '*.ts', '**/*.json' or 'src/**/*.spec.ts'. Paths are relative to the search directory; directories end with '/'. Skips ${FIND_PRUNED.join(", ")}. Returns at most ${FIND_DEFAULT_LIMIT} results by default.`,
    parameters: Type.Object({
      pattern: Type.String({
        description: "Glob pattern; without a '/' it matches file names",
      }),
      path: Type.Optional(
        Type.String({
          description: "Directory to search (default: the workspace)",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Maximum results (default: ${FIND_DEFAULT_LIMIT})`,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params as { pattern: string; path?: string; limit?: number };
      const target = workspacePath(sandbox, args.path);
      const info = await guarded(options, () => statOrThrow(sandbox, target));
      if (info.kind !== "directory")
        throw new Error(`Not a directory: ${args.path ?? "."}`);
      const limit = boundedInt(args.limit, FIND_DEFAULT_LIMIT);
      const pattern = args.pattern.trim();
      const byName = !pattern.includes("/");
      // A simple name pattern is matched by find itself; path patterns are matched here.
      const nameFilter =
        byName && !/[{}]|\*\*/.test(pattern)
          ? `-name ${shellQuote(pattern)}`
          : "";
      const prunes = FIND_PRUNED.map(
        (name) => `-name ${shellQuote(name)}`,
      ).join(" -o ");
      const command = [
        `find . -mindepth 1 \\( ${prunes} \\) -prune`,
        `-o -type d ${nameFilter} -exec printf '%s/\\n' {} +`,
        `-o ${nameFilter} -print`,
        `| head -n ${FIND_SCAN_LIMIT + 1}`,
      ].join(" ");
      const result = await guarded(options, () =>
        sandbox.exec(command, { cwd: target, ...(signal ? { signal } : {}) }),
      );
      if (result.interruptReason === "release") options.onReleased();
      const label = `find: ${pattern.slice(0, 120)}`;
      const details = execDetails(result);
      if (result.interrupted !== "no")
        return finalizeResult(
          {
            content: [text("Search stopped: the run was cancelled.")],
            details: undefined,
            isError: true,
          },
          policy,
          label,
          details,
        );
      const entries = result.stdout
        .split("\n")
        .filter((line) => line.length > 0);
      const scanLimited = entries.length > FIND_SCAN_LIMIT;
      const matches: string[] = [];
      for (const entry of entries.slice(0, FIND_SCAN_LIMIT)) {
        const relative = entry.replace(/^\.\//, "");
        const bare = relative.replace(/\/$/, "");
        const hit = byName
          ? posix.matchesGlob(posix.basename(bare), pattern)
          : posix.matchesGlob(bare, pattern) ||
            posix.matchesGlob(bare, `**/${pattern}`);
        if (hit) matches.push(relative);
      }
      matches.sort();
      const shown = matches.slice(0, limit);
      const notes = [
        matches.length > limit
          ? `${limit} results limit reached; use limit=${limit * 2} for more`
          : "",
        scanLimited
          ? `stopped after scanning ${FIND_SCAN_LIMIT} entries; search a narrower path`
          : "",
        result.truncated
          ? "the sandbox stopped capturing output at its limit"
          : "",
      ].filter(Boolean);
      const body =
        shown.length > 0 ? shown.join("\n") : "No files found matching pattern";
      return finalizeResult(
        {
          content: [
            text(body + (notes.length > 0 ? `\n\n[${notes.join(". ")}]` : "")),
          ],
          details: undefined,
        },
        policy,
        label,
        details,
      );
    },
  };
}

export const shellTools = { bash: bashTool, grep: grepTool, find: findTool };
