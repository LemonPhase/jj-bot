import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Sandbox, SandboxDirEntry, SandboxFs } from "@jj/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSandboxTools } from "./sandbox-tools";
import { localSandbox } from "./test-support";
import { capToolOutput, type OutputPolicy } from "./tools";

const policy = (capBytes = 65_536, spilled: string[] = []): OutputPolicy => ({
  capBytes,
  spill: async (text) => {
    spilled.push(text);
    return `artifact-${spilled.length}`;
  },
});
const options = {
  limits: { execTimeoutMs: 10_000, maxOutputBytes: 262_144 },
  onReleased: () => {},
};
const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((block) => block.text ?? "").join("");
const tool = (tools: AgentTool[], name: string) => {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no ${name} tool`);
  return found;
};

/** A sandbox whose files live in memory, at a workspace path that also exists on the host. */
function memorySandbox(
  workspaceDir: string,
  files: Record<string, string>,
): Sandbox {
  const store = new Map(
    Object.entries(files).map(([path, data]) => [
      posix.join(workspaceDir, path),
      Buffer.from(data),
    ]),
  );
  const fs: SandboxFs = {
    read: async (path) => {
      const data = store.get(path);
      if (!data)
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return data;
    },
    write: async (path, data) => {
      store.set(path, Buffer.from(data));
    },
    remove: async (path) => {
      store.delete(path);
    },
    mkdir: async () => {},
    stat: async (path) =>
      store.has(path)
        ? {
            path,
            kind: "file",
            size: store.get(path)?.length ?? 0,
            modifiedAt: new Date(0).toISOString(),
          }
        : path === workspaceDir
          ? {
              path,
              kind: "directory",
              size: 0,
              modifiedAt: new Date(0).toISOString(),
            }
          : undefined,
    list: async () =>
      [...store.keys()].map(
        (path): SandboxDirEntry => ({ path, kind: "file" }),
      ),
    move: async () => {},
  };
  return {
    id: "memory",
    driverId: "memory",
    workspaceDir,
    fs,
    exec: async () => {
      throw new Error("no exec in this test");
    },
    release: async () => {},
  };
}

describe("file tools and the host filesystem", () => {
  let hostDir: string;
  beforeEach(async () => {
    hostDir = await mkdtemp(join(tmpdir(), "jj-host-paths-"));
  });
  afterEach(async () => {
    await rm(hostDir, { recursive: true, force: true });
  });

  it("never lets a host file at the same absolute path change what is read", async () => {
    // pi's read would pick a host file named with a macOS screenshot variant
    // (narrow no-break space before PM) and read that name from the sandbox.
    await writeFile(join(hostDir, "shot 1 PM.txt"), "host variant");
    await writeFile(join(hostDir, "notes.txt"), "host file");
    const sandbox = memorySandbox(hostDir, {
      "shot 1 PM.txt": "sandbox file",
      "shot 1 PM.txt": "sandbox variant",
      "notes.txt": "sandbox notes",
    });
    const tools = createSandboxTools(
      sandbox,
      ["read", "edit", "write"],
      policy(),
      options,
    );
    expect(
      textOf(await tool(tools, "read").execute("1", { path: "shot 1 PM.txt" })),
    ).toBe("sandbox file");
    expect(
      textOf(
        await tool(tools, "read").execute("2", {
          path: `${hostDir}/notes.txt`,
        }),
      ),
    ).toBe("sandbox notes");
    await tool(tools, "edit").execute("3", {
      path: "notes.txt",
      edits: [{ oldText: "sandbox", newText: "edited" }],
    });
    await tool(tools, "write").execute("4", {
      path: "new.txt",
      content: "written",
    });
    expect((await sandbox.fs.read(`${hostDir}/notes.txt`)).toString()).toBe(
      "edited notes",
    );
    expect((await sandbox.fs.read(`${hostDir}/new.txt`)).toString()).toBe(
      "written",
    );
  });

  it("does not expand ~ to the host home directory", async () => {
    const sandbox = memorySandbox(hostDir, { "~/x.txt": "inside" });
    const tools = createSandboxTools(sandbox, ["read"], policy(), options);
    expect(
      textOf(await tool(tools, "read").execute("1", { path: "~/x.txt" })),
    ).toBe("inside");
  });
});

describe("find", () => {
  let workspace: Awaited<ReturnType<typeof localSandbox>>;
  beforeEach(async () => {
    workspace = await localSandbox();
  });
  afterEach(async () => {
    await workspace.cleanup();
  });

  it("runs in the sandbox and never descends into node_modules, .git or build output", async () => {
    for (const path of [
      "src/app.ts",
      "src/lib/util.spec.ts",
      "node_modules/pkg/index.ts",
      ".git/hooks/x.ts",
      "dist/app.ts",
      "build/out.ts",
    ])
      await workspace.sandbox.fs.write(path, "x");
    const tools = createSandboxTools(workspace.sandbox, ["find"], policy(), {
      ...options,
      limits: workspace.limits,
    });
    const find = tool(tools, "find");
    expect(textOf(await find.execute("1", { pattern: "*.ts" }))).toBe(
      "src/app.ts\nsrc/lib/util.spec.ts",
    );
    expect(
      textOf(await find.execute("2", { pattern: "src/**/*.spec.ts" })),
    ).toBe("src/lib/util.spec.ts");
    expect(textOf(await find.execute("3", { pattern: "lib" }))).toBe(
      "src/lib/",
    );
    expect(
      textOf(await find.execute("4", { pattern: "*.ts", limit: 1 })),
    ).toContain("1 results limit reached");
    await expect(
      find.execute("5", { pattern: "*", path: "../.." }),
    ).rejects.toThrow(/outside the workspace/);
  });
});

describe("capToolOutput", () => {
  it("spills only output over the cap, exactly at the boundary", async () => {
    const spilled: string[] = [];
    const cap = 4096;
    const exact = "é".repeat(cap / 2); // two bytes each: exactly the cap
    expect(Buffer.byteLength(exact)).toBe(cap);
    expect(await capToolOutput(exact, policy(cap, spilled), "x")).toEqual({
      text: exact,
      truncated: false,
    });
    expect(spilled).toEqual([]);

    const over = `${exact}a`;
    const capped = await capToolOutput(over, policy(cap, spilled), "x");
    expect(capped).toMatchObject({ truncated: true, artifactId: "artifact-1" });
    expect(spilled).toEqual([over]);
    expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(cap);
    expect(capped.text).not.toContain("�");
  });
});

describe("capToolOutput with a redactor", () => {
  const KEY = "sk-test-0123456789abcdefghijklmn";
  const middle = KEY.slice(8, 24);
  const redact = (text: string) => text.split(KEY).join("[redacted]");

  it("leaves no fragment of a secret wherever the cut lands", async () => {
    let fragmentWithout = false;
    // Every alignment of the key against the head and tail cuts.
    for (let offset = 0; offset < KEY.length; offset += 1) {
      const output = `${"a".repeat(offset)}${KEY.repeat(200)}`;
      const spilled: string[] = [];
      const capped = await capToolOutput(
        output,
        { ...policy(1024, spilled), redact },
        `cat ${KEY}`,
      );
      expect(capped.truncated).toBe(true);
      expect(capped.text).not.toContain(middle.slice(0, 4));
      for (const text of spilled) expect(text).not.toContain(middle);
      const plain = await capToolOutput(output, policy(1024, []), "x");
      if (plain.text.replaceAll(KEY, "").includes(KEY.slice(4, 8)))
        fragmentWithout = true;
    }
    // Without the redactor some alignment does leave a fragment.
    expect(fragmentWithout).toBe(true);
  });
});
