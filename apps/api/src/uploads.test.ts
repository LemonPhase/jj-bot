// `POST /api/uploads`, the one write whose body is raw bytes, and the routes
// that attach and remove staged uploads: the browser protections hold for
// it, every limit is checked before the body is read, and attached files
// download like any artifact.
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiErrorSchema,
  stagedUploadResultSchema,
  uploadToTaskResultSchema,
} from "@jj/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "./server";
import {
  OPEN_TIMEOUT,
  quietLogger,
  type TestApp,
  testApp,
  untilTask,
} from "./testing";

let t: TestApp;

beforeAll(async () => {
  t = await testApp({
    engine: { uploads: { maxFileBytes: 4 * 1024 * 1024, maxInFlight: 1 } },
  });
}, OPEN_TIMEOUT);
afterAll(async () => {
  await t?.dispose();
});

const octet = { "Content-Type": "application/octet-stream" };

/** A raw upload through `app.request`. */
async function put(
  name: string,
  body: RequestInit["body"],
  headers: Record<string, string> = {},
  app = t.app,
) {
  const response = await app.request(
    `/api/uploads?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { ...octet, ...headers },
      body,
      // Node's fetch needs it for a stream body.
      duplex: "half",
    },
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const refused = (body: unknown) => apiErrorSchema.parse(body).error;

/** A body stream that records whether anything pulled from it. */
function watchedBody() {
  const watched = { pulled: false };
  // A high-water mark of 0: nothing is pulled until something reads.
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        watched.pulled = true;
        controller.enqueue(new Uint8Array(1024));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, watched };
}

async function bot() {
  const created = await t.call("POST", "/api/bots", {
    name: `Uploader${Math.random().toString(36).slice(2, 7)}`,
    model: "scripted/team",
  });
  return created.body.bot.id as string;
}

describe("POST /api/uploads", () => {
  it("stages the bytes and derives the content type on the server", async () => {
    const { status, body } = await put("data.csv", "a,b\n1,2\n", {
      "Content-Length": "8",
    });
    expect(status).toBe(201);
    const { upload } = stagedUploadResultSchema.parse(body);
    expect(upload).toMatchObject({
      name: "data.csv",
      sizeBytes: 8,
      contentType: "text/csv; charset=utf-8",
    });
    // A content type the client sends with the bytes is not one it can choose.
    const typed = await put("page.bin", "<script>alert(1)</script>", {
      "Content-Length": "25",
      "Content-Type": "application/octet-stream; x=text/html",
    });
    expect(typed.status).toBe(201);
    expect(typed.body.upload.contentType).toBe("text/plain; charset=utf-8");
  });

  it("takes octet-stream only: JSON, multipart, forms and text are 415", async () => {
    for (const type of [
      "application/json",
      "multipart/form-data; boundary=x",
      "application/x-www-form-urlencoded",
      "text/plain",
    ]) {
      const { status, body } = await put("a.txt", "x", {
        "Content-Type": type,
        "Content-Length": "1",
      });
      expect(status, type).toBe(415);
      expect(refused(body).code).toBe("VALIDATION_FAILED");
    }
    // And octet-stream is refused on every other write.
    const other = await t.app.request("/api/bots", {
      method: "POST",
      headers: octet,
      body: "{}",
    });
    expect(other.status).toBe(415);
  });

  it("refuses a cross-site upload, which a page could only send after a preflight", async () => {
    const { stream, watched } = watchedBody();
    const { status, body } = await put("a.txt", stream, {
      "Content-Length": "1024",
      "Sec-Fetch-Site": "cross-site",
    });
    expect(status).toBe(403);
    expect(refused(body).code).toBe("UNAUTHORIZED");
    expect(watched.pulled).toBe(false);
  });

  it("answers 413 from Content-Length before reading the body, and 411 without one", async () => {
    const { stream, watched } = watchedBody();
    const { status, body } = await put("big.bin", stream, {
      "Content-Length": String(10 ** 12),
    });
    expect(status).toBe(413);
    expect(refused(body)).toMatchObject({
      code: "UPLOAD_TOO_LARGE",
      message: "big.bin is 931.3 GB; a file can be at most 4 MB.",
    });
    expect(watched.pulled).toBe(false);
    const chunked = watchedBody();
    const missing = await put("a.bin", chunked.stream);
    expect(missing.status).toBe(411);
    expect(chunked.watched.pulled).toBe(false);
    const nonsense = await put("a.bin", null, { "Content-Length": "1e9" });
    expect(nonsense.status).toBe(400);
  });

  it("takes a body larger than the JSON limit when the upload limit allows it", async () => {
    const bytes = new Uint8Array(1536 * 1024).fill(7);
    const { status, body } = await put("large.bin", bytes, {
      "Content-Length": String(bytes.byteLength),
    });
    expect(status).toBe(201);
    expect(body.upload.sizeBytes).toBe(bytes.byteLength);
    const json = await t.app.request("/api/bots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(1536 * 1024) }),
    });
    expect(json.status).toBe(413);
  });

  it("refuses a second upload while one is in flight, then takes it", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await held;
        controller.enqueue(new Uint8Array(16));
        controller.close();
      },
    });
    const first = put("slow.bin", slow, { "Content-Length": "16" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await put("next.bin", "x", { "Content-Length": "1" });
    expect(second.status).toBe(429);
    expect(refused(second.body).code).toBe("RATE_LIMITED");
    release();
    expect((await first).status).toBe(201);
    expect((await put("next.bin", "x", { "Content-Length": "1" })).status).toBe(
      201,
    );
  });

  it("refuses names that leave the folder or hide characters", async () => {
    for (const name of ["../x", "a/b", "..", "nul\u0000", ".", ""]) {
      const { status } = await put(name, "x", { "Content-Length": "1" });
      expect(status, JSON.stringify(name)).toBe(400);
    }
  });
});

describe("attaching", () => {
  it("attaches at creation and into a task, downloads as an attachment, and refuses reuse and stopped tasks", async () => {
    const botId = await bot();
    const a = await put("a.txt", "alpha\n", { "Content-Length": "6" });
    const created = await t.call("POST", "/api/tasks", {
      goal: "Read the upload",
      coordinatorBotId: botId,
      uploads: [{ uploadId: a.body.upload.id }],
    });
    expect(created.status).toBe(201);
    const taskId = created.body.task.id as string;
    const view = await untilTask(t, taskId, (v) =>
      v.artifacts.some((artifact) => artifact.upload?.state === "placed"),
    );
    const placed = view.artifacts.find((artifact) => artifact.upload);
    expect(placed).toMatchObject({
      id: a.body.upload.id,
      path: "uploads/a.txt",
      upload: { state: "placed", error: null },
    });
    const download = await t.app.request(
      `/api/tasks/${taskId}/artifacts/${a.body.upload.id}/content`,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("alpha\n");
    expect(download.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(download.headers.get("Content-Security-Policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const reuse = await t.call("POST", `/api/tasks/${taskId}/uploads`, {
      files: [{ uploadId: a.body.upload.id }],
    });
    expect(reuse.status).toBe(409);
    expect(refused(reuse.body).code).toBe("CONFLICT");

    const b = await put("b.txt", "beta\n", { "Content-Length": "5" });
    const added = await t.call("POST", `/api/tasks/${taskId}/uploads`, {
      files: [{ uploadId: b.body.upload.id, path: "notes/b.txt" }],
    });
    expect(added.status).toBe(201);
    const result = uploadToTaskResultSchema.parse(added.body);
    expect(result.message).toMatchObject({
      authorKind: "user",
      intent: "notification",
      text: "Uploaded 1 file: notes/b.txt (5 B)",
    });
    expect(result.artifacts[0]?.upload?.state).toBe("pending");

    const traversal = await t.call("POST", `/api/tasks/${taskId}/uploads`, {
      files: [{ uploadId: "upl_x", path: "../../etc/passwd" }],
    });
    expect(traversal.status).toBe(400);

    await t.call("POST", `/api/tasks/${taskId}/stop`, {});
    const c = await put("c.txt", "c", { "Content-Length": "1" });
    const stopped = await t.call("POST", `/api/tasks/${taskId}/uploads`, {
      files: [{ uploadId: c.body.upload.id }],
    });
    expect(stopped.status).toBe(409);
    expect(refused(stopped.body).code).toBe("TASK_TERMINAL");
    const removed = await t.app.request(`/api/uploads/${c.body.upload.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    const gone = await t.app.request(`/api/uploads/${c.body.upload.id}`, {
      method: "DELETE",
    });
    expect(gone.status).toBe(404);
  });
});

describe("expired and switched off", () => {
  let expiring: TestApp;
  let off: TestApp;
  beforeAll(async () => {
    [expiring, off] = await Promise.all([
      testApp({
        startWorker: false,
        engine: {
          uploads: {
            stagedTtlMs: 1,
            maxInFlight: 1,
            minBytesPerSecond: 1024,
            slowWindowMs: 200,
          },
        },
      }),
      testApp({ startWorker: false, engine: { uploads: null } }),
    ]);
  }, OPEN_TIMEOUT);
  afterAll(async () => {
    await expiring?.dispose();
    await off?.dispose();
  });

  it("answers 408 to a body that stalls, and takes the next upload", async () => {
    const stalled = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(10));
          // Nothing more ever comes.
          return new Promise(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    const slow = await put(
      "slow.bin",
      stalled,
      { "Content-Length": "100000" },
      expiring.app,
    );
    expect(slow.status).toBe(408);
    expect(refused(slow.body).message).toMatch(/too slowly/);
    const next = await put(
      "next.bin",
      "x",
      { "Content-Length": "1" },
      expiring.app,
    );
    expect(next.status).toBe(201);
  });

  it("answers 404 for an expired staged upload", async () => {
    const staged = await put(
      "a.txt",
      "x",
      { "Content-Length": "1" },
      expiring.app,
    );
    expect(staged.status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const created = await expiring.call("POST", "/api/bots", {
      name: "Late",
    });
    const task = await expiring.call("POST", "/api/tasks", {
      goal: "late",
      coordinatorBotId: created.body.bot.id,
      uploads: [{ uploadId: staged.body.upload.id }],
    });
    expect(task.status).toBe(404);
  });

  it("answers 404 on every upload route, and reports no capability, while uploads are off", async () => {
    const bootstrap = await off.call("GET", "/api/bootstrap");
    expect(bootstrap.body.capabilities.uploads).toBeNull();
    expect(
      (await put("a.txt", "x", { "Content-Length": "1" }, off.app)).status,
    ).toBe(404);
    expect(
      (await off.app.request("/api/uploads/upl_x", { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect(
      (
        await off.call("POST", "/api/tasks/task_x/uploads", {
          files: [{ uploadId: "upl_x" }],
        })
      ).status,
    ).toBe(404);
  });
});

describe("over a socket", () => {
  let server: RunningServer;
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "jj-upload-socket-"));
    server = await startServer({
      logger: quietLogger,
      env: {
        API_PORT: "0",
        JJ_DATABASE_PATH: "memory://",
        JJ_SANDBOX_DRIVERS: "local",
        JJ_SANDBOX_ROOT: root,
        JJ_UPLOAD_MAX_FILE_MB: "1",
      },
    });
  }, OPEN_TIMEOUT);
  afterAll(async () => {
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("answers a huge Content-Length with 413 before any of the body is sent", async () => {
    const url = new URL(server.url);
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname);
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString("latin1");
        if (received.includes("\r\n\r\n")) {
          socket.destroy();
          resolve(received);
        }
      });
      socket.on("error", reject);
      // The headers alone: no byte of the declared 100 GB follows.
      socket.write(
        [
          "POST /api/uploads?name=huge.bin HTTP/1.1",
          `Host: 127.0.0.1:${url.port}`,
          "Content-Type: application/octet-stream",
          `Content-Length: ${100 * 1024 ** 3}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    expect(answer).toMatch(/^HTTP\/1\.1 413 /);
  });
});
