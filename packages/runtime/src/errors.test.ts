import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { classifyErrorText, classifyModelError, redactSecrets } from "./errors";

describe("classifyErrorText", () => {
  it.each([
    ["OpenAI API error (401): Incorrect API key provided", "auth"],
    ['403 {"type":"error","error":{"type":"permission_error"}}', "auth"],
    ["429 Too Many Requests: rate limit reached for requests", "rate_limit"],
    ["You exceeded your current quota, please check your plan", "rate_limit"],
    ["Connection error.", "network"],
    ["fetch failed: getaddrinfo ENOTFOUND api.openai.com", "network"],
    ["Request timed out.", "network"],
    ["529 overloaded_error: Overloaded", "provider"],
    ["500 Internal server error", "provider"],
    ['400 {"error":{"message":"Invalid value for tools"}}', "invalid_request"],
    ["404 model not found", "invalid_request"],
    ["something odd happened", "unknown"],
  ])("%s → %s", (text, code) => {
    expect(classifyErrorText(text)).toBe(code);
  });

  it("detects context overflow with pi-ai's patterns first", () => {
    const message = fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "400 prompt is too long: 250000 tokens > 200000 maximum",
    });
    expect(classifyModelError(message)).toBe("context_overflow");
  });
});

describe("redactSecrets", () => {
  it("removes the given secret and key-shaped text", () => {
    const text = [
      "key my-literal-secret-value failed",
      "OpenAI: sk-proj-AbCdEfGhIjKlMnOpQrSt was rejected",
      "Anthropic: sk-ant-api03-ZyXwVuTsRqPoNmLk",
      "Gemini: AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv",
      "Authorization: Bearer abcdefghijklmnop.qrstuv",
      '{"api_key": "plain-secret-123456"}',
    ].join("\n");
    const redacted = redactSecrets(text, [
      "my-literal-secret-value",
      undefined,
    ]);
    for (const secret of [
      "my-literal-secret-value",
      "AbCdEfGh",
      "ZyXwVuTs",
      "AIzaSyA1b2",
      "abcdefghijklmnop",
      "plain-secret-123456",
    ])
      expect(redacted).not.toContain(secret);
    expect(redacted).toContain("OpenAI: sk-[redacted] was rejected");
    expect(redacted).toContain("Bearer [redacted]");
  });

  it("leaves ordinary text alone", () => {
    const text = "The model call ended with error: 503 Service Unavailable";
    expect(redactSecrets(text)).toBe(text);
  });
});
