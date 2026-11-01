// The standalone worker process: refuses PGlite, and on PostgreSQL runs the
// tasks of an API started with JJ_EMBED_WORKER=false.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunningServer, startServer } from "@jj/api/server";
import { ulid } from "@jj/db";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const postgresUrl = process.env.JJ_TEST_DATABASE_URL;

describe("the worker process", () => {
  it("refuses to start without PostgreSQL", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", entry], {
      env: { PATH: process.env.PATH, JJ_DATABASE_PATH: "memory://" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("needs PostgreSQL: set DATABASE_URL");
  });
});

describe.skipIf(!postgresUrl)(
  "an API and a separate worker on PostgreSQL",
  () => {
    const name = `jj_worker_${ulid().toLowerCase()}`;
    let server: RunningServer | undefined;
    let worker: ChildProcess | undefined;
    let root: string | undefined;
    const admin = async (sql: string) => {
      const client = new Client({ connectionString: postgresUrl });
      await client.connect();
      try {
        await client.query(sql);
      } finally {
        await client.end();
      }
    };

    afterAll(async () => {
      await server?.close();
      if (worker && worker.exitCode === null) {
        const exited = new Promise((resolve) => worker?.once("exit", resolve));
        worker.kill("SIGTERM");
        await exited;
      }
      await admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      if (root) await rm(root, { recursive: true, force: true });
    }, 60_000);

    it("runs a task the API created", async () => {
      await admin(`CREATE DATABASE "${name}"`);
      const url = new URL(postgresUrl as string);
      url.pathname = `/${name}`;
      root = await mkdtemp(join(tmpdir(), "jj-worker-test-"));
      const env = {
        DATABASE_URL: url.toString(),
        JJ_SANDBOX_DRIVERS: "local",
        JJ_SANDBOX_ROOT: root,
        JJ_ENABLE_SCRIPTED_MODEL: "true",
      };
      server = await startServer({
        env: { ...env, API_PORT: "0", JJ_EMBED_WORKER: "false" },
        logger: { info() {}, warn() {}, error() {} },
      });
      worker = spawn(process.execPath, ["--import", "tsx", entry], {
        env: { PATH: process.env.PATH, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      worker.stdout?.on("data", (chunk) => {
        output += chunk;
      });
      worker.stderr?.on("data", (chunk) => {
        output += chunk;
      });
      const call = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${server?.url}${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return response.json() as Promise<any>;
      };
      const ada = (await call("POST", "/api/bots", { name: "Ada" })).bot;
      const grace = (await call("POST", "/api/bots", { name: "Grace" })).bot;
      const { task } = await call("POST", "/api/tasks", {
        goal: "Write notes",
        coordinatorBotId: ada.id,
        participantBotIds: [grace.id],
      });
      const deadline = Date.now() + 45_000;
      let view: any;
      for (;;) {
        view = await call("GET", `/api/tasks/${task.id}`);
        if (view.task.status === "completed") break;
        if (Date.now() > deadline)
          throw new Error(
            `The task did not complete (${view.task.status}). Worker output:\n${output}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(output).toContain("JJ Bot worker running");
      expect(
        view.artifacts.map((artifact: { name: string }) => artifact.name),
      ).toContain("notes-grace.md");
      const ready = await fetch(`${server.url}/health/ready`);
      expect(((await ready.json()) as any).checks.worker).toEqual({
        ok: true,
        embedded: false,
      });
    }, 90_000);
  },
);
