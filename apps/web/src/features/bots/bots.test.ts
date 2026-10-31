import {
  type ConversationMessage,
  emptyUsage,
  type ModelsView,
  type RuntimeProfile,
  type TaskSummary,
} from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { createDemoApi } from "../../api/demoApi";
import { botActivity } from "./botActivity";
import { DEFAULT_OPTION, modelOptions, profileOptions } from "./botOptions";
import { dayLabel, groupByDay } from "./chat";

const at = "2026-10-31T12:00:00.000Z";

const task = (
  id: string,
  patch: Partial<TaskSummary> & Pick<TaskSummary, "status">,
): TaskSummary => ({
  id,
  title: `Task ${id}`,
  goal: `Goal ${id}`,
  goalVersion: 1,
  coordinatorBotId: "juno",
  participantBotIds: ["juno", "moss"],
  result: null,
  error: null,
  cancelReason: null,
  cancelRequestedAt: null,
  createdAt: at,
  updatedAt: at,
  finishedAt: null,
  activeSessionCount: 0,
  sessionCount: 0,
  usage: emptyUsage(),
  ...patch,
});

describe("botActivity", () => {
  it("says what a working bot coordinates or works on", () => {
    const tasks = [task("a", { status: "running" })];
    expect(botActivity({ id: "juno", presence: "working" }, tasks)).toEqual({
      mood: "working",
      tone: "running",
      text: "Coordinating · Task a",
    });
    expect(botActivity({ id: "moss", presence: "working" }, tasks)).toEqual({
      mood: "working",
      tone: "running",
      text: "Working on Task a",
    });
  });

  it("counts several active tasks and skips finished ones", () => {
    const tasks = [
      task("a", { status: "running" }),
      task("b", { status: "queued", coordinatorBotId: "moss" }),
      task("c", { status: "completed" }),
    ];
    expect(botActivity({ id: "moss", presence: "working" }, tasks).text).toBe(
      "Coordinating · Task b",
    );
    expect(botActivity({ id: "juno", presence: "working" }, tasks).text).toBe(
      "Coordinating · Task a",
    );
    expect(
      botActivity({ id: "moss", presence: "working" }, [
        task("a", { status: "running" }),
        task("d", { status: "running" }),
      ]).text,
    ).toBe("Working on 2 tasks");
  });

  it("falls back to Working until the task list catches up", () => {
    expect(botActivity({ id: "kite", presence: "working" }, []).text).toBe(
      "Working",
    );
  });

  it("flags a task waiting on the user, otherwise idle", () => {
    const waiting = [task("w", { status: "waiting" })];
    expect(botActivity({ id: "juno", presence: "idle" }, waiting)).toEqual({
      mood: "idle",
      tone: "idle",
      text: "Waiting for you · Task w",
    });
    expect(botActivity({ id: "moss", presence: "idle" }, waiting).text).toBe(
      "Idle",
    );
    expect(
      botActivity({ id: "juno", presence: "idle" }, [
        task("w", { status: "waiting", cancelRequestedAt: at }),
      ]).text,
    ).toBe("Idle");
  });

  it("describes every demo bot", async () => {
    const api = createDemoApi({ autoplay: false, now: () => new Date(at) });
    const boot = await api.bootstrap();
    for (const bot of boot.bots) {
      const activity = botActivity(bot, boot.tasks);
      expect(activity.text.length).toBeGreaterThan(0);
      expect(activity.mood).toBe(
        bot.presence === "working" ? "working" : "idle",
      );
    }
  });
});

describe("day groups", () => {
  const now = new Date(2026, 9, 31, 15, 0);
  const message = (id: string, createdAt: Date): ConversationMessage => ({
    id,
    botId: "juno",
    sequence: Number(id),
    role: "user",
    text: id,
    taskId: null,
    createdAt: createdAt.toISOString(),
  });

  it("labels today, yesterday and older days", () => {
    expect(dayLabel(new Date(2026, 9, 31, 1).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 30, 23).toISOString(), now)).toBe(
      "Yesterday",
    );
    expect(dayLabel(new Date(2026, 9, 27, 9).toISOString(), now)).toBe(
      "Tue 27 Oct",
    );
    expect(dayLabel(new Date(2025, 0, 2, 9).toISOString(), now)).toBe(
      "Thu 2 Jan 2025",
    );
    expect(dayLabel("not a date", now)).toBe("");
  });

  it("groups consecutive messages by local day, in order", () => {
    const groups = groupByDay(
      [
        message("1", new Date(2026, 9, 30, 9)),
        message("2", new Date(2026, 9, 30, 18)),
        message("3", new Date(2026, 9, 31, 8)),
      ],
      now,
    );
    expect(
      groups.map((group) => [group.label, group.messages.map((m) => m.id)]),
    ).toEqual([
      ["Yesterday", ["1", "2"]],
      ["Today", ["3"]],
    ]);
  });
});

describe("inspector options", () => {
  const models: ModelsView = {
    defaultModel: "anthropic/claude-x",
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        configured: true,
        envVars: ["ANTHROPIC_API_KEY"],
        models: [
          {
            ref: "anthropic/claude-x",
            provider: "anthropic",
            id: "claude-x",
            name: "Claude X",
            reasoning: true,
            input: ["text"],
          },
        ],
      },
      {
        id: "openai",
        name: "OpenAI",
        configured: false,
        envVars: ["OPENAI_API_KEY"],
        models: [
          {
            ref: "openai/gpt-y",
            provider: "openai",
            id: "gpt-y",
            name: "GPT Y",
            reasoning: false,
            input: ["text"],
          },
        ],
      },
    ],
  };

  it("offers the server default, then models; unconfigured ones are disabled", () => {
    expect(modelOptions(models, null)).toEqual([
      { value: DEFAULT_OPTION, label: "Server default · anthropic/claude-x" },
      {
        value: "anthropic/claude-x",
        label: "Claude X · Anthropic",
        disabled: false,
      },
      {
        value: "openai/gpt-y",
        label: "GPT Y · OpenAI (not configured)",
        disabled: true,
      },
    ]);
  });

  it("keeps the bot's current model selectable, even when unlisted", () => {
    const current = modelOptions(models, "openai/gpt-y");
    expect(current.find((o) => o.value === "openai/gpt-y")?.disabled).toBe(
      false,
    );
    expect(modelOptions(null, "x/legacy").at(-1)).toEqual({
      value: "x/legacy",
      label: "x/legacy (not listed)",
    });
  });

  it("names the default profile and flags unavailable drivers", async () => {
    const api = createDemoApi({ autoplay: false, now: () => new Date(at) });
    const profiles: RuntimeProfile[] = await api.listProfiles();
    const options = profileOptions(profiles, null);
    const fallback = profiles.find((profile) => profile.isDefault);
    expect(options[0]).toEqual({
      value: DEFAULT_OPTION,
      label: fallback
        ? `Default profile · ${fallback.name}`
        : "Default profile",
    });
    expect(options).toHaveLength(profiles.length + 1);
    expect(profileOptions([], "gone").at(-1)).toEqual({
      value: "gone",
      label: "gone (not found)",
    });
  });
});
