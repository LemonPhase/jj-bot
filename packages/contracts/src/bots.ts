import { z } from "zod";
import {
  COMMAND_TEXT_LIMIT,
  hasSomeField,
  idListSchema,
  idSchema,
  modelRefSchema,
  RECORD_TEXT_LIMIT,
  SOME_FIELD_REQUIRED,
  timestampSchema,
} from "./common";

// Bot Studio appearance options (C2 · Pixel Lite design). The UI owns labels and pixel art.
export const BOT_SHAPES = [
  "squircle",
  "round",
  "block",
  "gem",
  "dome",
] as const;
export const BOT_FACES = ["dots", "visor", "screen", "mono"] as const;
export const BOT_TOPPERS = [
  "antenna",
  "dish",
  "sprout",
  "crest",
  "propeller",
  "halo",
  "none",
] as const;
export const BOT_COLOURS = [
  "coral",
  "amber",
  "lime",
  "green",
  "teal",
  "blue",
  "violet",
  "pink",
] as const;
export const BOT_BODIES = ["ivory", "graphite"] as const;
export const BOT_GAITS = ["hop", "glide", "waddle"] as const;

/** How a bot looks and moves in the office and the Bot Studio. Purely cosmetic. */
export const botAppearanceSchema = z.object({
  shape: z.enum(BOT_SHAPES),
  face: z.enum(BOT_FACES),
  topper: z.enum(BOT_TOPPERS),
  colour: z.enum(BOT_COLOURS),
  body: z.enum(BOT_BODIES),
  gait: z.enum(BOT_GAITS),
});

export type BotAppearance = z.infer<typeof botAppearanceSchema>;

/** 32-bit FNV-1a. Stable across runtimes, so server and client agree. */
const hash = (text: string): number => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
};

const pick = <Value>(
  values: readonly Value[],
  seed: string,
  part: string,
): Value => values[hash(`${part}:${seed}`) % values.length] as Value;

/** A deterministic appearance for a new bot, spread across colours and shapes by the seed. */
export function defaultAppearanceFor(seed: string): BotAppearance {
  return {
    shape: pick(BOT_SHAPES, seed, "shape"),
    face: pick(BOT_FACES, seed, "face"),
    topper: pick(BOT_TOPPERS, seed, "topper"),
    colour: pick(BOT_COLOURS, seed, "colour"),
    body: pick(BOT_BODIES, seed, "body"),
    gait: pick(BOT_GAITS, seed, "gait"),
  };
}

/**
 * Characters a bot's name and role never hold. Both appear unquoted in
 * model-facing text (the persona line, the team roster, the `delegate` and
 * `message` tool descriptions, entry headers, `task_log` index lines and
 * handoff notes), where any of these could forge a line, reorder what a
 * reader sees or hide text a model still reads:
 * - every control character (`\p{Cc}`: LF, CR, VT, FF and NEL among them),
 *   and LS and PS;
 * - Unicode's Bidi_Control set: U+061C, U+200E, U+200F, U+202A to U+202E and
 *   U+2066 to U+2069;
 * - the invisible U+180E, U+200B, U+2060 to U+2064, U+206A to U+206F, U+FEFF
 *   and U+FFF9 to U+FFFB;
 * - the tag characters U+E0000 to U+E007F;
 * - lone surrogates.
 * ZWNJ and ZWJ (U+200C, U+200D) are allowed: scripts and emoji need them.
 * Migration 0012 refuses the same set (a test compares the two over every
 * code point) and normalised the names and roles stored before this rule.
 */
const NOT_ONE_LINE =
  /[\p{Cc}\u061C\u180E\u200B\u200E\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}\uD800-\uDFFF]/u;

const LINE_BREAKS = /[\n\r\v\f\u0085\u2028\u2029]/;
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/** What a refused character is, for the field error. */
function refusedKind(character: string): string {
  const code = character.codePointAt(0) ?? 0;
  if (LINE_BREAKS.test(character)) return "a line break";
  if (character === "\t") return "a tab";
  if (BIDI_CONTROLS.test(character)) return "a bidirectional control";
  if (code >= 0xe0000) return "a tag character";
  if (code >= 0xd800 && code <= 0xdfff) return "a lone surrogate";
  if (code <= 0x9f) return "a control character";
  return "an invisible character";
}

const codePoint = (character: string) =>
  `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/** Refines a text to one line of plain text, naming the first refused character. */
const oneLine =
  (noun: string) => (text: string, context: z.RefinementCtx<string>) => {
    const refused = NOT_ONE_LINE.exec(text)?.[0];
    if (refused !== undefined)
      context.addIssue({
        code: "custom",
        message: `${noun} is one line of plain text: remove ${codePoint(refused)} (${refusedKind(refused)}).`,
      });
  };

/** One line of plain text, 1 to 60 characters once trimmed. */
const botNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .superRefine(oneLine("A bot name"));
/** One line of plain text, at most 80 characters once trimmed. */
const botRoleSchema = z
  .string()
  .trim()
  .max(80)
  .superRefine(oneLine("A bot role"));
const botInstructionsSchema = z.string().trim().max(COMMAND_TEXT_LIMIT);

/** Derived by the server: `working` while the bot has a queued or running session. */
export const botPresenceSchema = z.enum(["idle", "working"]);

export const botSchema = z.object({
  id: idSchema,
  name: botNameSchema,
  role: botRoleSchema.default(""),
  instructions: botInstructionsSchema.default(""),
  /** Null uses the server's default model. */
  model: modelRefSchema.nullable(),
  /** Null uses the default runtime profile. */
  runtimeProfileId: idSchema.nullable(),
  appearance: botAppearanceSchema,
  presence: botPresenceSchema,
  /** Tasks the bot participates in that have not finished. */
  activeTaskIds: idListSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * `POST /api/bots`. Omitted fields take server defaults: empty role and
 * instructions, the default model and profile, and `defaultAppearanceFor(name)`.
 */
export const createBotCommandSchema = z.object({
  name: botNameSchema,
  role: botRoleSchema.optional(),
  instructions: botInstructionsSchema.optional(),
  model: modelRefSchema.nullable().optional(),
  runtimeProfileId: idSchema.nullable().optional(),
  appearance: botAppearanceSchema.optional(),
});

/** The bot update command without its at-least-one-field refinement. */
export const updateBotCommandObjectSchema = createBotCommandSchema.partial();

/** `PATCH /api/bots/:id`. */
export const updateBotCommandSchema = updateBotCommandObjectSchema.refine(
  hasSomeField,
  SOME_FIELD_REQUIRED,
);

const memoryTextSchema = z.string().max(COMMAND_TEXT_LIMIT);

/** A bot's durable memory: facts promoted deliberately, shared by all its sessions. */
export const botMemorySchema = z.object({
  botId: idSchema,
  text: memoryTextSchema,
  updatedAt: timestampSchema,
});

/** `PUT /api/bots/:id/memory`. */
export const updateBotMemoryCommandSchema = z.object({
  text: memoryTextSchema,
});

/** A message in the direct chat between the user and one bot. */
export const conversationMessageSchema = z.object({
  id: idSchema,
  botId: idSchema,
  /** Per bot, starting at 1. */
  sequence: z.number().int().min(1),
  role: z.enum(["user", "assistant"]),
  /** As produced; the engine posts "(no text)" for a final turn with no text. */
  text: z.string().max(RECORD_TEXT_LIMIT),
  /** The task this reply created or forwarded to. */
  taskId: idSchema.nullable(),
  createdAt: timestampSchema,
});

/** `POST /api/bots/:id/messages`. The reply arrives asynchronously. */
export const sendBotMessageCommandSchema = z.object({
  text: z.string().trim().min(1).max(COMMAND_TEXT_LIMIT),
});

/** Response to `POST /api/bots/:id/messages`: the stored user message. */
export const sendBotMessageResultSchema = z.object({
  message: conversationMessageSchema,
});

/** `GET /api/bots/:id/messages`. `replying` is true while the bot composes a reply. */
export const conversationViewSchema = z.object({
  botId: idSchema,
  messages: z.array(conversationMessageSchema),
  replying: z.boolean(),
  /** Why the latest reply failed; cleared when a reply succeeds. */
  lastReplyError: z
    .object({ message: z.string(), at: timestampSchema })
    .nullable(),
});

export type BotShape = BotAppearance["shape"];
export type BotFace = BotAppearance["face"];
export type BotTopper = BotAppearance["topper"];
export type BotColour = BotAppearance["colour"];
export type BotBody = BotAppearance["body"];
export type BotGait = BotAppearance["gait"];
export type BotPresence = z.infer<typeof botPresenceSchema>;
export type Bot = z.infer<typeof botSchema>;
export type CreateBotCommand = z.input<typeof createBotCommandSchema>;
export type UpdateBotCommand = z.input<typeof updateBotCommandSchema>;
export type BotMemory = z.infer<typeof botMemorySchema>;
export type UpdateBotMemoryCommand = z.input<
  typeof updateBotMemoryCommandSchema
>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type SendBotMessageCommand = z.input<typeof sendBotMessageCommandSchema>;
export type SendBotMessageResult = z.infer<typeof sendBotMessageResultSchema>;
export type ConversationView = z.infer<typeof conversationViewSchema>;
