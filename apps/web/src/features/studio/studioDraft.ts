import {
  type Bot,
  type BotAppearance,
  type CreateBotCommand,
  createBotCommandSchema,
  defaultAppearanceFor,
  type UpdateBotCommand,
} from "@jj/contracts";
import {
  APPEARANCE_PRESETS,
  type AppearancePreset,
} from "../../lib/appearance";
import type { Route } from "../shell/router";

/**
 * Bot Studio's editing state: identity, model, runtime profile and the six
 * appearance parts. Pure, so the screen is a thin view over it.
 *
 * A new bot's look is `defaultAppearanceFor(name)` (brief decision 4) and
 * follows the name as it is typed, the same look the server would give it,
 * until a part or preset is picked. Preview motion is not part of the draft:
 * it is never persisted.
 */

export type AppearancePart = keyof BotAppearance;

export interface StudioDraft {
  name: string;
  role: string;
  instructions: string;
  /** A model ref, or "" for the server default (null). */
  model: string;
  /** A profile id, or "" for the default profile (null). */
  runtimeProfileId: string;
  appearance: BotAppearance;
  /** `name`: the look still follows the name; `picked`: the user chose it. */
  look: "name" | "picked";
}

export type TextField = "name" | "role" | "instructions";
export type DraftField = TextField | "model" | "runtimeProfileId";

export type StudioAction =
  | { type: "field"; field: DraftField; value: string }
  | {
      type: "part";
      part: AppearancePart;
      value: BotAppearance[AppearancePart];
    }
  | { type: "preset"; appearance: BotAppearance }
  | { type: "reset"; draft: StudioDraft };

/** The seed for a new bot's look while it has no name. */
export const UNNAMED_SEED = "New bot";

const lookFor = (name: string) =>
  defaultAppearanceFor(name.trim() || UNNAMED_SEED);

export function newBotDraft(): StudioDraft {
  return {
    name: "",
    role: "",
    instructions: "",
    model: "",
    runtimeProfileId: "",
    appearance: lookFor(""),
    look: "name",
  };
}

export function draftFromBot(bot: Bot): StudioDraft {
  return {
    name: bot.name,
    role: bot.role,
    instructions: bot.instructions,
    model: bot.model ?? "",
    runtimeProfileId: bot.runtimeProfileId ?? "",
    appearance: { ...bot.appearance },
    look: "picked",
  };
}

export function studioReducer(
  draft: StudioDraft,
  action: StudioAction,
): StudioDraft {
  switch (action.type) {
    case "field": {
      const next = { ...draft, [action.field]: action.value };
      if (action.field === "name" && draft.look === "name")
        next.appearance = lookFor(action.value);
      return next;
    }
    case "part":
      return {
        ...draft,
        appearance: { ...draft.appearance, [action.part]: action.value },
        look: "picked",
      };
    case "preset":
      return { ...draft, appearance: { ...action.appearance }, look: "picked" };
    case "reset":
      return action.draft;
  }
}

export const sameAppearance = (a: BotAppearance, b: BotAppearance) =>
  a.shape === b.shape &&
  a.face === b.face &&
  a.topper === b.topper &&
  a.colour === b.colour &&
  a.body === b.body &&
  a.gait === b.gait;

/** The preset whose six parts all match, as the preset tiles show it. */
export function matchingPreset(
  appearance: BotAppearance,
): AppearancePreset | undefined {
  return APPEARANCE_PRESETS.find((preset) =>
    sameAppearance(preset.appearance, appearance),
  );
}

export type DraftErrors = Partial<Record<TextField, string>>;

const FIELD_NOUN: Record<TextField, string> = {
  name: "The name",
  role: "The role",
  instructions: "The instructions",
};

/** Client-side checks with the contract's own bounds; the server checks again. */
export function draftErrors(draft: StudioDraft): DraftErrors {
  const parsed = createBotCommandSchema.safeParse({
    name: draft.name,
    role: draft.role,
    instructions: draft.instructions,
  });
  if (parsed.success) return {};
  const errors: DraftErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field !== "name" && field !== "role" && field !== "instructions")
      continue;
    if (errors[field]) continue;
    if (issue.code === "too_small" && field === "name")
      errors[field] = "Give the bot a name.";
    else if (issue.code === "too_big" && "maximum" in issue)
      errors[field] =
        `${FIELD_NOUN[field]} can be at most ${Number(issue.maximum).toLocaleString("en-US")} characters.`;
    else errors[field] = issue.message;
  }
  return errors;
}

/** Maps a server VALIDATION_FAILED issue list (zod issues) onto the form's text fields. */
export function serverFieldErrors(details: unknown): DraftErrors {
  if (!Array.isArray(details)) return {};
  const errors: DraftErrors = {};
  for (const issue of details as unknown[]) {
    if (typeof issue !== "object" || issue === null) continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    const field: unknown = Array.isArray(path) ? path[0] : undefined;
    if (
      (field === "name" || field === "role" || field === "instructions") &&
      typeof message === "string" &&
      !errors[field]
    )
      errors[field] = message;
  }
  return errors;
}

const orNull = (value: string) => (value === "" ? null : value);

/** `POST /api/bots`. The appearance is always sent, so the bot looks as previewed. */
export function createBotCommand(draft: StudioDraft): CreateBotCommand {
  return {
    name: draft.name.trim(),
    role: draft.role.trim(),
    instructions: draft.instructions.trim(),
    model: orNull(draft.model),
    runtimeProfileId: orNull(draft.runtimeProfileId),
    appearance: { ...draft.appearance },
  };
}

/** `PATCH /api/bots/:id` with only the fields that changed; null when none did. */
export function updateBotCommand(
  bot: Bot,
  draft: StudioDraft,
): UpdateBotCommand | null {
  const command: UpdateBotCommand = {};
  const name = draft.name.trim();
  const role = draft.role.trim();
  const instructions = draft.instructions.trim();
  if (name !== bot.name) command.name = name;
  if (role !== bot.role) command.role = role;
  if (instructions !== bot.instructions) command.instructions = instructions;
  if (orNull(draft.model) !== bot.model) command.model = orNull(draft.model);
  if (orNull(draft.runtimeProfileId) !== bot.runtimeProfileId)
    command.runtimeProfileId = orNull(draft.runtimeProfileId);
  // The appearance is one value in the contract: all six parts or none.
  if (!sameAppearance(draft.appearance, bot.appearance))
    command.appearance = { ...draft.appearance };
  return Object.keys(command).length > 0 ? command : null;
}

/**
 * Where Cancel (and a successful save) leaves Studio for: the route the user
 * came from, else the bot being edited, else the bot list. Never back into
 * Studio itself.
 */
export function exitRoute(previous: Route | null, botId: string | null): Route {
  if (previous && previous.name !== "studio") return previous;
  return { name: "bots", botId };
}
