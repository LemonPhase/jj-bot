import { bootstrapSchema } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

const app = createApp({
  agentUrl: "http://127.0.0.1:3001/api/agent",
  modelConfigured: false,
});
describe("scaffold readiness", () => {
  it("reports unavailable capabilities even when model config is present", async () => {
    const configured = createApp({
      agentUrl: "http://127.0.0.1:3001/api/agent",
      modelConfigured: true,
    });
    const response = await configured.request("/api/bootstrap");
    const body = bootstrapSchema.parse(await response.json());
    expect(response.status).toBe(200);
    expect(body.modelConfigured).toBe(true);
    expect(Object.values(body.capabilities)).toEqual([false, false, false]);
    expect(body.tasks).toEqual([]);
  });
  it("explicitly fails attempted agent execution rather than fabricating a result", async () => {
    const response = await app.request("/api/agent", { method: "POST" });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("SCAFFOLD_NOT_IMPLEMENTED");
    expect(body).not.toContain("RUN_FINISHED");
  });
  it("rejects oversized request bodies", async () => {
    const response = await app.request("/api/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(1024 * 1024 + 1) }),
    });
    expect(response.status).toBe(413);
  });
});
