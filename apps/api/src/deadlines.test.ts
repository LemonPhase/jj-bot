// Request deadlines (deadlines.ts) over a real Node server and the real app:
// a deadline ends with its request, however the request ends, and a 408
// goes out only where the connection is not already sending an answer.
import type { Server } from "node:http";
import { connect, type Socket } from "node:net";
import { serve } from "@hono/node-server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { enforceDeadlines } from "./deadlines";
import {
  OPEN_TIMEOUT,
  quietLogger,
  sleep,
  type TestApp,
  testApp,
  until,
} from "./testing";

let t: TestApp;
beforeAll(async () => {
  t = await testApp();
}, OPEN_TIMEOUT);
afterAll(async () => {
  await t?.dispose();
});

interface Served {
  port: number;
  /** The server's side of every connection, in the order they came. */
  connections: Socket[];
  close(): Promise<void>;
}

/** The app on a Node server with deadlines of these lengths. */
async function serveWithDeadlines(
  requestTimeoutMs: number,
  uploadMs: number,
): Promise<Served> {
  const connections: Socket[] = [];
  const server = await new Promise<Server>((resolve) => {
    const listening = serve(
      { fetch: t.app.fetch, hostname: "127.0.0.1", port: 0 },
      () => resolve(listening as Server),
    );
  });
  server.on("connection", (socket: Socket) => connections.push(socket));
  enforceDeadlines(server, {
    requestTimeoutMs,
    uploadReceiveMs: () => uploadMs,
    headers: { strictTransportSecurity: false },
    logger: quietLogger,
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Writes `text` on a new connection; resolves with all the server sent once it closes it. */
function exchange(port: number, text: string) {
  return new Promise<string>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
    });
    socket.on("error", () => {});
    socket.on("close", () => resolve(received));
    socket.write(text);
  });
}

/** The status lines in what a connection received; a body may end without a newline. */
const statusLines = (received: string) =>
  received.match(/HTTP\/1\.1 \d{3} /g) ?? [];

/**
 * Timers of these lengths set from now on and neither cleared nor run yet:
 * the deadlines, whose lengths no other timer here has.
 */
function watchTimers(lengths: number[]) {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const pending = new Set<unknown>();
  const set = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const handle = realSet(
      (...passed: unknown[]) => {
        pending.delete(handle);
        callback(...passed);
      },
      ms,
      ...args,
    );
    if (ms !== undefined && lengths.includes(ms)) pending.add(handle);
    return handle;
  }) as unknown as typeof setTimeout);
  const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
    handle?: NodeJS.Timeout,
  ) => {
    pending.delete(handle);
    realClear(handle);
  }) as typeof clearTimeout);
  return {
    get pending() {
      return pending.size;
    },
    restore() {
      set.mockRestore();
      clear.mockRestore();
    },
  };
}

describe("a deadline ends with its request", () => {
  // Long enough that no deadline runs out during a test.
  const REQUEST_MS = 333_333;
  const UPLOAD_MS = 1_777_777;
  let served: Served;
  beforeAll(async () => {
    served = await serveWithDeadlines(REQUEST_MS, UPLOAD_MS);
  });
  afterAll(async () => {
    await served?.close();
  });
  let timers: ReturnType<typeof watchTimers> | undefined;
  afterEach(() => {
    timers?.restore();
    timers = undefined;
  });

  it("clears the deadline of a request refused before its body is read, once the server closes its connection", async () => {
    const watched = watchTimers([REQUEST_MS, UPLOAD_MS]);
    timers = watched;
    const host = `Host: 127.0.0.1:${served.port}`;
    const upload = (headers: string[], length = 16 * 1024 * 1024) =>
      [
        "POST /api/uploads?name=a.bin HTTP/1.1",
        ...headers,
        `Content-Length: ${length}`,
        "",
        "x".repeat(1000),
      ].join("\r\n");
    // Each sends part of its body and waits: the server answers, reads
    // what comes for a while, then closes the connection.
    const refusals = [
      upload([
        host,
        "Sec-Fetch-Site: cross-site",
        "Content-Type: application/octet-stream",
      ]),
      upload(["Host: evil.example", "Content-Type: application/octet-stream"]),
      upload([host, "Content-Type: text/plain"]),
      upload(
        [host, "Content-Type: application/octet-stream"],
        100 * 1024 * 1024,
      ),
      [
        "POST /api/bots HTTP/1.1",
        host,
        "Content-Type: text/plain",
        "Content-Length: 5000",
        "",
        "x".repeat(1000),
      ].join("\r\n"),
    ];
    const answers = await Promise.all(
      refusals.map((text) => exchange(served.port, text)),
    );
    expect(answers.map((answer) => statusLines(answer).join(""))).toEqual([
      "HTTP/1.1 403 ",
      "HTTP/1.1 403 ",
      "HTTP/1.1 415 ",
      "HTTP/1.1 413 ",
      "HTTP/1.1 415 ",
    ]);
    // Before the fix, each of them stayed until its deadline, holding the
    // request, its response and its socket.
    await until(() => watched.pending === 0, { timeoutMs: 3_000 }).catch(
      () => {},
    );
    expect(watched.pending).toBe(0);
  });

  it("adds nothing that stays on a kept-alive connection, however many requests it carries", async () => {
    const socket = connect(served.port, "127.0.0.1");
    try {
      let received = "";
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("latin1");
      });
      const host = `Host: 127.0.0.1:${served.port}`;
      const requests = [
        ["GET /api/bootstrap HTTP/1.1", host, "", ""].join("\r\n"),
        // Refused once its body is read.
        [
          "POST /api/bots HTTP/1.1",
          host,
          "Content-Type: application/json",
          "Content-Length: 2",
          "",
          "{}",
        ].join("\r\n"),
        // Refused before its body is read.
        [
          "POST /api/uploads?name=a.bin HTTP/1.1",
          host,
          "Content-Type: text/plain",
          "Content-Length: 3",
          "",
          "abc",
        ].join("\r\n"),
      ];
      let sent = 0;
      const send = async (count: number) => {
        for (let index = 0; index < count; index++) {
          socket.write(requests[sent % requests.length] as string);
          sent += 1;
          await until(() => statusLines(received).length === sent, {
            what: `answer ${sent}`,
          });
        }
        await sleep(100);
      };
      await send(requests.length);
      const server = served.connections.at(-1);
      if (!server) throw new Error("no connection");
      const before = server.listenerCount("close");
      await send(20 * requests.length);
      expect(server.destroyed).toBe(false);
      expect(server.listenerCount("close")).toBe(before);
    } finally {
      socket.destroy();
    }
  });

  it("puts one listener on a connection, however many requests wait on it", async () => {
    const watched = watchTimers([REQUEST_MS]);
    timers = watched;
    const socket = connect(served.port, "127.0.0.1");
    try {
      let received = "";
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("latin1");
      });
      const host = `Host: 127.0.0.1:${served.port}`;
      socket.write(
        [
          "GET /api/stream HTTP/1.1",
          host,
          "Accept: text/event-stream",
          "",
          "",
        ].join("\r\n"),
      );
      await until(() => received.includes("\r\n\r\n"), {
        what: "the stream's head",
      });
      const server = served.connections.at(-1);
      if (!server) throw new Error("no connection");
      const one = server.listenerCount("close");
      // Pipelined behind the stream: none of them can be answered yet.
      socket.write(
        ["GET /api/bootstrap HTTP/1.1", host, "", ""].join("\r\n").repeat(15),
      );
      await until(() => watched.pending === 16, {
        what: "a deadline for each request",
      });
      // Before, each added its own, and Node warned of a leak past 10.
      expect(server.listenerCount("close")).toBe(one);
    } finally {
      socket.destroy();
    }
  });
});

describe("a request still arriving at its deadline", () => {
  const REQUEST_MS = 500;
  let served: Served;
  beforeAll(async () => {
    served = await serveWithDeadlines(REQUEST_MS, 800);
  });
  afterAll(async () => {
    await served?.close();
  });

  it("is logged as the 408 it got, not as a server failure", async () => {
    const host = `Host: 127.0.0.1:${served.port}`;
    const from = quietLogger.lines.length;
    const answers = await Promise.all([
      exchange(
        served.port,
        [
          "POST /api/bots HTTP/1.1",
          host,
          "Content-Type: application/json",
          "Content-Length: 100",
          "",
          '{"na',
        ].join("\r\n"),
      ),
      exchange(
        served.port,
        [
          "POST /api/uploads?name=slow.bin HTTP/1.1",
          host,
          "Content-Type: application/octet-stream",
          "Content-Length: 4096",
          "",
          "x".repeat(1000),
        ].join("\r\n"),
      ),
    ]);
    expect(answers.map(statusLines)).toEqual([
      ["HTTP/1.1 408 "],
      ["HTTP/1.1 408 "],
    ]);
    const logged = () => quietLogger.lines.slice(from);
    const access = () =>
      logged()
        .filter((line) =>
          /^POST \/api\/(bots|uploads) \d{3}$/.test(line.message),
        )
        .map((line) => `${line.level} ${line.message}`)
        .sort();
    await until(() => access().length === 2, { what: "the access lines" });
    // Before the fix: the write's body read "failed Error: aborted", logged
    // with its stack as a 500, and the upload as a 400 cut off.
    expect(access()).toEqual([
      "info POST /api/bots 408",
      "info POST /api/uploads 408",
    ]);
    expect(logged().filter((line) => line.level === "error")).toEqual([]);
    expect(
      logged()
        .filter((line) => line.level === "warn")
        .map((line) => line.message)
        .sort(),
    ).toEqual([
      "POST /api/bots did not arrive within 0.5 s: answered 408 and closed the connection",
      "POST /api/uploads did not arrive within 0.8 s: answered 408 and closed the connection",
    ]);
  });

  it("closes its connection without a 408 when the connection is sending another answer", async () => {
    const host = `Host: 127.0.0.1:${served.port}`;
    // A slow write sent on behind an event stream, on one connection: the
    // stream's answer is under way when the write's deadline runs out.
    const started = Date.now();
    const received = await exchange(
      served.port,
      [
        "GET /api/stream HTTP/1.1",
        host,
        "Accept: text/event-stream",
        "",
        "POST /api/bots HTTP/1.1",
        host,
        "Content-Type: application/json",
        "Content-Length: 100",
        "",
        '{"na',
      ].join("\r\n"),
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(REQUEST_MS - 50);
    // Before the fix, a raw 408 went into the middle of the stream's body.
    expect(statusLines(received)).toEqual(["HTTP/1.1 200 "]);
    expect(received).toMatch(/text\/event-stream/);
    expect(received).not.toMatch(/408|VALIDATION_FAILED/);
  });
});
