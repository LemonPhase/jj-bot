// Writing an upload into a workspace, on an in-memory filesystem whose
// calls a test can hold, so two attempts at one upload can interleave the
// way two workers' runs would.
import { posix } from "node:path";
import type { Sandbox, SandboxFs } from "@jj/sandbox/contract";
import { describe, expect, it } from "vitest";
import { writeInto } from "./uploads";

interface Hold {
  /** Resolves once the held call has started. */
  reached: Promise<void>;
  release(): void;
}

function hold(): Hold & { wait(): Promise<void>; markReached(): void } {
  let markReached = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release, markReached, wait: () => released };
}

/** A workspace in memory. `holdMove` holds the first move; `holdWrite` the second write halfway. */
function memorySandbox() {
  const files = new Map<string, Buffer>();
  const moveHold = hold();
  const writeHold = hold();
  let moves = 0;
  let writes = 0;
  const missing = (path: string) =>
    Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const fs: SandboxFs = {
    async read(path) {
      const data = files.get(path);
      if (!data) throw missing(path);
      return data;
    },
    async write(path, data) {
      const bytes = Buffer.from(data);
      writes += 1;
      if (writes === 2) {
        // Half the file is there when the second attempt is held.
        files.set(path, bytes.subarray(0, bytes.length / 2));
        writeHold.markReached();
        await writeHold.wait();
      }
      files.set(path, bytes);
    },
    async remove(path) {
      files.delete(path);
    },
    async mkdir() {},
    async stat(path) {
      const data = files.get(path);
      return data
        ? {
            path,
            kind: "file",
            size: data.length,
            modifiedAt: new Date().toISOString(),
          }
        : undefined;
    },
    async list(dir) {
      return [...files.keys()]
        .filter((path) => posix.dirname(path) === dir)
        .map((path) => ({ path, kind: "file" as const }));
    },
    async move(from, to) {
      moves += 1;
      if (moves === 1) {
        moveHold.markReached();
        await moveHold.wait();
      }
      const data = files.get(from);
      if (!data) throw missing(from);
      files.set(to, data);
      files.delete(from);
    },
  };
  const sandbox = { fs, workspaceDir: "/workspace" } as unknown as Sandbox;
  return { sandbox, files, moveHold, writeHold };
}

const parts = (files: Map<string, Buffer>) =>
  [...files.keys()].filter((path) => path.endsWith(".part"));

describe("writing an upload into the workspace", () => {
  it("never moves another attempt's half-written part onto the target", async () => {
    const { sandbox, files, moveHold, writeHold } = memorySandbox();
    const content = Buffer.alloc(1024, 7);
    // Attempt A has written its part and is about to move it.
    const first = writeInto(sandbox, "upl_1", "uploads/a.bin", content);
    await moveHold.reached;
    // Attempt B (another worker's run) starts on the same upload, halfway.
    const second = writeInto(sandbox, "upl_1", "uploads/a.bin", content);
    await writeHold.reached;
    moveHold.release();
    expect(await first).toEqual({ kind: "placed" });
    expect(files.get("uploads/a.bin")?.equals(content)).toBe(true);
    writeHold.release();
    await second;
    expect(files.get("uploads/a.bin")?.equals(content)).toBe(true);
    expect(parts(files)).toEqual([]);
  });

  it("removes the part files that attempts which died left behind", async () => {
    const { sandbox, files, moveHold } = memorySandbox();
    moveHold.release();
    files.set("uploads/.jj-upload-upl_2-dead0001.part", Buffer.from("half"));
    files.set("uploads/.jj-upload-other-dead0002.part", Buffer.from("other"));
    const content = Buffer.from("whole\n");
    expect(await writeInto(sandbox, "upl_2", "uploads/b.txt", content)).toEqual(
      { kind: "placed" },
    );
    expect(files.get("uploads/b.txt")?.equals(content)).toBe(true);
    // Another upload's part is left to its own placement.
    expect(parts(files)).toEqual(["uploads/.jj-upload-other-dead0002.part"]);
  });
});
