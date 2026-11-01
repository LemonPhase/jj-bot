import { posix } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createLsTool } from "@earendil-works/pi-coding-agent";
import type { ToolName } from "@jj/contracts";
import type { Sandbox, SandboxStat } from "@jj/sandbox";
import {
  finalizeResult,
  guarded,
  type OutputPolicy,
  type SandboxToolOptions,
  statOrThrow,
  workspacePath,
} from "./tools";
import { fileTools } from "./tools-files";
import { shellTools } from "./tools-shell";

/**
 * pi's ls on sandbox-backed operations. It resolves paths lexically (no host
 * filesystem access), and its argument is already contained by
 * `workspacePath`.
 */
function lsTool(
  sandbox: Sandbox,
  policy: OutputPolicy,
  options: SandboxToolOptions,
): AgentTool {
  const kinds = new Map<string, SandboxStat["kind"]>();
  const tool = createLsTool(sandbox.workspaceDir, {
    operations: {
      exists: async (path) => (await sandbox.fs.stat(path)) !== undefined,
      stat: async (path) => {
        const kind = kinds.get(path) ?? (await statOrThrow(sandbox, path)).kind;
        return { isDirectory: () => kind === "directory" };
      },
      readdir: async (path) => {
        kinds.clear();
        const entries = await sandbox.fs.list(path);
        return entries.map((entry) => {
          const absolute = posix.isAbsolute(entry.path)
            ? entry.path
            : posix.join(path, entry.path);
          kinds.set(absolute, entry.kind);
          return posix.basename(absolute);
        });
      },
    },
  });
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
        `ls: ${String(args.path).slice(0, 120)}`,
      );
    },
  };
}

/** The coding tools a profile grants, bound to the task's sandbox. */
export function createSandboxTools(
  sandbox: Sandbox,
  names: readonly ToolName[],
  policy: OutputPolicy,
  options: SandboxToolOptions,
): AgentTool[] {
  const build: Record<ToolName, () => AgentTool> = {
    bash: () => shellTools.bash(sandbox, policy, options),
    grep: () => shellTools.grep(sandbox, policy, options),
    find: () => shellTools.find(sandbox, policy, options),
    read: () => fileTools.read(sandbox, policy, options),
    edit: () => fileTools.edit(sandbox, policy, options),
    write: () => fileTools.write(sandbox, policy, options),
    ls: () => lsTool(sandbox, policy, options),
  };
  return [...new Set(names)].map((name) => build[name]());
}
