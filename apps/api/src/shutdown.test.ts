// The API process on a stop signal: it drains (not ready, no new claims,
// running sessions get JJ_DRAIN_TIMEOUT_SEC to reach a turn boundary), shuts
// down and exits 0; a session it interrupted at the timeout resumes when it
// starts again, and a second signal exits at once.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
});
afterAll(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

interface Api {
  child: ChildProcess;
  url: string;
  output: () => string;
  exited: Promise<number | null>;
}

/** Starts the API process on `dir`'s PGlite and the local driver, with the scripted model. */
async function boot(dir: string, drainSec: number): Promise<Api> {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: {
      PATH: process.env.PATH,
      API_PORT: "0",
      JJ_DATABASE_PATH: join(dir, "db"),
      JJ_SANDBOX_DRIVERS: "local",
      JJ_SANDBOX_ROOT: join(dir, "sandbox"),
      JJ_ENABLE_SCRIPTED_MODEL: "true",
      JJ_DEFAULT_MODEL: "scripted/team",
      JJ_DRAIN_TIMEOUT_SEC: String(drainSec),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  const deadline = Date.now() + 60_000;
  for (;;) {
    const url = /JJ Bot API at (http:\/\/[^ ]+)/.exec(output)?.[1];
    if (url) return { child, url, output: () => output, exited };
    if (child.exitCode !== null || Date.now() > deadline)
      throw new Error(`The API did not start:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function call(api: Api, method: string, path: string, body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json() as Promise<any>;
}

/** A task whose coordinator, the only bot, writes notes, then runs `command`. */
async function startTask(api: Api, command: string) {
  const { bot } = await call(api, "POST", "/api/bots", { name: "Ada" });
  const { task } = await call(api, "POST", "/api/tasks", {
    goal: `Write notes and run \`${command}\``,
    coordinatorBotId: bot.id,
  });
  return task.id as string;
}

async function events(api: Api, taskId: string): Promise<any[]> {
  return (await call(api, "GET", `/api/tasks/${taskId}/events?limit=500`))
    .events;
}

async function until<T>(
  what: string,
  check: () => Promise<T | undefined>,
  api: Api,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${what}. Output:\n${api.output()}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const commandStarted = (api: Api, taskId: string, command: string) =>
  until(
    `the command ${command}`,
    async () =>
      (await events(api, taskId)).some(
        (event) =>
          event.type === "tool.started" && event.payload.summary === command,
      )
        ? true
        : undefined,
    api,
  );

const completed = (api: Api, taskId: string) =>
  until(
    "the task to complete",
    async () => {
      const view = await call(api, "GET", `/api/tasks/${taskId}`);
      return view.task.status === "completed" ? view : undefined;
    },
    api,
  );

/** Processes running `command` exactly, as the local driver started it. */
const running = (command: string) =>
  spawnSync("ps", ["-eo", "args="], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((line) => line.trim() === command).length;

const finishedTool = (list: any[], command: string) =>
  list.find(
    (event) =>
      event.type === "tool.finished" && event.payload.summary === command,
  )?.payload;

describe("the API process on SIGTERM", () => {
  it("drains: not ready, the command in flight finishes its turn, then it exits 0 and resumes the session on restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jj-shutdown-"));
    dirs.push(dir);
    const first = await boot(dir, 60);
    const taskId = await startTask(first, "sleep 3");
    await commandStarted(first, taskId, "sleep 3");

    const signalled = Date.now();
    first.child.kill("SIGTERM");
    // Readiness turns as the signal is handled, which the line announces.
    await until(
      "the drain to start",
      async () =>
        first.output().includes("SIGTERM: draining") ? true : undefined,
      first,
    );
    const ready = await fetch(`${first.url}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      status: "not_ready",
      draining: true,
      checks: { worker: { ok: false, reason: "the job loop is draining" } },
    });
    expect(await first.exited, first.output()).toBe(0);
    // At the turn boundary, not at the 60 s timeout.
    expect(Date.now() - signalled).toBeLessThan(30_000);
    expect(first.output()).toContain("SIGTERM: draining");
    expect(first.output()).not.toContain("drain timed out");

    const second = await boot(dir, 60);
    const view = await completed(second, taskId);
    expect(view.task.result).toBeTruthy();
    const list = await events(second, taskId);
    // The command ran to its end and was not run again.
    expect(finishedTool(list, "sleep 3")).toMatchObject({ ok: true });
    expect(
      list.filter(
        (event) =>
          event.type === "tool.started" && event.payload.summary === "sleep 3",
      ),
    ).toHaveLength(1);
    expect(
      list
        .filter((event) => event.type === "run.finished")
        .map((event) => event.payload),
    ).toContainEqual({
      outcome: "cancelled",
      error:
        "The worker stopped; the session resumes from its last completed turn.",
    });
    expect(
      list
        .filter((event) => event.type === "run.started")
        .map((event) => event.payload.reason),
    ).toEqual(["start", "recovery"]);
    second.child.kill("SIGTERM");
    expect(await second.exited).toBe(0);
  }, 150_000);

  it("interrupts a session still in its turn at the timeout, which resumes at once on restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jj-shutdown-"));
    dirs.push(dir);
    const first = await boot(dir, 1);
    const taskId = await startTask(first, "sleep 67");
    await commandStarted(first, taskId, "sleep 67");
    await until(
      "the command's process",
      async () => (running("sleep 67") > 0 ? true : undefined),
      first,
    );
    const signalled = Date.now();
    first.child.kill("SIGTERM");
    expect(await first.exited, first.output()).toBe(0);
    expect(Date.now() - signalled).toBeLessThan(20_000);
    expect(first.output()).toContain("drain timed out");
    // Its sandbox was released: the command did not outlive the process.
    expect(running("sleep 67")).toBe(0);

    // The lease was given up, so the restart resumes the session at once,
    // not once the 30 s lease runs out.
    const second = await boot(dir, 1);
    const restarted = Date.now();
    await completed(second, taskId);
    expect(Date.now() - restarted).toBeLessThan(25_000);
    const list = await events(second, taskId);
    expect(finishedTool(list, "sleep 67")).toMatchObject({
      ok: false,
      interrupted: "unknown",
    });
    expect(
      list
        .filter((event) => event.type === "run.finished")
        .map((event) => event.payload),
    ).toContainEqual({
      outcome: "failed",
      error:
        "Interrupted by a worker restart; the session resumes from its last completed turn.",
    });
    second.child.kill("SIGTERM");
    expect(await second.exited).toBe(0);
  }, 150_000);

  it("exits at once on a second signal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jj-shutdown-"));
    dirs.push(dir);
    const api = await boot(dir, 60);
    const taskId = await startTask(api, "sleep 20");
    await commandStarted(api, taskId, "sleep 20");
    api.child.kill("SIGTERM");
    await until(
      "the drain to start",
      async () =>
        api.output().includes("SIGTERM: draining") ? true : undefined,
      api,
    );
    const again = Date.now();
    api.child.kill("SIGTERM");
    expect(await api.exited).toBe(1);
    expect(Date.now() - again).toBeLessThan(5_000);
    expect(api.output()).toContain("SIGTERM again: exiting now.");
  }, 120_000);
});
