/**
 * The JJ Bot API contract: HTTP and SSE shapes shared by `apps/api` and its
 * clients. Read shapes are `z.infer` types; command types are `z.input` types
 * (what a client sends), and servers use the parsed output. Persistence-only
 * shapes (transcripts, jobs, leases) live in `packages/db`, not here.
 *
 * Record every change in docs/contract-changelog.md.
 */

// Keep API validation on the same schema implementation as the shared contracts.
export { z } from "zod";
export * from "./api";
export * from "./bots";
export * from "./common";
export * from "./events";
export * from "./profiles";
export * from "./tasks";
