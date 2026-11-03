// The engine's tools as the model sees them: names, descriptions and the
// exact JSON of their schemas, for a coordinator, a worker and a chat reply.
// Tool definitions lead the prompt cache prefix, so a change to one of them,
// or to how a dependency serializes them, must fail here, loudly.
import type { CollabTool } from "@jj/runtime";
import { describe, expect, it } from "vitest";
import { chatTools } from "./chat-tools";
import { sessionTools, type Teammate } from "./collab-tools";
import type { RunContext } from "./run-context";

const declarations = (tools: readonly CollabTool[]) =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: JSON.stringify(tool.parameters),
  }));

/** Building the tools reads only these fields; running them would need the rest. */
const runContext = (session: {
  depth: number;
  parentSessionId: string | null;
}) =>
  ({
    deps: { ctx: { db: {}, logger: {}, config: { maxDelegationDepth: 2 } } },
    task: { id: "task_1" },
    session: { id: "session_1", ...session },
    redact: (text: string) => text,
  }) as unknown as RunContext;

const team: Teammate[] = [
  { botId: "bot_bob", name: "Bob", role: "Researcher" },
  { botId: "bot_cy", name: "Cy", role: "" },
];

describe("engine tool declarations", () => {
  it("stay byte-stable", () => {
    const coordinator = sessionTools(
      runContext({ depth: 0, parentSessionId: null }),
      team,
    );
    const worker = sessionTools(
      runContext({ depth: 1, parentSessionId: "session_0" }),
      team,
    );
    const chat = chatTools({
      ctx: { db: {}, logger: {}, config: {} },
      bot: { id: "bot_ada", name: "Ada" },
      redact: (text: string) => text,
      write: {},
      everyone: [
        { id: "bot_ada", name: "Ada", model: null },
        { id: "bot_bob", name: "Bob", model: null },
      ],
      state: {},
    } as unknown as Parameters<typeof chatTools>[0]);
    expect({
      coordinator: declarations(coordinator),
      worker: declarations(worker),
      chat: declarations(chat),
    }).toMatchSnapshot();
  });
});
