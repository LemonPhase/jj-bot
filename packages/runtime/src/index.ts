import { GoogleGenAI } from "@google/genai";
import type {
  ExecutionSession,
  TaskEvent,
  VerificationResult,
} from "@jj/contracts";

export interface ModelConfig {
  apiKey: string;
  model: string;
}

/** Explicit config keeps credentials server-side and avoids import-time model calls. */
export function createGoogleClient(config: ModelConfig): GoogleGenAI {
  if (!config.apiKey.trim() || !config.model.trim()) {
    throw new Error(
      "Set both GEMINI_API_KEY and GEMINI_MODEL before enabling model execution.",
    );
  }
  return new GoogleGenAI({ apiKey: config.apiKey });
}

/** Implement this in the runtime workstream; the scaffold does not execute sessions. */
export interface SessionExecutor {
  execute(input: {
    session: ExecutionSession;
    signal: AbortSignal;
    emit: (event: TaskEvent) => Promise<void>;
  }): Promise<{ summary: string; checks: VerificationResult[] }>;
}

export const RUNTIME_STATUS = "not-implemented" as const;
