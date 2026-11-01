/**
 * Demo data, shown only while the UI runs on `createDemoApi()`, always under
 * the "Demo data" badge. Records are contract shapes and are validated against
 * the contract schemas in demoApi.test.ts. Seeded tasks are not stored here:
 * the demo builds them by playing its task script, so their events and views
 * agree by construction.
 */

import {
  type BotAppearance,
  type Capabilities,
  CODING_TOOLS,
  type ModelsView,
  type RuntimeProfile,
  type SandboxDriverInfo,
  sandboxSpecSchema,
  z,
} from "@jj/contracts";
import type { ScriptHost, Step } from "./demoScript";

/** Minutes before the demo's start time, as an ISO timestamp. */
export type Ago = (minutes: number) => string;

export interface DemoBotSeed {
  id: string;
  name: string;
  role: string;
  instructions: string;
  appearance: BotAppearance;
  runtimeProfileId: string | null;
  memory: string;
}

export const DEMO_BOTS: readonly DemoBotSeed[] = [
  {
    id: "bot-juno",
    name: "Juno",
    role: "Coordinator",
    instructions:
      "Break goals into clear briefs, delegate to the right teammates, and combine their results into one answer.",
    appearance: {
      shape: "squircle",
      face: "visor",
      topper: "antenna",
      colour: "coral",
      body: "ivory",
      gait: "hop",
    },
    runtimeProfileId: null,
    memory:
      "Prefers small, reviewable changes.\nThe team keeps shared schemas in packages/contracts.",
  },
  {
    id: "bot-kite",
    name: "Kite",
    role: "Research",
    instructions:
      "Read specs and code, collect the constraints that matter, and summarise them with sources.",
    appearance: {
      shape: "round",
      face: "dots",
      topper: "dish",
      colour: "blue",
      body: "ivory",
      gait: "hop",
    },
    runtimeProfileId: null,
    memory: "",
  },
  {
    id: "bot-moss",
    name: "Moss",
    role: "Runtime & code",
    instructions:
      "Write focused TypeScript changes, run the relevant checks, and report the exact commands and output.",
    appearance: {
      shape: "block",
      face: "dots",
      topper: "sprout",
      colour: "green",
      body: "ivory",
      gait: "waddle",
    },
    runtimeProfileId: "profile-docker",
    memory: "Run lint and the unit tests before reporting back.",
  },
  {
    id: "bot-vesper",
    name: "Vesper",
    role: "Review & QA",
    instructions:
      "Review results against the goal and say plainly what is and isn't supported by evidence.",
    appearance: {
      shape: "gem",
      face: "mono",
      topper: "crest",
      colour: "violet",
      body: "ivory",
      gait: "glide",
    },
    runtimeProfileId: "profile-local",
    memory: "",
  },
];

const specJsonSchema = z.toJSONSchema(sandboxSpecSchema, {
  io: "input",
}) as Record<string, unknown>;

const DEMO_DETAIL = "Demo data: no sandbox runs in demo mode.";

export const DEMO_DRIVERS: readonly SandboxDriverInfo[] = [
  {
    id: "docker",
    label: "Docker",
    available: true,
    detail: DEMO_DETAIL,
    capabilities: {
      networkModes: ["none", "open"],
      resourceLimits: true,
      filesystemIsolation: true,
      exposePort: false,
      snapshot: false,
      metrics: false,
    },
    specJsonSchema,
  },
  {
    id: "local",
    label: "Local (unisolated)",
    available: true,
    detail: DEMO_DETAIL,
    capabilities: {
      networkModes: ["open"],
      resourceLimits: false,
      filesystemIsolation: false,
      exposePort: false,
      snapshot: false,
      metrics: false,
    },
    specJsonSchema,
  },
];

export function demoProfiles(ago: Ago): RuntimeProfile[] {
  return [
    {
      id: "profile-docker",
      name: "Docker sandbox",
      description:
        "Each task gets its own container with no network access and a persistent task workspace.",
      sandbox: sandboxSpecSchema.parse({
        driver: "docker",
        image: "node:22-bookworm-slim",
        resources: { cpus: 2, memoryMb: 2048 },
        network: { mode: "none" },
        workspace: "task",
      }),
      tools: [...CODING_TOOLS],
      budgets: { maxTurnsPerRun: 60, maxRunMinutes: 30 },
      isDefault: true,
      status: { driverAvailable: true, isolated: true, detail: DEMO_DETAIL },
      createdAt: ago(60 * 24 * 3),
      updatedAt: ago(60 * 24 * 3),
    },
    {
      id: "profile-local",
      name: "Local workspace",
      description:
        "Runs commands directly on the host in a task folder. Not isolated: only for trusted work.",
      sandbox: sandboxSpecSchema.parse({
        driver: "local",
        network: { mode: "open" },
        workspace: "task",
      }),
      tools: ["read", "grep", "find", "ls"],
      budgets: { maxTurnsPerRun: 30, maxRunMinutes: 15 },
      isDefault: false,
      status: { driverAvailable: true, isolated: false, detail: DEMO_DETAIL },
      createdAt: ago(60 * 24 * 2),
      updatedAt: ago(60 * 24 * 2),
    },
  ];
}

/** Model reference used in the demo's `model.finished` events. */
export const DEMO_MODEL_REF = "demo/sample";

/** Only demo data: no real provider is listed or configured. */
export const DEMO_MODELS: ModelsView = {
  defaultModel: null,
  providers: [
    {
      id: "demo",
      name: "Demo data (no model provider)",
      configured: false,
      envVars: [],
      models: [
        {
          ref: DEMO_MODEL_REF,
          provider: "demo",
          id: "sample",
          name: "Sample model (demo data)",
          reasoning: false,
          input: ["text"],
        },
      ],
    },
  ],
};

/** Nothing really runs in demo mode, so nothing is reported as able to. */
export const DEMO_CAPABILITIES: Capabilities = {
  agentExecution: false,
  persistence: false,
  streaming: false,
  verification: false,
  drivers: DEMO_DRIVERS.map((driver) => ({
    id: driver.id,
    available: driver.available,
    isolated: driver.capabilities.filesystemIsolation,
  })),
};

export interface DemoTaskSeed {
  id: string;
  goal: string;
  coordinatorBotId: string;
  participantBotIds: string[];
  /** When the seeded run started. */
  startedMinutesAgo: number;
  /** Scripted steps already played at load; `"all"` plays it to the end. */
  playedSteps: number | "all";
  /**
   * `ask`: the coordinator asks the user a question and waits. A function is
   * a custom script, for test fixtures (src/test/graphFixtures.ts).
   */
  script: "team" | "ask" | ((host: ScriptHost) => Step[]);
  /** Keeps advancing on the demo timer after load. */
  autoplay: boolean;
}

export const DEMO_TASKS: readonly DemoTaskSeed[] = [
  {
    id: "task-101",
    goal: "Check that the task stream resumes after a reconnect without gaps or duplicates",
    coordinatorBotId: "bot-juno",
    participantBotIds: ["bot-juno", "bot-moss", "bot-vesper"],
    startedMinutesAgo: 4,
    playedSteps: 4,
    script: "team",
    autoplay: true,
  },
  {
    id: "task-102",
    goal: "Summarise what changed in the 1.0 contracts for the web app",
    coordinatorBotId: "bot-kite",
    participantBotIds: ["bot-kite", "bot-vesper"],
    startedMinutesAgo: 80,
    playedSteps: "all",
    script: "team",
    autoplay: false,
  },
  {
    id: "task-103",
    goal: "Plan the rollout of the Docker sandbox driver",
    coordinatorBotId: "bot-juno",
    participantBotIds: ["bot-juno", "bot-moss"],
    startedMinutesAgo: 30,
    playedSteps: "all",
    script: "ask",
    autoplay: false,
  },
];

export interface DemoConversationSeed {
  botId: string;
  messages: {
    role: "user" | "assistant";
    text: string;
    minutesAgo: number;
    taskId?: string;
  }[];
}

export const DEMO_CONVERSATIONS: readonly DemoConversationSeed[] = [
  {
    botId: "bot-juno",
    messages: [
      {
        role: "user",
        text: "Can you check that the task stream resumes after a reconnect without gaps or duplicates?",
        minutesAgo: 5,
      },
      {
        role: "assistant",
        text: "I've started a demo task for this with Moss and Vesper. Its progress is simulated: no model runs in demo mode.",
        minutesAgo: 4,
        taskId: "task-101",
      },
    ],
  },
  {
    botId: "bot-kite",
    messages: [
      {
        role: "user",
        text: "Summarise what changed in the 1.0 contracts for the web app.",
        minutesAgo: 81,
      },
      {
        role: "assistant",
        text: "Started a demo task for that. Vesper will review the summary.",
        minutesAgo: 80,
        taskId: "task-102",
      },
    ],
  },
  { botId: "bot-moss", messages: [] },
  { botId: "bot-vesper", messages: [] },
];
