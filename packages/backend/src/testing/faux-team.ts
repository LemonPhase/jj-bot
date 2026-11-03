// Engine tests on the real pi runtime with several bots: one faux provider
// serves each request from the script of the bot whose session prompt it
// carries, so sessions running side by side each follow their own script,
// and a script can hold its model call open to stand in for a slow bot.
import {
  type AssistantMessage,
  type FauxResponseFactory,
  getSystemMessageText,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { TaskEvent, TaskView } from "@jj/contracts";
import type { Database } from "@jj/db";
import { ModelRegistry, PiSessionExecutor } from "@jj/runtime";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type fauxToolCall,
  lastMessage,
  textOf,
} from "@jj/runtime/testing";
import type { Engine } from "../engine";
import { promptBot } from "./fake-executor";
import { type TestEngine, testEngine } from "./harness";

export type Faux = ReturnType<typeof fauxProvider>;

/** One bot's model: its `n`th call (from 0) answers this request. */
export type Script = (
  context: TranscriptContext,
  n: number,
) => AssistantMessage | Promise<AssistantMessage>;

/** Routes every request to its bot's script; returns each bot's call count. */
export function route(faux: Faux, scripts: Record<string, Script>) {
  const calls: Record<string, number> = {};
  const step: FauxResponseFactory = (context) => {
    const system = context.messages.find(
      (message) => message.role === "system",
    );
    const bot = promptBot(
      system?.role === "system" ? getSystemMessageText(system) : "",
    );
    const script = scripts[bot];
    if (!script) throw new Error(`No script for ${bot}`);
    const n = calls[bot] ?? 0;
    calls[bot] = n + 1;
    return script(context, n);
  };
  faux.setResponses(Array.from({ length: 200 }, () => step));
  return calls;
}

/** An engine whose sessions run on the pi runtime with one faux provider. */
export async function fauxTeamEngine(
  database: Database,
): Promise<TestEngine & { faux: Faux }> {
  const faux = fauxProvider();
  const engine = await testEngine(database, {
    runExecutor: new PiSessionExecutor({
      models: new ModelRegistry({ env: {}, extraProviders: [faux.provider] }),
    }),
  });
  return { ...engine, faux };
}

/** A promise the test opens, such as a slow bot's model call. */
export function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** A model turn that calls tools, with optional text before them. */
export const turn = (calls: ReturnType<typeof fauxToolCall>[], text?: string) =>
  fauxAssistantMessage([...(text ? [fauxText(text)] : []), ...calls], {
    stopReason: "toolUse",
  });

/** The request's last message is the result of one of `bot`'s sessions. */
export const resultArrived = (context: TranscriptContext, bot: string) =>
  textOf(lastMessage(context)).startsWith(`Result from ${bot} (session`);

export const rootOf = (view: TaskView) =>
  view.sessions.find((session) => session.parentSessionId === null);

/** Every `tool.finished` event of the task, with full output previews. */
export async function toolFinished(engine: Engine, taskId: string) {
  const page = await engine.tasks.events(taskId);
  return page.events.filter(
    (event): event is Extract<TaskEvent, { type: "tool.finished" }> =>
      event.type === "tool.finished",
  );
}
