import { randomUUID } from "node:crypto";
import {
  type AssistantMessage,
  createFauxCore,
  createProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type JsonObject,
  type Message,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type ToolCall,
  type ToolResultMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { parseActiveTasks, parseRoster, type RosterEntry } from "./prompt";

/**
 * The scripted test model: a keyless, deterministic stand-in for a real model
 * so tests, CI end-to-end runs and demos exercise the whole engine. It reads
 * the conversation (role from the tools it is offered, roster and active tasks
 * from the system prompt, earlier tool calls and results) and answers by rule.
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

export function createScriptedProvider(): Provider {
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
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
  });
  const respond = (context: TranscriptContext): AssistantMessage =>
    toAssistantMessage(scriptedTurn(context.messages));
  // The faux core streams queued responses; queueing exactly one dynamic
  // response per request (synchronously, right before it is taken) makes it a
  // pure function of the conversation, safe under concurrent sessions.
  const stream = (
    model: Model<string>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ) => {
    core.appendResponses([respond]);
    return core.stream(model, context, options);
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

/** The workspace file a worker writes for its piece. */
export const scriptedNotesFile = (botName: string) =>
  `notes-${slug(botName)}.md`;

interface Conversation {
  messages: Message[];
  prompt: string;
  tools: Set<string>;
  roster: RosterEntry[];
  self: RosterEntry | undefined;
  calls: { call: ToolCall; result: ToolResultMessage | undefined }[];
}

function readConversation(all: Message[]): Conversation {
  const messages = all.filter((message) => message.role !== "system");
  const roster = parseRoster(getCurrentSystemPrompt(all));
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
    prompt: getCurrentSystemPrompt(all),
    tools: new Set(getCurrentTools(all).map((tool) => tool.name)),
    roster,
    self: roster.find((entry) => entry.self),
    calls,
  };
}

/** The scripted model's next turn for a transcript. Pure and deterministic. */
export function scriptedTurn(all: Message[]): ScriptedTurn {
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
    const others = conversation.roster.filter((entry) => !entry.self);
    if (others.length > 0 && tools.has("delegate"))
      return {
        text: `Splitting the work between ${others.map((entry) => entry.name).join(" and ")}.`,
        calls: others.map((entry, index) => ({
          name: "delegate",
          args: {
            bot: entry.name,
            brief: `Part ${index + 1} of ${others.length} of "${clip(goal, 300)}": write a short note about your part to ${scriptedNotesFile(entry.name)} in the workspace, check the workspace with one shell command, and report back.`,
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
  const reports = new Map<string, string>();
  for (const text of since)
    for (const name of delegated)
      if (!reports.has(name) && mentions(text, name)) reports.set(name, text);
  const steering = since.filter(
    (text) => !delegated.some((name) => mentions(text, name)),
  );
  const pending = delegated.filter((name) => !reports.has(name));
  if (pending.length > 0)
    return {
      text: `Received the result from ${[...reports.keys()].join(" and ") || "nobody yet"}. Still waiting for ${pending.join(" and ")}.`,
    };
  const summary = [
    `Consolidated result for "${clip(goal, 300)}":`,
    ...delegated.map(
      (name) => `- ${name}: ${clip(reports.get(name) ?? "", 300)}`,
    ),
    ...steering.map((text) => `- Steering applied: ${clip(text, 300)}`),
  ].join("\n");
  return {
    text: "All results are in.",
    calls: [{ name: "complete_task", args: { result: summary } }],
  };
}

function workerTurn(conversation: Conversation): ScriptedTurn {
  const { messages, tools, calls } = conversation;
  const name = conversation.self?.name ?? "worker";
  const file = scriptedNotesFile(name);
  const brief = userTexts(messages)[0] ?? "my assignment";
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
    const content = `# ${name}\n\nMy piece of the work:\n\n${brief}\n`;
    if (tools.has("write"))
      return { calls: [{ name: "write", args: { path: file, content } }] };
    if (tools.has("bash"))
      return {
        calls: [
          {
            name: "bash",
            args: {
              command: `printf '%s\\n' ${shellQuote(`# ${name}`)} '' ${shellQuote(brief)} > ${file}`,
            },
          },
        ],
      };
    return {
      text: `I have no file tools, so here is my piece: ${clip(brief, 500)}`,
    };
  }
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
  const { messages, tools, prompt } = conversation;
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
  const self = conversation.self?.name;
  const isWork = WORK.test(text);
  if (!isWork && GREETING.test(text))
    return {
      text: `Hello! ${self ? `I'm ${self}. ` : ""}Tell me what you'd like done and I'll start a task for it.`,
    };
  if (!isWork && THANKS.test(text)) return { text: "You're welcome!" };

  const active = parseActiveTasks(prompt);
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
    const participants = conversation.roster
      .filter((entry) => !entry.self && mentions(text, entry.name))
      .map((entry) => entry.name);
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
