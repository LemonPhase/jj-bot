import { z } from "zod";
import {
  botSchema,
  botTurnCommandSchema,
  type CheckDefinition,
  checkDefinitionSchema,
  createBotCommandSchema,
  createTaskCommandSchema,
  executionSessionSchema,
  postTaskMessageCommandSchema,
  steerTaskCommandSchema,
  stopTaskCommandSchema,
  type TaskView,
  taskSchema,
  taskViewSchema,
  verificationResultSchema,
} from "./index";

export {
  botTurnCommandSchema,
  type CheckDefinition,
  checkDefinitionSchema,
  createBotCommandSchema,
  createTaskCommandSchema,
  postTaskMessageCommandSchema,
  steerTaskCommandSchema,
  stopTaskCommandSchema,
  type TaskView,
  taskViewSchema,
};

export const createBotSchema = botSchema.omit({ id: true });
export const createTaskSchema = createTaskCommandSchema;
export const postMessageSchema = postTaskMessageCommandSchema;
export const steerTaskSchema = steerTaskCommandSchema.extend({
  observedGoalVersion: z.number().int().positive().optional(),
});
export const stopTaskSchema = stopTaskCommandSchema;
export const spawnSessionSchema = executionSessionSchema
  .omit({ id: true, taskId: true, goalVersion: true, status: true })
  .extend({
    checks: z.array(checkDefinitionSchema).optional(),
  });

export type CreateTaskInput = z.input<typeof createTaskSchema>;
export type CreateBotInput = z.infer<typeof createBotSchema>;
export type PostMessageInput = z.input<typeof postMessageSchema>;
export type SteerTaskInput = z.input<typeof steerTaskSchema>;
export type StopTaskInput = z.input<typeof stopTaskSchema>;
export type SpawnSessionInput = z.infer<typeof spawnSessionSchema>;
export type TaskRecord = z.infer<typeof taskSchema> & {
  checks?: CheckDefinition[];
  result?: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
  cancelReason?: string;
};
export type SessionRecord = z.infer<typeof executionSessionSchema> & {
  kind: "work" | "synthesis";
  checks?: CheckDefinition[];
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  runId?: string;
};
export type JobRecord = {
  id: string;
  taskId: string;
  sessionId: string;
  status: "queued" | "running" | "done" | "cancelled" | "failed";
  owner?: string;
  leaseUntil?: number;
  attempts: number;
  createdAt: string;
  error?: string;
};
export type MemoryRecord = {
  id: string;
  botId: string;
  text: string;
  updatedAt: string;
};
export type ConversationMessage = {
  id: string;
  botId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  taskId?: string;
  /** Monotonic per-bot order; optional for records written before it existed. */
  sequence?: number;
};
export type CheckRecord = z.infer<typeof verificationResultSchema> & {
  id: string;
  createdAt: string;
};
