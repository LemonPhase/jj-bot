import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type JsonObject,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { LocalSandboxDriver, type Sandbox } from "@jj/sandbox";
import type { ExecutorEvent, RunHooks, TranscriptEntry } from "./types";

/** pi's faux provider, for tests in other packages that drive the real executor. */
export {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";

/**
 * A `local` sandbox under its own temporary root (never the shared default
 * root), its spec limits, and a cleanup that removes the root.
 */
export async function localSandbox(
  key = "task-1",
  limits: { execTimeoutMs?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "jj-runtime-test-"));
  const driver = new LocalSandboxDriver({ root });
  const spec = driver.validateSpec({
    driver: "local",
    network: { mode: "open" },
    limits,
  });
  const sandbox = await driver.acquire({
    sessionId: "session-1",
    taskId: key,
    spec,
    workspaceKey: key,
  });
  return {
    sandbox,
    limits: spec.limits,
    cleanup: async () => {
      await sandbox.release();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Wraps a sandbox and records every call that reaches it. */
export function recordingSandbox(sandbox: Sandbox) {
  const calls: string[] = [];
  const execs: { command: string; timeoutMs: number | undefined }[] = [];
  const fs = sandbox.fs;
  const spied: Sandbox = {
    id: sandbox.id,
    driverId: sandbox.driverId,
    workspaceDir: sandbox.workspaceDir,
    exec: (command, options) => {
      calls.push(`exec ${command}`);
      execs.push({ command, timeoutMs: options?.timeoutMs });
      return sandbox.exec(command, options);
    },
    fs: {
      read: (path) => {
        calls.push(`read ${path}`);
        return fs.read(path);
      },
      write: (path, data) => {
        calls.push(`write ${path}`);
        return fs.write(path, data);
      },
      remove: (path, options) => fs.remove(path, options),
      mkdir: (path) => {
        calls.push(`mkdir ${path}`);
        return fs.mkdir(path);
      },
      stat: (path) => {
        calls.push(`stat ${path}`);
        return fs.stat(path);
      },
      list: (path, options) => {
        calls.push(`list ${path}`);
        return fs.list(path, options);
      },
      move: (from, to) => fs.move(from, to),
    },
    release: (options) => sandbox.release(options),
  };
  return { sandbox: spied, calls, execs };
}

/** Hooks that record everything and serve inbox batches in order. */
export function recordingHooks(inbox: string[][] = []) {
  const events: ExecutorEvent[] = [];
  const entries: TranscriptEntry[] = [];
  const persistCalls: TranscriptEntry[][] = [];
  const spilled: { text: string; label: string }[] = [];
  let drains = 0;
  const hooks: RunHooks = {
    onEvent: (event) => {
      events.push(event);
    },
    onTurnComplete: (batch) => {
      persistCalls.push(batch);
      entries.push(...batch);
    },
    drainInbox: async () => {
      drains++;
      return inbox.shift() ?? [];
    },
    spillOutput: async (text, label) => {
      spilled.push({ text, label });
      return `artifact-${spilled.length}`;
    },
  };
  return {
    hooks,
    events,
    entries,
    persistCalls,
    spilled,
    get drains() {
      return drains;
    },
  };
}

export const textOf = (
  message: Message | TranscriptEntry | undefined,
): string => {
  if (!message || message.role === "system") return "";
  if (message.role === "compaction") return message.summary;
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
};

/** Non-system messages the model received. */
export const conversation = (context: TranscriptContext) =>
  context.messages.filter((message) => message.role !== "system");

export const lastMessage = (context: TranscriptContext) =>
  conversation(context).at(-1);

export const callTool = (name: string, args: JsonObject): AssistantMessage =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

export const say = (text: string): AssistantMessage =>
  fauxAssistantMessage(fauxText(text));

/** A faux step that runs `check` on the request before answering. */
export const expecting =
  (
    check: (context: TranscriptContext) => void,
    reply: AssistantMessage,
  ): FauxResponseStep =>
  (context) => {
    check(context);
    return reply;
  };

export const budgets = (maxTurns = 20, ms = 30_000) => ({
  maxTurns,
  deadline: new Date(Date.now() + ms),
});
