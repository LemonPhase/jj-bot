/** Contract-shaped records for the office unit tests. Not used by the app. */
import {
  type Bot,
  type BotAppearance,
  type ExecutionSession,
  emptyUsage,
  type Task,
  type TaskEvent,
  type TaskEventOf,
  type TaskEventType,
  type TaskMessage,
  type TaskView,
} from "@jj/contracts";

const T0 = Date.parse("2026-10-31T15:00:00.000Z");

/** An ISO time `minutes` after the fixture start. */
export const at = (minutes: number) =>
  new Date(T0 + minutes * 60_000).toISOString();

const appearance = (over: Partial<BotAppearance>): BotAppearance => ({
  shape: "squircle",
  face: "dots",
  topper: "none",
  colour: "coral",
  body: "ivory",
  gait: "hop",
  ...over,
});

export const bot = (
  id: string,
  name: string,
  look: Partial<BotAppearance> = {},
): Bot => ({
  id,
  name,
  role: "",
  instructions: "",
  model: null,
  runtimeProfileId: null,
  appearance: appearance(look),
  presence: "idle",
  activeTaskIds: [],
  createdAt: at(0),
  updatedAt: at(0),
});

export const bots: Bot[] = [
  bot("bot-juno", "Juno", {
    shape: "squircle",
    face: "visor",
    topper: "antenna",
  }),
  bot("bot-moss", "Moss", {
    shape: "block",
    topper: "sprout",
    colour: "green",
  }),
  bot("bot-vesper", "Vesper", {
    shape: "gem",
    face: "mono",
    topper: "crest",
    colour: "violet",
  }),
  bot("bot-kite", "Kite", { shape: "round", topper: "dish", colour: "blue" }),
];

export const task = (over: Partial<Task> = {}): Task => ({
  id: "task-1",
  title: "Task",
  goal: "Do the thing",
  goalVersion: 1,
  coordinatorBotId: "bot-juno",
  participantBotIds: ["bot-juno", "bot-moss", "bot-vesper"],
  status: "running",
  result: null,
  error: null,
  cancelReason: null,
  cancelRequestedAt: null,
  createdAt: at(0),
  updatedAt: at(0),
  finishedAt: null,
  ...over,
});

export const session = (over: Partial<ExecutionSession>): ExecutionSession => ({
  id: "s",
  taskId: "task-1",
  botId: "bot-juno",
  parentSessionId: null,
  role: "coordinator",
  brief: "Brief",
  goalVersion: 1,
  depth: over.parentSessionId ? 1 : 0,
  status: "running",
  waitingFor: null,
  result: null,
  error: null,
  activity: null,
  runCount: 1,
  createdAt: at(0),
  updatedAt: at(0),
  startedAt: at(0),
  finishedAt: null,
  ...over,
});

export const message = (over: Partial<TaskMessage>): TaskMessage => ({
  id: "m",
  taskId: "task-1",
  sequence: 1,
  authorKind: "bot",
  authorBotId: "bot-juno",
  sessionId: null,
  intent: "discussion",
  text: "hello",
  recipientBotIds: [],
  createdAt: at(0),
  ...over,
});

export function event<Type extends TaskEventType>(
  sequence: number,
  type: Type,
  payload: TaskEventOf<Type>["payload"],
  occurredAt: string,
): TaskEvent {
  return {
    id: `e${sequence}`,
    taskId: "task-1",
    sequence,
    occurredAt,
    botId: null,
    sessionId: null,
    runId: null,
    causedBy: null,
    type,
    payload,
  } as TaskEvent;
}

export const taskView = (over: Partial<TaskView> = {}): TaskView => ({
  task: task(),
  sessions: [],
  messages: [],
  artifacts: [],
  usage: { total: emptyUsage(), bySession: {} },
  events: [],
  firstSequence: 1,
  hasEarlier: false,
  cursor: over.events?.at(-1)?.sequence ?? 0,
  ...over,
});
