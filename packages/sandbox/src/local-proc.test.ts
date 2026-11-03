import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { LocalSandboxDriver } from "./drivers/local";

/**
 * The local driver's `/proc` scan, against processes that come and go while
 * it reads them, as other processes of the server's user do on a busy
 * machine. Reads of `/proc/<pid>/…` for pids above the kernel's limit
 * (PID_MAX_LIMIT, 2^22), which no real process can have, are answered by
 * `proc.fake`; everything else is the real filesystem.
 */
const proc = vi.hoisted(() => ({
  fake: undefined as
    | undefined
    | { list(): string[]; read(path: string): Promise<string> | undefined },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = actual.readdir as (...args: unknown[]) => Promise<unknown>;
  const readFile = actual.readFile as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    readdir: async (path: unknown, ...rest: unknown[]) => {
      const names = await readdir(path, ...rest);
      return path === "/proc" && proc.fake
        ? [...(names as string[]), ...proc.fake.list()]
        : names;
    },
    readFile: (path: unknown, ...rest: unknown[]) =>
      (typeof path === "string" ? proc.fake?.read(path) : undefined) ??
      readFile(path, ...rest),
  };
});

const PID_MAX_LIMIT = 2 ** 22;
const UID = process.getuid?.() ?? 0;
const PF_EXITING = 0x4;

type After = "gone" | { state: string; flags?: number };

/**
 * Every scan finds a new process of this user, started after the command, in
 * another session and without the command's marker, whose environment it
 * cannot read (EACCES). With `after`, that process ended as the scan read it
 * (the kernel makes root the owner of a memoryless process's environ), and
 * its stat reads that way from then on; without, it lives on, as a
 * non-dumpable process does.
 */
function churn(after?: After) {
  let next = PID_MAX_LIMIT + 1;
  const ended = new Set<number>();
  const fail = (code: string, path: string) =>
    Promise.reject(
      Object.assign(new Error(`${code}: open '${path}'`), { code }),
    );
  const stat = (pid: number, state: string, flags = 0) =>
    // pid (comm) state ppid pgrp session tty tpgid flags … starttime (22nd).
    `${pid} (churn) ${state} 1 ${pid} ${pid} 0 -1 ${flags} 0 0 0 0 0 0 0 0 20 0 1 0 ${2 ** 40} 0 0\n`;
  return {
    list: () => [String(next++)],
    read(path: string): Promise<string> | undefined {
      const match = /^\/proc\/(\d+)\/(stat|status|environ)$/.exec(path);
      const pid = Number(match?.[1]);
      if (!match || pid <= PID_MAX_LIMIT) return undefined;
      if (match[2] === "environ") {
        if (after) ended.add(pid);
        return fail("EACCES", path);
      }
      if (ended.has(pid) && after) {
        if (after === "gone") return fail("ENOENT", path);
        if (match[2] === "stat")
          return Promise.resolve(stat(pid, after.state, after.flags));
      }
      return Promise.resolve(
        match[2] === "stat"
          ? stat(pid, "S")
          : `Name:\tchurn\nUid:\t${UID}\t${UID}\t${UID}\t${UID}\n`,
      );
    },
  };
}

describe.runIf(
  process.platform === "linux" && existsSync("/proc/self/environ"),
)("local driver /proc scan", () => {
  let root: string;
  let driver: LocalSandboxDriver;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "jj-local-proc-"));
    driver = new LocalSandboxDriver({ root, env: {}, killGraceMs: 200 });
  });
  afterEach(() => {
    proc.fake = undefined;
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const stopWith = async (fake: ReturnType<typeof churn>) => {
    const sandbox = await driver.acquire({
      sessionId: "session-1",
      taskId: "task-1",
      spec: driver.validateSpec({
        driver: "local",
        network: { mode: "open" },
        workspace: "ephemeral",
      }),
      workspaceKey: "proc-scan",
    });
    proc.fake = fake;
    try {
      return await sandbox.exec("sleep 30", { timeoutMs: 300 });
    } finally {
      proc.fake = undefined;
      await sandbox.release();
    }
  };

  it.each<[string, After]>([
    ["is reaped", "gone"],
    ["is a zombie", { state: "Z" }],
    ["is still exiting", { state: "D", flags: PF_EXITING }],
  ])(
    'reports "yes" when another process of the user exits as it is read and %s',
    async (_, after) => {
      const result = await stopWith(churn(after));
      expect(result.interruptReason).toBe("timeout");
      expect(result.interrupted).toBe("yes");
    },
  );

  it('reports "unknown" while a process of the user that it cannot read lives on', async () => {
    const result = await stopWith(churn());
    expect(result.interruptReason).toBe("timeout");
    expect(result.interrupted).toBe("unknown");
  });
});
