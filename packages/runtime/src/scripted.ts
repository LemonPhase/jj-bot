import { createHash, randomUUID } from "node:crypto";
import {
  type AssistantMessage,
  createFauxCore,
  createProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  getCurrentTools,
  getSystemMessageText,
  type JsonObject,
  type JsonValue,
  type Message,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

/**
 * The scripted test model: a keyless, deterministic stand-in for a real model
 * so tests, CI end-to-end runs and demos exercise the whole engine. It reads
 * the conversation and answers by rule. The system prompt is free-form and
 * ignored; everything it needs comes from the tools it is offered:
 *
 * - its role: `create_task`/`send_to_task` → chat, `complete_task` →
 *   coordinator, otherwise worker;
 * - who it can delegate to: the enum of `delegate.parameters.properties.bot`
 *   (the engine leaves `delegate` out when there is nobody);
 * - the active tasks in chat: the enum of `send_to_task`'s `taskId`, with
 *   titles in its description (for example "task_7: Penguin report");
 * - the bots a chat can include: the item enum of `create_task`'s `participants`.
 *
 * Like a provider, it refuses a prompt longer than its context window
 * (estimated at four characters a token) with a context overflow error. Asked
 * for a compaction summary, it answers with one that records the summarised
 * conversation in a `<scripted-transcript>` block, and it reads that block
 * back as the start of the conversation, so its rules hold after compaction.
 *
 * It is always labelled "Scripted test model" and never poses as a real model.
 */
export const SCRIPTED_PROVIDER_ID = "scripted";
export const SCRIPTED_MODEL_ID = "team";
export const SCRIPTED_MODEL_REF = `${SCRIPTED_PROVIDER_ID}/${SCRIPTED_MODEL_ID}`;
export const SCRIPTED_MODEL_NAME = "Scripted test model";

interface PlannedCall {
  name: string;
  args: JsonObject;
}

/** What the scripted model says next: text, tool calls, or both. */
export interface ScriptedTurn {
  text?: string;
  calls?: PlannedCall[];
}

export interface ScriptedProviderOptions {
  /** The model's context window in tokens; default 128000. Tests use small ones to exercise compaction. */
  contextWindow?: number;
}

export function createScriptedProvider(
  options: ScriptedProviderOptions = {},
): Provider {
  const contextWindow = options.contextWindow ?? 128_000;
  const core = createFauxCore({
    api: "scripted",
    provider: SCRIPTED_PROVIDER_ID,
    models: [
      {
        id: SCRIPTED_MODEL_ID,
        name: SCRIPTED_MODEL_NAME,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 16_384,
      },
    ],
  });
  const respond = (context: TranscriptContext): AssistantMessage => {
    const tokens = promptTokens(context.messages);
    if (tokens > contextWindow)
      return fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: `prompt is too long: ${tokens} tokens > ${contextWindow} maximum`,
      });
    return toAssistantMessage(scriptedTurn(context.messages));
  };
  // The faux core streams queued responses; queueing exactly one dynamic
  // response per request (synchronously, right before it is taken) makes it a
  // pure function of the conversation, safe under concurrent sessions.
  const stream = (
    model: Model<string>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ) => {
    core.appendResponses([respond]);
    // No prompt cache: the faux core would count uncached tokens both as
    // input and as cache writes, overstating the context the usage reports.
    return core.stream(model, context, { ...options, cacheRetention: "none" });
  };
  return createProvider({
    id: SCRIPTED_PROVIDER_ID,
    name: SCRIPTED_MODEL_NAME,
    auth: {
      apiKey: {
        name: `${SCRIPTED_MODEL_NAME} (no key)`,
        resolve: async () => ({ auth: {} }),
      },
    },
    models: core.models,
    api: { stream, streamSimple: stream },
  });
}

function toAssistantMessage(turn: ScriptedTurn): AssistantMessage {
  const calls = turn.calls ?? [];
  const content = [
    ...(turn.text ? [fauxText(turn.text)] : []),
    ...calls.map((call) =>
      fauxToolCall(call.name, call.args, { id: `scripted_${randomUUID()}` }),
    ),
  ];
  return fauxAssistantMessage(content.length > 0 ? content : fauxText("OK."), {
    stopReason: calls.length > 0 ? "toolUse" : "stop",
  });
}

const promptText = (message: Message): string => {
  switch (message.role) {
    case "system":
      return [
        getSystemMessageText(message),
        ...(message.toolsAdded ?? []).map((tool) => JSON.stringify(tool)),
      ].join("\n");
    case "assistant":
      return message.content
        .map((block) =>
          block.type === "text"
            ? block.text
            : block.type === "thinking"
              ? block.thinking
              : `${block.name}:${JSON.stringify(block.arguments)}`,
        )
        .join("\n");
    case "toolResult":
      return `${message.toolName}\n${textOf(message.content)}`;
    default:
      return textOf(message.content);
  }
};

/** The prompt's size in tokens at four characters a token, as the faux core counts usage. */
export function promptTokens(messages: readonly Message[]): number {
  return Math.ceil(
    messages
      .map((message) => `${message.role}:${promptText(message)}`)
      .join("\n\n").length / 4,
  );
}

const textOf = (content: Message["content"]): string =>
  typeof content === "string"
    ? content
    : content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "bot";

/** The workspace file the scripted coordinator asks a bot to write. */
export const scriptedNotesFile = (botName: string) =>
  `notes-${slug(botName)}.md`;

/**
 * Commands a brief quotes after "run", as in run `sleep 20`, in order. A
 * scripted worker runs each once with bash after writing its notes, so a
 * goal can give a run a slow or failing step deterministically.
 */
export function scriptedCommands(brief: string): string[] {
  return [...brief.matchAll(/\brun `([^`\n]+)`/gi)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

/** A worker writes the notes file its brief names, else one named after the brief. */
const notesFileFor = (brief: string) =>
  /\bnotes-[a-z0-9-]+\.md\b/.exec(brief)?.[0] ??
  `notes-${createHash("sha256").update(brief).digest("hex").slice(0, 8)}.md`;

interface JsonSchema {
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  description?: string;
}

/** String choices of a schema: an `enum`, or `anyOf`/`oneOf` of `const`s. */
function choices(schema: JsonSchema | undefined): string[] {
  if (!schema) return [];
  if (Array.isArray(schema.enum))
    return schema.enum.filter(
      (value): value is string => typeof value === "string",
    );
  const variants = schema.anyOf ?? schema.oneOf ?? [];
  return variants
    .map((variant) => variant.const)
    .filter((value): value is string => typeof value === "string");
}

const parameter = (tool: Tool | undefined, name: string) =>
  (tool?.parameters as JsonSchema | undefined)?.properties?.[name];

/** The title that follows a task id in a description: "task_7: Penguin report". */
function titleOf(description: string, id: string, ids: string[]): string {
  const start = description.indexOf(id);
  if (start < 0) return "";
  let rest = description.slice(start + id.length);
  const ends = ["\n", ";", ...ids.filter((other) => other !== id)]
    .map((marker) => rest.indexOf(marker))
    .filter((index) => index >= 0);
  if (ends.length > 0) rest = rest.slice(0, Math.min(...ends));
  return rest.replace(/^[\s:=\-–—("']+/, "").replace(/[\s)"'.,]+$/, "");
}

interface Conversation {
  messages: Message[];
  tools: Map<string, Tool>;
  /** Bots `delegate` offers. */
  delegates: string[];
  /** Bots `create_task` can include. */
  bots: string[];
  /** Active tasks `send_to_task` offers. */
  activeTasks: { id: string; title: string }[];
  calls: { call: ToolCall; result: ToolResultMessage | undefined }[];
}

function readConversation(all: Message[]): Conversation {
  const messages = expandSummary(
    all.filter((message) => message.role !== "system"),
  );
  const tools = new Map(getCurrentTools(all).map((tool) => [tool.name, tool]));
  const taskId = parameter(tools.get("send_to_task"), "taskId");
  const taskIds = choices(taskId);
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages)
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  const calls: Conversation["calls"] = [];
  for (const message of messages)
    if (message.role === "assistant")
      for (const block of message.content)
        if (block.type === "toolCall")
          calls.push({ call: block, result: results.get(block.id) });
  return {
    messages,
    tools,
    delegates: choices(parameter(tools.get("delegate"), "bot")),
    bots: choices(parameter(tools.get("create_task"), "participants")?.items),
    activeTasks: taskIds.map((id) => ({
      id,
      title: titleOf(taskId?.description ?? "", id, taskIds),
    })),
    calls,
  };
}

/** The scripted model's next turn for a transcript. Pure and deterministic. */
export function scriptedTurn(all: Message[]): ScriptedTurn {
  const summary = scriptedSummary(all);
  if (summary !== undefined) return { text: summary };
  const conversation = readConversation(all);
  if (
    conversation.tools.has("create_task") ||
    conversation.tools.has("send_to_task")
  )
    return chatTurn(conversation);
  if (conversation.tools.has("complete_task"))
    return coordinatorTurn(conversation);
  return workerTurn(conversation);
}

/** Tool results at the end of the transcript, after the latest assistant message. */
function trailingResults(conversation: Conversation): ToolResultMessage[] {
  const results: ToolResultMessage[] = [];
  for (let index = conversation.messages.length - 1; index >= 0; index--) {
    const message = conversation.messages[index];
    if (message?.role !== "toolResult") break;
    results.unshift(message);
  }
  return results;
}

const userTexts = (messages: Message[]) =>
  messages
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content));

/**
 * The engine delivers a delegate's outcome to its parent as text whose first
 * line is exactly `Result from <bot> (session <id>):` or
 * `Failure from <bot> (session <id>):`.
 */
export function parseResultHeader(
  text: string,
): { ok: boolean; bot: string; sessionId: string; body: string } | undefined {
  const newline = text.indexOf("\n");
  const first = newline < 0 ? text : text.slice(0, newline);
  const match = /^(Result|Failure) from (.+) \(session ([^()\s]+)\):$/.exec(
    first,
  );
  if (!match?.[2] || !match[3]) return undefined;
  return {
    ok: match[1] === "Result",
    bot: match[2],
    sessionId: match[3],
    body: newline < 0 ? "" : text.slice(newline + 1).trim(),
  };
}

const mentions = (text: string, name: string) =>
  new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
    text,
  );

function coordinatorTurn(conversation: Conversation): ScriptedTurn {
  const { messages, tools, calls } = conversation;
  const goal = userTexts(messages)[0] ?? "the task";
  const trailing = trailingResults(conversation);

  const completion = trailing.find(
    (result) => result.toolName === "complete_task",
  );
  if (completion)
    return completion.isError
      ? {
          text: `I could not complete the task: ${clip(textOf(completion.content), 300)}`,
        }
      : { text: "The task is complete." };

  const delegations = calls.filter(({ call }) => call.name === "delegate");
  if (delegations.length === 0) {
    const others = conversation.delegates;
    if (others.length > 0 && tools.has("delegate"))
      return {
        text: `Splitting the work between ${others.join(" and ")}.`,
        calls: others.map((name, index) => ({
          name: "delegate",
          args: {
            bot: name,
            brief: `Part ${index + 1} of ${others.length} of "${clip(goal, 300)}": write a short note about your part to ${scriptedNotesFile(name)} in the workspace, check the workspace with one shell command, and report back.`,
          },
        })),
      };
    // Nobody to delegate to: do the work, then complete.
    const work = workerTurn(conversation);
    if (work.calls?.length) return work;
    return {
      text: "Done.",
      calls: [
        {
          name: "complete_task",
          args: { result: work.text ?? `Completed "${clip(goal, 300)}".` },
        },
      ],
    };
  }

  if (trailing.some((result) => result.toolName === "delegate")) {
    const failed = trailing.filter(
      (result) => result.toolName === "delegate" && result.isError,
    );
    const waitingFor = delegations
      .filter(({ result }) => result && !result.isError)
      .map(({ call }) => String(call.arguments.bot));
    if (waitingFor.length === 0)
      return {
        text: `Delegation failed: ${failed.map((result) => clip(textOf(result.content), 200)).join("; ")}`,
      };
    return { text: `Waiting for results from ${waitingFor.join(" and ")}.` };
  }

  // Woken with new input: results from workers, or steering from the user.
  const delegated = [
    ...new Set(
      delegations
        .filter(({ result }) => result && !result.isError)
        .map(({ call }) => String(call.arguments.bot)),
    ),
  ];
  const firstDelegation = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.content.some(
        (block) => block.type === "toolCall" && block.name === "delegate",
      ),
  );
  const since = userTexts(messages.slice(firstDelegation + 1));
  // Only the engine's header attributes a result; a mention of a name never does.
  const reports = new Map<string, { ok: boolean; body: string }>();
  const steering: string[] = [];
  for (const text of since) {
    const header = parseResultHeader(text);
    if (header && delegated.includes(header.bot) && !reports.has(header.bot))
      reports.set(header.bot, { ok: header.ok, body: header.body });
    else if (!header) steering.push(text);
  }
  const pending = delegated.filter((name) => !reports.has(name));
  if (pending.length > 0)
    return {
      text: `Received the result from ${[...reports.keys()].join(" and ") || "nobody yet"}. Still waiting for ${pending.join(" and ")}.`,
    };
  const summary = [
    `Consolidated result for "${clip(goal, 300)}":`,
    ...delegated.map((name) => {
      const report = reports.get(name);
      return `- ${name}${report?.ok ? "" : " (failed)"}: ${clip(report?.body ?? "", 300)}`;
    }),
    ...steering.map((text) => `- Steering applied: ${clip(text, 300)}`),
  ].join("\n");
  return {
    text: "All results are in.",
    calls: [{ name: "complete_task", args: { result: summary } }],
  };
}

function workerTurn(conversation: Conversation): ScriptedTurn {
  const { messages, tools, calls } = conversation;
  const brief = userTexts(messages)[0] ?? "my assignment";
  const file = notesFileFor(brief);
  const wrote = calls.find(
    ({ call }) =>
      (call.name === "write" && call.arguments.path === file) ||
      (call.name === "bash" && String(call.arguments.command).includes(file)),
  );
  const listed = calls.find(
    ({ call }) => call.name === "bash" && call.arguments.command === "ls -la",
  );
  const last = messages.at(-1);

  if (!wrote) {
    const content = `# Notes\n\nMy piece of the work:\n\n${brief}\n`;
    if (tools.has("write"))
      return { calls: [{ name: "write", args: { path: file, content } }] };
    if (tools.has("bash"))
      return {
        calls: [
          {
            name: "bash",
            args: {
              command: `printf '%s\\n' '# Notes' '' ${shellQuote(brief)} > ${file}`,
            },
          },
        ],
      };
    return {
      text: `I have no file tools, so here is my piece: ${clip(brief, 500)}`,
    };
  }
  const requested = scriptedCommands(brief).find(
    (command) =>
      !calls.some(
        ({ call }) =>
          call.name === "bash" && call.arguments.command === command,
      ),
  );
  if (requested && tools.has("bash"))
    return { calls: [{ name: "bash", args: { command: requested } }] };
  if (!listed && tools.has("bash"))
    return { calls: [{ name: "bash", args: { command: "ls -la" } }] };

  // Already reported: acknowledge a follow-up message instead of redoing the work.
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (
    last?.role === "user" &&
    lastAssistant?.role === "assistant" &&
    lastAssistant.stopReason === "stop"
  )
    return { text: `Acknowledged: ${clip(textOf(last.content), 300)}` };

  const writeFailed = wrote.result?.isError
    ? ` Writing it failed: ${clip(textOf(wrote.result.content), 200)}.`
    : "";
  const listing = listed?.result
    ? `\nWorkspace listing:\n${clip(textOf(listed.result.content), 1500)}`
    : "";
  return {
    text: `Done: I wrote ${file} describing my piece of "${clip(brief, 200)}".${writeFailed}${listing}`,
  };
}

const GREETING =
  /^\s*(hi|hello|hey|hiya|howdy|good (morning|afternoon|evening))\b[\s\w,!.]{0,20}$/i;
const THANKS = /\b(thanks|thank you|cheers|much appreciated)\b/i;
const WORK =
  /\b(please|can you|could you|would you|build|write|create|make|draft|research|investigate|analy[sz]e|fix|implement|plan|design|summari[sz]e|review|compare|prepare|set up|test|add|update|refactor|document)\b/i;
const STATUS = /\b(status|progress|how('s| is) it going|any news)\b/i;

function chatTurn(conversation: Conversation): ScriptedTurn {
  const { messages, tools, activeTasks: active } = conversation;
  const trailing = trailingResults(conversation);
  const first = trailing[0];
  if (first) {
    const detail = clip(textOf(first.content), 300);
    if (first.isError) return { text: `I couldn't do that: ${detail}` };
    return first.toolName === "send_to_task"
      ? { text: `I've passed that on to the task. ${detail}` }
      : { text: `I've started a task for that. ${detail}` };
  }

  const last = messages.at(-1);
  const text = last?.role === "user" ? textOf(last.content) : "";
  const isWork = WORK.test(text);
  if (!isWork && GREETING.test(text))
    return {
      text: "Hello! Tell me what you'd like done and I'll start a task for it.",
    };
  if (!isWork && THANKS.test(text)) return { text: "You're welcome!" };

  const lower = text.toLowerCase();
  const target =
    active.find(
      (task) =>
        text.includes(task.id) ||
        (task.title.length > 0 && lower.includes(task.title.toLowerCase())),
    ) ??
    (active.length === 1 && /\b(task|it)\b/i.test(text) && isWork
      ? active[0]
      : undefined);
  if (target && tools.has("send_to_task"))
    return {
      calls: [{ name: "send_to_task", args: { taskId: target.id, text } }],
    };

  if (isWork && tools.has("create_task")) {
    const participants = conversation.bots.filter((name) =>
      mentions(text, name),
    );
    return {
      calls: [{ name: "create_task", args: { goal: text, participants } }],
    };
  }

  if (STATUS.test(text))
    return {
      text:
        active.length > 0
          ? `I'm working on: ${active.map((task) => task.title || task.id).join("; ")}.`
          : "I have no active tasks right now.",
    };
  return {
    text: "I'm not sure what you'd like me to do yet. Ask me to work on something and I'll start a task.",
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Compaction. pi's summary requests serialize the conversation as text
// ("[User]: ...", "[Assistant]: ...", "[Assistant tool calls]: name(k=<json>,
// ...)", "[Tool result]: ..."); the scripted summary records it as JSON, with
// tool output clipped, and the reader turns that back into messages.

/** One summarised message. Tool results answer the calls before them, in order. */
type SummaryItem =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls: PlannedCall[] }
  | { role: "toolResult"; tool: string; text: string };

const TRANSCRIPT_OPEN = "<scripted-transcript>";
const TRANSCRIPT_CLOSE = "</scripted-transcript>";

const between = (text: string, open: string, close: string) => {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start
    ? text.slice(start + open.length, end)
    : undefined;
};

/** Every `<scripted-transcript>` block in a text, in order. */
function summaryItems(text: string): SummaryItem[] {
  const items: SummaryItem[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(TRANSCRIPT_OPEN, from);
    if (start < 0) return items;
    const end = text.indexOf(TRANSCRIPT_CLOSE, start);
    if (end < 0) return items;
    try {
      const parsed = JSON.parse(
        text.slice(start + TRANSCRIPT_OPEN.length, end),
      ) as SummaryItem[];
      if (Array.isArray(parsed)) items.push(...parsed);
    } catch {
      // Not ours; ignore it.
    }
    from = end + TRANSCRIPT_CLOSE.length;
  }
}

/** Where a JSON value that starts at `start` ends, or -1. */
function jsonEnd(text: string, start: number): number {
  const skipString = (from: number) => {
    for (let index = from + 1; index < text.length; index++) {
      if (text[index] === "\\") index++;
      else if (text[index] === '"') return index + 1;
    }
    return -1;
  };
  const first = text[start];
  if (first === '"') return skipString(start);
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (char === '"') {
        const next = skipString(index);
        if (next < 0) return -1;
        index = next - 1;
      } else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0) return index + 1;
      }
    }
    return -1;
  }
  let index = start;
  while (index < text.length && text[index] !== "," && text[index] !== ")")
    index++;
  return index;
}

/** `name(k=<json>, k2=<json>); name2()` back to calls. */
function parseCalls(text: string): PlannedCall[] {
  const calls: PlannedCall[] = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf("(", index);
    if (open < 0) break;
    const name = text.slice(index, open).trim();
    const args: JsonObject = {};
    index = open + 1;
    while (index < text.length && text[index] !== ")") {
      const equals = text.indexOf("=", index);
      if (equals < 0) return calls;
      const end = jsonEnd(text, equals + 1);
      if (end < 0) return calls;
      try {
        args[text.slice(index, equals).trim()] = JSON.parse(
          text.slice(equals + 1, end),
        ) as JsonValue;
      } catch {
        return calls;
      }
      index = text.startsWith(", ", end) ? end + 2 : end;
    }
    calls.push({ name, args });
    index += 1;
    if (text.startsWith("; ", index)) index += 2;
  }
  return calls;
}

const PART =
  /\n\n(?=\[(?:User|Assistant|Assistant tool calls|Tool result)\]: )/;

/** pi's serialized conversation back to items; tool output is clipped. */
function parseSerialized(text: string): SummaryItem[] {
  const items: SummaryItem[] = [];
  const pendingTools: string[] = [];
  for (const part of text.split(PART)) {
    const match =
      /^\[(User|Assistant|Assistant tool calls|Tool result)\]: ([\s\S]*)$/.exec(
        part,
      );
    if (!match) continue;
    const [, kind, body = ""] = match;
    if (kind === "User") items.push({ role: "user", text: body });
    else if (kind === "Assistant")
      items.push({ role: "assistant", text: body, calls: [] });
    else if (kind === "Assistant tool calls") {
      const calls = parseCalls(body);
      const last = items.at(-1);
      if (last?.role === "assistant" && last.calls.length === 0)
        last.calls = calls;
      else items.push({ role: "assistant", text: "", calls });
      pendingTools.splice(0, pendingTools.length, ...calls.map((c) => c.name));
    } else
      items.push({
        role: "toolResult",
        tool: pendingTools.shift() ?? "tool",
        text: clip(body, 300),
      });
  }
  return items;
}

/**
 * The scripted model's answer to a compaction summary request: pi's
 * history format (`<conversation>`, optionally `<previous-summary>`) or its
 * turn-prefix format (`# Conversation`). Undefined for any other request.
 */
export function scriptedSummary(all: Message[]): string | undefined {
  if (getCurrentTools(all).length > 0) return undefined;
  const last = all.at(-1);
  if (last?.role !== "user") return undefined;
  const prompt = textOf(last.content);
  let conversation: string | undefined;
  let previous: SummaryItem[] = [];
  if (prompt.startsWith("<conversation>\n")) {
    conversation = between(prompt, "<conversation>\n", "\n</conversation>");
    const earlier = between(
      prompt,
      "<previous-summary>\n",
      "\n</previous-summary>",
    );
    if (earlier) previous = summaryItems(earlier);
  } else if (prompt.startsWith("# Conversation\n"))
    conversation = between(prompt, "# Conversation\n", "\n\n# Instructions\n");
  if (conversation === undefined) return undefined;
  const items = [...previous, ...parseSerialized(conversation)];
  const goal = items.find((item) => item.role === "user")?.text ?? "";
  const done = items.flatMap((item) =>
    item.role === "assistant"
      ? item.calls.map((call) => `- [x] ${call.name}`)
      : [],
  );
  return [
    "## Goal",
    clip(goal, 500) || "(none)",
    "",
    "## Progress",
    "### Done",
    ...(done.length > 0 ? done : ["- (nothing yet)"]),
    "",
    "## Critical Context",
    `${TRANSCRIPT_OPEN}${JSON.stringify(items)}${TRANSCRIPT_CLOSE}`,
  ].join("\n");
}

/** A leading compaction summary of its own, as the messages it records. */
function expandSummary(messages: Message[]): Message[] {
  const [first, ...rest] = messages;
  if (first?.role !== "user") return messages;
  const items = summaryItems(textOf(first.content));
  if (items.length === 0) return messages;
  const expanded: Message[] = [];
  let open: ToolCall[] = [];
  items.forEach((item, index) => {
    if (item.role === "user")
      expanded.push({
        role: "user",
        content: [{ type: "text", text: item.text }],
        timestamp: 0,
      });
    else if (item.role === "assistant") {
      open = item.calls.map((call, n) =>
        fauxToolCall(call.name, call.args, { id: `summarised_${index}_${n}` }),
      );
      expanded.push(
        fauxAssistantMessage(
          [...(item.text ? [fauxText(item.text)] : []), ...open],
          { stopReason: open.length > 0 ? "toolUse" : "stop", timestamp: 0 },
        ),
      );
    } else {
      const call = open.shift();
      expanded.push({
        role: "toolResult",
        toolCallId: call?.id ?? `summarised_${index}`,
        toolName: call?.name ?? item.tool,
        content: [{ type: "text", text: item.text }],
        isError: false,
        timestamp: 0,
      });
    }
  });
  return [...expanded, ...rest];
}
