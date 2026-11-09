// Compile-time proof that the pi runtime's classes satisfy the engine's ports,
// so apps/api can pass them straight to createEngine. The engine itself never
// imports @jj/runtime; this test does, and `npm run typecheck` checks it.
import {
  ModelRegistry,
  ChatResponder as PiChatResponder,
  type McpConnection as PiMcpConnection,
  McpDiscoverer as PiMcpDiscoverer,
  type McpToolBinding as PiMcpToolBinding,
  PiSessionExecutor,
  type CollabTool as RuntimeCollabTool,
  type ExecutorEvent as RuntimeExecutorEvent,
  type RunHooks as RuntimeRunHooks,
  type RunOutcome as RuntimeRunOutcome,
} from "@jj/runtime";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ChatResponder,
  CollabTool,
  ExecutorEvent,
  McpConnector,
  McpDiscoverer,
  McpToolBinding,
  ModelCatalog,
  RunExecutor,
  RunHooks,
  RunOutcome,
} from "./ports";

describe("runtime ports", () => {
  it("accept the pi runtime's executor, chat responder, MCP discoverer and model registry", () => {
    const models = new ModelRegistry({ env: {}, enableScripted: true });
    const executor: RunExecutor = new PiSessionExecutor({ models });
    const chat: ChatResponder = new PiChatResponder({ models });
    const mcp: McpDiscoverer = new PiMcpDiscoverer({ env: {} });
    const catalog: ModelCatalog = models;
    expect(catalog.defaultModel()).toBe("scripted/team");
    expect(typeof executor.run).toBe("function");
    expect(typeof chat.reply).toBe("function");
    expect(mcp.remote).toBe(true);
  });

  it("exchange compatible tools, hooks, events and outcomes", () => {
    // The engine hands tools and hooks to the runtime ...
    expectTypeOf<CollabTool>().toMatchTypeOf<RuntimeCollabTool>();
    expectTypeOf<RunHooks>().toMatchTypeOf<RuntimeRunHooks>();
    // ... and receives events and outcomes back.
    expectTypeOf<RuntimeExecutorEvent>().toMatchTypeOf<ExecutorEvent>();
    expectTypeOf<RuntimeRunOutcome>().toMatchTypeOf<RunOutcome>();
  });

  it("exchange compatible MCP connections and tool bindings", () => {
    // The runtime's connections are what the engine starts, shares and ends ...
    expectTypeOf<PiMcpConnection>().toMatchTypeOf<McpConnector>();
    // ... and the engine's bindings carry what the runtime declares and calls.
    expectTypeOf<Omit<McpToolBinding, "connect">>().toMatchTypeOf<
      Omit<PiMcpToolBinding, "connect">
    >();
  });
});
