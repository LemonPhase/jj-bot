/**
 * The JJ Bot API contract: HTTP and SSE shapes shared by `apps/api` and its
 * clients. Read shapes are `z.infer` types; command types are `z.input` types
 * (what a client sends), and servers use the parsed output. Persistence-only
 * shapes (transcripts, jobs, leases) live in `packages/db`, not here.
 *
 * Record every change in docs/contract-changelog.md. The cron grammar,
 * the schedule commands and evaluating schedule times are in the
 * `@jj/contracts/schedule-rules` entry, kept out of this one so clients load
 * them only where they write or preview a schedule.
 */

// Keep API validation on the same schema implementation as the shared contracts.
export { z } from "zod";
export * from "./api";
export * from "./approvals";
export * from "./bots";
export * from "./canonical";
export * from "./common";
export * from "./events";
export * from "./mcp";
export * from "./profiles";
export type {
  CreateScheduleCommand,
  ScheduleTrigger,
  UpdateScheduleCommand,
} from "./schedule-rules";
export * from "./schedules";
export * from "./secrets";
export * from "./skills";
export * from "./tasks";
export * from "./templates";
export * from "./uploads";
export * from "./usage";
export * from "./verification";
