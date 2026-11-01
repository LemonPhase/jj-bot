import {
  type Bot,
  createBotCommandSchema,
  defaultAppearanceFor,
  updateBotCommandSchema,
} from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { APPEARANCE_PRESETS } from "../../lib/appearance";
import {
  createBotCommand,
  draftErrors,
  draftFromBot,
  exitRoute,
  matchingPreset,
  newBotDraft,
  type StudioAction,
  type StudioDraft,
  serverFieldErrors,
  studioReducer,
  UNNAMED_SEED,
  updateBotCommand,
} from "./studioDraft";

const run = (draft: StudioDraft, ...actions: StudioAction[]) =>
  actions.reduce(studioReducer, draft);

const bot: Bot = {
  id: "bot-moss",
  name: "Moss",
  role: "Runtime & code",
  instructions: "Write focused changes.",
  model: null,
  runtimeProfileId: "profile-docker",
  appearance: {
    shape: "block",
    face: "dots",
    topper: "sprout",
    colour: "green",
    body: "ivory",
    gait: "waddle",
  },
  presence: "idle",
  activeTaskIds: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("Studio appearance editing", () => {
  it("gives a new bot the deterministic default look, following its name", () => {
    const draft = newBotDraft();
    expect(draft.appearance).toEqual(defaultAppearanceFor(UNNAMED_SEED));
    const named = run(draft, { type: "field", field: "name", value: "Nova" });
    expect(named.appearance).toEqual(defaultAppearanceFor("Nova"));
    expect(named.look).toBe("name");
  });

  it("stops following the name once a part is picked", () => {
    const picked = run(
      newBotDraft(),
      { type: "field", field: "name", value: "Nova" },
      { type: "part", part: "colour", value: "pink" },
      { type: "field", field: "name", value: "Nova Prime" },
    );
    expect(picked.look).toBe("picked");
    expect(picked.appearance).toEqual({
      ...defaultAppearanceFor("Nova"),
      colour: "pink",
    });
  });

  it("applies a preset's six parts and keeps the typed name", () => {
    const juno = APPEARANCE_PRESETS[0];
    if (!juno) throw new Error("presets");
    const draft = run(
      newBotDraft(),
      { type: "field", field: "name", value: "Ada" },
      { type: "preset", appearance: juno.appearance },
    );
    expect(draft.appearance).toEqual(juno.appearance);
    expect(draft.name).toBe("Ada");
    expect(matchingPreset(draft.appearance)?.name).toBe("Juno");
    const custom = run(draft, { type: "part", part: "gait", value: "glide" });
    expect(matchingPreset(custom.appearance)).toBeUndefined();
  });

  it("starts an edit from the bot, with its look fixed", () => {
    const draft = draftFromBot(bot);
    expect(draft).toMatchObject({
      name: "Moss",
      model: "",
      runtimeProfileId: "profile-docker",
      look: "picked",
    });
    expect(
      run(draft, { type: "field", field: "name", value: "Mossy" }).appearance,
    ).toEqual(bot.appearance);
    expect(matchingPreset(draft.appearance)?.name).toBe("Moss");
  });
});

describe("Studio validation and commands", () => {
  it("checks the contract bounds", () => {
    expect(draftErrors(newBotDraft())).toEqual({
      name: "Give the bot a name.",
    });
    expect(
      draftErrors({
        ...newBotDraft(),
        name: "x".repeat(61),
        role: "r".repeat(81),
      }),
    ).toEqual({
      name: "The name can be at most 60 characters.",
      role: "The role can be at most 80 characters.",
    });
  });

  it("maps server validation issues onto fields", () => {
    expect(
      serverFieldErrors([
        { path: ["name"], message: "Too long" },
        { path: ["appearance", "shape"], message: "Bad shape" },
        "noise",
      ]),
    ).toEqual({ name: "Too long" });
    expect(serverFieldErrors(undefined)).toEqual({});
  });

  it("creates with the previewed appearance and nulls for the defaults", () => {
    const draft = run(
      newBotDraft(),
      { type: "field", field: "name", value: "  Nova " },
      { type: "field", field: "role", value: "Security review" },
    );
    const command = createBotCommand(draft);
    expect(command).toEqual({
      name: "Nova",
      role: "Security review",
      instructions: "",
      model: null,
      runtimeProfileId: null,
      appearance: defaultAppearanceFor("Nova"),
    });
    expect(createBotCommandSchema.safeParse(command).success).toBe(true);
  });

  it("updates only what changed", () => {
    const draft = draftFromBot(bot);
    expect(updateBotCommand(bot, draft)).toBeNull();
    expect(
      updateBotCommand(bot, {
        ...draft,
        instructions: " Write focused changes. ",
      }),
    ).toBeNull();
    const edited = run(
      draft,
      { type: "part", part: "colour", value: "teal" },
      { type: "field", field: "model", value: "anthropic/claude-haiku-4-5" },
      { type: "field", field: "runtimeProfileId", value: "" },
    );
    const command = updateBotCommand(bot, edited);
    expect(command).toEqual({
      model: "anthropic/claude-haiku-4-5",
      runtimeProfileId: null,
      appearance: { ...bot.appearance, colour: "teal" },
    });
    expect(updateBotCommandSchema.safeParse(command).success).toBe(true);
  });
});

describe("exitRoute", () => {
  it("returns to where Studio was opened from, never into Studio", () => {
    expect(exitRoute({ name: "tasks", taskId: "task-1" }, "bot-1")).toEqual({
      name: "tasks",
      taskId: "task-1",
    });
    expect(exitRoute({ name: "studio", botId: "bot-2" }, "bot-1")).toEqual({
      name: "bots",
      botId: "bot-1",
    });
    expect(exitRoute(null, null)).toEqual({ name: "bots", botId: null });
  });
});
