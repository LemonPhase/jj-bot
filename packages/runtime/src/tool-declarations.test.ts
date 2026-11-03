// The coding tools as the model sees them: names, descriptions and the exact
// JSON of their schemas. Tool definitions lead the prompt cache prefix, so a
// pi or typebox upgrade that changes one of them must fail here, loudly.
import { toToolDeclaration } from "@earendil-works/pi-ai";
import { CODING_TOOLS } from "@jj/contracts";
import type { Sandbox } from "@jj/sandbox";
import { describe, expect, it } from "vitest";
import { createSandboxTools } from "./sandbox-tools";

describe("coding tool declarations", () => {
  it("stay byte-stable", () => {
    // Building the tools reads only the workspace directory.
    const sandbox = { workspaceDir: "/workspace" } as unknown as Sandbox;
    const tools = createSandboxTools(
      sandbox,
      CODING_TOOLS,
      { capBytes: 65_536, spill: async () => "artifact" },
      {
        limits: { execTimeoutMs: 120_000, maxOutputBytes: 262_144 },
        onReleased: () => {},
      },
    );
    expect(
      tools.map(toToolDeclaration).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: JSON.stringify(tool.parameters),
      })),
    ).toMatchSnapshot();
  });
});
