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

// APPEARANCE-PLACEHOLDER: replace with the Bot Studio values from the design spec.
export const BOT_SHAPES = ["round"] as const;
export const BOT_FACES = ["dots"] as const;
export const BOT_TOPPERS = ["none"] as const;
export const BOT_COLOURS = ["coral"] as const;
export const BOT_BODIES = ["ivory"] as const;
export const BOT_GAITS = ["hop"] as const;

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

const botNameSchema = z.string().trim().min(1).max(60);
const botRoleSchema = z.string().trim().max(80);
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
