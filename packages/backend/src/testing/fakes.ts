// Fake chat responder and model catalog for engine tests: keyless and
// deterministic, shaped like the runtime's ChatResponder and ModelRegistry.
import { emptyUsage, type ModelsView, type ProviderInfo } from "@jj/contracts";
import type {
  ChatReply,
  ChatReplyInput,
  ChatResponder,
  CollabToolResult,
  ModelCatalog,
} from "../ports";
import { FAKE_MODEL, FAKE_USAGE } from "./fake-executor";

export interface ChatTurn {
  calls?: { name: string; args: Record<string, unknown> }[];
  text?: string;
}

/** Decides a reply from the input; tool results are visible to `after`. */
export type ChatBrain = (input: ChatReplyInput) => ChatTurn;

/** Bot name from the chat prompt. */
const chatBot = (prompt: string) =>
  /^You are (.+?)(?:, [^\n]*)?, a bot on a JJ Bot team\./.exec(prompt)?.[1] ??
  "unknown";

export class FakeChatResponder implements ChatResponder {
  readonly brains = new Map<string, ChatBrain>();
  readonly inputs: ChatReplyInput[] = [];
  /** Results of every tool call made, in order. */
  readonly toolResults: { name: string; result: CollabToolResult }[] = [];

  brain(bot: string, brain: ChatBrain): this {
    this.brains.set(bot, brain);
    return this;
  }

  async reply(input: ChatReplyInput): Promise<ChatReply> {
    this.inputs.push(input);
    const brain = this.brains.get(chatBot(input.systemPrompt));
    if (!brain) throw new Error("No chat brain for this bot.");
    const turn = brain(input);
    const results: string[] = [];
    for (const call of turn.calls ?? []) {
      const tool = input.tools.find(
        (candidate) => candidate.name === call.name,
      );
      if (!tool) throw new Error(`The reply has no tool ${call.name}.`);
      const result = await tool.execute(call.args, {
        toolCallId: `chat_${this.toolResults.length + 1}`,
        signal: input.signal,
      });
      this.toolResults.push({ name: call.name, result });
      results.push(result.text);
    }
    return {
      text: turn.text ?? results.join("\n"),
      model: FAKE_MODEL,
      usage: { ...emptyUsage(), ...FAKE_USAGE },
    };
  }
}

/** A catalog with one keyless "fake" provider, or nothing configured. */
export class FakeModels implements ModelCatalog {
  constructor(private readonly configured = true) {}

  providers(): ProviderInfo[] {
    return [
      {
        id: "fake",
        name: "Fake test model",
        configured: this.configured,
        envVars: [],
        models: [
          {
            ref: FAKE_MODEL,
            provider: "fake",
            id: "model",
            name: "Fake test model",
            reasoning: false,
            input: ["text"],
          },
        ],
      },
    ];
  }

  view(): ModelsView {
    return { defaultModel: this.defaultModel(), providers: this.providers() };
  }

  defaultModel() {
    return this.configured ? FAKE_MODEL : null;
  }

  resolve(ref: string | null) {
    if (!this.configured) throw new Error("No model provider is configured.");
    const wanted = ref ?? FAKE_MODEL;
    if (!wanted.startsWith("fake/"))
      throw new Error(`Model ${wanted} is not configured.`);
    return { ref: wanted };
  }
}
