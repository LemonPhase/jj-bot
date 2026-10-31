import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  isContextOverflow,
  type RetryPolicy,
  retryAssistantCall,
} from "@earendil-works/pi-ai";

/** Why a run or a chat reply failed. */
export type RunErrorCode =
  | "auth"
  | "rate_limit"
  | "context_overflow"
  | "network"
  | "provider"
  | "invalid_request"
  | "unknown";

const AUTH =
  /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[ _-]?(x-)?api[ _-]?key|incorrect api key|authentication|permission[ _-]denied|not configured/i;
const RATE_LIMIT =
  /\b429\b|rate[ _-]?limit|too many requests|quota|resource[ _-]?exhausted|insufficient[ _-]?quota/i;
const NETWORK =
  /connection error|fetch failed|socket hang up|network|\bE(CONNRESET|CONNREFUSED|NOTFOUND|TIMEDOUT|PIPE|AI_AGAIN|HOSTUNREACH|NETUNREACH)\b|\bUND_ERR_|terminated|timed? ?out/i;
const PROVIDER =
  /\b5\d\d\b|overloaded|server[ _-]?error|internal[ _-]?error|bad gateway|service unavailable|unavailable|server_busy/i;
const INVALID =
  /\b(400|404|409|413|422)\b|invalid[ _-]?request|bad request|not found|unsupported|invalid[ _-]argument/i;

/** Classifies a failed model response; context overflow uses pi-ai's own detector. */
export function classifyModelError(
  message: AssistantMessage,
  contextWindow?: number,
): RunErrorCode {
  if (isContextOverflow(message, contextWindow)) return "context_overflow";
  return classifyErrorText(message.errorMessage ?? "");
}

export function classifyErrorText(text: string): RunErrorCode {
  if (RATE_LIMIT.test(text)) return "rate_limit";
  if (AUTH.test(text)) return "auth";
  if (NETWORK.test(text)) return "network";
  if (PROVIDER.test(text)) return "provider";
  if (INVALID.test(text)) return "invalid_request";
  return "unknown";
}

const KEY_SHAPES: [RegExp, string][] = [
  [/\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_*-]{8,}/g, "sk-[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza[redacted]"],
  [
    /\b(?:xai-|gsk_|csk-|hf_|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g,
    "[redacted]",
  ],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [
    /((?:api[_-]?key|access[_-]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|Token\b|\[redacted\]|sk-\[redacted\])[^\s"',;}]{6,}/gi,
    "$1[redacted]",
  ],
];

/**
 * Removes the given secrets, and anything shaped like a provider key or a
 * credential, from text bound for events, outcomes and logs.
 */
export function redactSecrets(
  text: string,
  secrets: readonly (string | undefined)[] = [],
): string {
  let redacted = text;
  for (const secret of secrets)
    if (secret && secret.length >= 6)
      redacted = redacted.split(secret).join("[redacted]");
  for (const [pattern, replacement] of KEY_SHAPES)
    redacted = redacted.replace(pattern, replacement);
  return redacted;
}

/** Retries for provider calls: transient errors only, with exponential backoff. */
export interface RetryOptions {
  /** Default 3. 0 disables retries. */
  maxRetries?: number;
  /** First backoff; doubles per attempt. Default 1000 ms. */
  baseDelayMs?: number;
  /** Cap on one backoff. Default 30 s. */
  maxDelayMs?: number;
}

export function retryPolicy(options: RetryOptions = {}): RetryPolicy {
  const pick = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  return {
    enabled: true,
    maxRetries: pick(options.maxRetries, 3),
    baseDelayMs: pick(options.baseDelayMs, 1000),
    maxAgentDelayMs: pick(options.maxDelayMs, 30_000),
  };
}

/**
 * Wraps a stream function so a transient failure (429, 5xx, overload, a
 * dropped connection; per pi-ai's `isRetryableAssistantError`) is retried
 * before the agent loop sees it. Each attempt runs to its end before the next
 * starts, so the loop receives one final message. Provider SDK retries are
 * turned off by the caller to avoid retrying twice.
 */
export function retryingStreamFn(
  base: StreamFn,
  policy: RetryPolicy,
): StreamFn {
  if (policy.maxRetries === 0) return base;
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void retryAssistantCall(
      async () => (await base(model, context, options)).result(),
      policy,
      options?.signal,
    ).then(
      (message) => {
        if (message.stopReason === "error" || message.stopReason === "aborted")
          stream.push({
            type: "error",
            reason: message.stopReason,
            error: message,
          });
        else
          stream.push({
            type: "done",
            reason: message.stopReason as "stop",
            message,
          });
        stream.end(message);
      },
      (error: unknown) => {
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      },
    );
    return stream;
  };
}
