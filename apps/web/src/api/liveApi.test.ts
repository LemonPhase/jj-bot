import {
  type Bootstrap,
  CONTRACT_VERSION,
  type ConversationView,
  emptyUsage,
  type Task,
  type TaskView,
} from "@jj/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type StreamState } from "./client";
import { createLiveApi, liveBadge, probeBackend } from "./liveApi";
import { type EventSourceLike, type SseFrame, SseParser } from "./sse";
import { readApiToken } from "./token";

const T0 = "2026-10-31T12:00:00.000Z";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const bootstrap: Bootstrap = {
  mode: "backend",
  contractVersion: CONTRACT_VERSION,
  capabilities: {
    agentExecution: true,
    persistence: true,
    streaming: true,
    verification: false,
    drivers: [{ id: "docker", available: true, isolated: true }],
  },
  defaultModel: "anthropic/model",
  bots: [],
  tasks: [],
  profiles: [],
};

const task: Task = {
  id: "task-1",
  title: "Check the stream",
  goal: "Check the stream",
  goalVersion: 1,
  coordinatorBotId: "bot-a",
  participantBotIds: ["bot-a"],
  status: "running",
  result: null,
  error: null,
  cancelReason: null,
  cancelRequestedAt: null,
  createdAt: T0,
  updatedAt: T0,
  finishedAt: null,
};

const snapshot: TaskView = {
  task,
  sessions: [],
  messages: [],
  artifacts: [],
  usage: { total: emptyUsage(), bySession: {} },
  events: [],
  firstSequence: 1,
  hasEarlier: false,
  cursor: 2,
};

const base = (sequence: number) => ({
  id: `e${sequence}`,
  taskId: "task-1",
  sequence,
  occurredAt: T0,
  botId: null,
  sessionId: null,
  runId: null,
  causedBy: null,
});

const posted = (sequence: number) => ({
  ...base(sequence),
  type: "message.posted",
  payload: {
    message: {
      id: `m${sequence}`,
      taskId: "task-1",
      sequence,
      authorKind: "user",
      authorBotId: null,
      sessionId: null,
      intent: "steering",
      text: `message ${sequence}`,
      recipientBotIds: [],
      createdAt: T0,
    },
  },
});

const unknownEvent = (sequence: number) => ({
  ...base(sequence),
  type: "future.thing",
  payload: { anything: true },
});

const conversation = (botId: string): ConversationView => ({
  botId,
  messages: [],
  replying: false,
  lastReplyError: null,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type Route = (init: RequestInit, url: string) => Response | Promise<Response>;

function mockFetch(routes: Record<string, unknown>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      const key = `${init.method ?? "GET"} ${url.split("?")[0]}`;
      const route = routes[key];
      if (route === undefined)
        return json(404, {
          error: { code: "NOT_FOUND", message: `No route ${key}` },
        });
      return typeof route === "function"
        ? (route as Route)(init, url)
        : json(200, route);
    },
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  closed = false;
  private readonly listeners = new Map<
    string,
    Set<(event: MessageEvent) => void>
  >();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  /** Sends a frame the way a server would: `event:` = type, `id:` = sequence. */
  send(
    event: { type: string; sequence?: number } | Record<string, unknown>,
    named = true,
  ) {
    const type = named ? String(event.type) : "message";
    const message = new MessageEvent(type, {
      data: JSON.stringify(event),
      lastEventId: "sequence" in event ? String(event.sequence) : "",
    });
    for (const listener of this.listeners.get(type) ?? []) listener(message);
  }
  /** `gaveUp`: the browser closed it (CLOSED); otherwise it is reconnecting itself. */
  fail(gaveUp: boolean) {
    this.readyState = gaveUp ? 2 : 0;
    this.onerror?.(new Event("error"));
  }
}

const eventSource = (url: string) => new FakeEventSource(url);
const latestSource = () => {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("no EventSource");
  return source;
};

afterEach(() => {
  FakeEventSource.instances = [];
});

describe("live API requests", () => {
  it("validates responses at the boundary", async () => {
    const { fetch } = mockFetch({
      "GET /api/bots": { bots: [{ id: "bot-a" }] },
    });
    const api = createLiveApi({ bootstrap, fetch, eventSource });
    const error = await api.listBots().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "INVALID_RESPONSE", status: 200 });
  });

  it("turns the contract error envelope into an ApiError", async () => {
    const { fetch } = mockFetch({
      "POST /api/tasks/task-1/messages": () =>
        json(409, {
          error: {
            code: "TASK_TERMINAL",
            message: "The task was stopped.",
            details: { id: 1 },
          },
        }),
    });
    const api = createLiveApi({ bootstrap, fetch, eventSource });
    const error = await api
      .postTaskMessage("task-1", { text: "hello" })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "TASK_TERMINAL",
      message: "The task was stopped.",
      details: { id: 1 },
      status: 409,
    });
  });

  it("keeps the server's message for an error code it does not know", async () => {
    const { fetch } = mockFetch({
      "GET /api/tasks": () =>
        json(429, {
          error: { code: "QUOTA_EXCEEDED", message: "Monthly quota used up." },
        }),
      "GET /api/bots": () =>
        json(401, { error: { code: "TOKEN_EXPIRED", message: "Expired." } }),
    });
    const api = createLiveApi({ bootstrap, fetch, eventSource });
    await expect(api.listTasks()).rejects.toMatchObject({
      code: "UNRECOGNIZED_ERROR",
      serverCode: "QUOTA_EXCEEDED",
      message: "Monthly quota used up.",
      status: 429,
    });
    await expect(api.listBots()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      serverCode: "TOKEN_EXPIRED",
      message: "Expired.",
    });
  });

  it("downloads artifacts through fetch only when a token must be sent", async () => {
    const { fetch, calls } = mockFetch({
      "GET /api/tasks/task-1/artifacts/a1/content": () =>
        new Response("# Findings", {
          headers: { "Content-Type": "text/markdown" },
        }),
      "GET /api/tasks/task-1/artifacts/gone/content": () =>
        json(404, { error: { code: "NOT_FOUND", message: "No artifact." } }),
    });
    expect(createLiveApi({ bootstrap, fetch }).fetchArtifact).toBeUndefined();
    const api = createLiveApi({ bootstrap, fetch, token: "secret" });
    const blob = await api.fetchArtifact?.("task-1", "a1");
    expect(await blob?.text()).toBe("# Findings");
    expect(
      (calls[0]?.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer secret");
    await expect(api.fetchArtifact?.("task-1", "gone")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "No artifact.",
    });
  });

  it("reports network failures and validates commands before sending", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const api = createLiveApi({ bootstrap, fetch, eventSource });
    await expect(api.listTasks()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    await expect(api.createBot({ name: "  " })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      api.postTaskMessage("task-1", { text: "x", goal: "New goal" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends the bearer token on every request", async () => {
    const { fetch, calls } = mockFetch({
      "GET /api/tasks": { tasks: [] },
      "DELETE /api/bots/bot-a": () => new Response(null, { status: 204 }),
    });
    const api = createLiveApi({ bootstrap, fetch, token: "secret" });
    await api.listTasks();
    await api.archiveBot("bot-a");
    expect(
      calls.map(
        (c) => (c.init.headers as Record<string, string>).Authorization,
      ),
    ).toEqual(["Bearer secret", "Bearer secret"]);
    // Reads bypass the HTTP cache, so a hint-driven refetch sees the change.
    expect(calls.map((c) => c.init.cache)).toEqual(["no-store", undefined]);
  });

  it("builds artifact URLs and badges from bootstrap", () => {
    const api = createLiveApi({
      bootstrap,
      fetch: mockFetch({}).fetch,
      eventSource,
    });
    expect(api.mode).toBe("live");
    expect(api.artifactUrl("task 1", "a/1")).toBe(
      "/api/tasks/task%201/artifacts/a%2F1/content",
    );
    expect(liveBadge(bootstrap).label).toBe("Live");
    expect(
      liveBadge({
        ...bootstrap,
        capabilities: { ...bootstrap.capabilities, agentExecution: false },
      }),
    ).toMatchObject({ label: "No model configured", tone: "warning" });
    const scripted = {
      defaultModel: "scripted/team",
      providers: [
        {
          id: "scripted",
          name: "Scripted test model",
          configured: true,
          envVars: [],
          models: [],
        },
        {
          id: "anthropic",
          name: "Anthropic",
          configured: false,
          envVars: ["ANTHROPIC_API_KEY"],
          models: [],
        },
      ],
    };
    expect(liveBadge(bootstrap, scripted)).toMatchObject({
      label: "Scripted model",
      tone: "warning",
    });
    expect(
      liveBadge({ ...bootstrap, defaultModel: "scripted/team" }).label,
    ).toBe("Scripted model");
  });
});

describe("live task stream", () => {
  const follow = (
    fetch = mockFetch({ "GET /api/tasks/task-1": snapshot }).fetch,
  ) => {
    const api = createLiveApi({ bootstrap, fetch, eventSource, retryMs: 1 });
    const views: TaskView[] = [];
    const states: StreamState[] = [];
    const errors: ApiError[] = [];
    const unsubscribe = api.subscribeTask(
      "task-1",
      (view) => views.push(view),
      {
        onState: (state) => states.push(state),
        onError: (error) => errors.push(error),
      },
    );
    return { views, states, errors, unsubscribe };
  };

  it("loads the snapshot, then streams after its cursor and folds events", async () => {
    const { views, states } = follow();
    await flush();
    expect(views).toEqual([snapshot]);
    const source = latestSource();
    expect(source.url).toBe("/api/tasks/task-1/stream?after=2");
    source.open();
    source.send(posted(3));
    expect(views).toHaveLength(2);
    expect(views[1]?.cursor).toBe(3);
    expect(views[1]?.messages.map((m) => m.text)).toEqual(["message 3"]);
    expect(states).toEqual(["connecting", "open"]);
  });

  it("never delivers an event twice", async () => {
    const { views } = follow();
    await flush();
    const source = latestSource();
    source.open();
    source.send(posted(3));
    source.send(posted(3));
    source.send(posted(2));
    source.send(posted(4));
    expect(views.map((v) => v.cursor)).toEqual([2, 3, 4]);
    expect(views.at(-1)?.messages).toHaveLength(2);
  });

  it("ignores unknown event types without moving anything on screen", async () => {
    const { views } = follow();
    await flush();
    const source = latestSource();
    source.open();
    source.send(unknownEvent(3), false);
    expect(views).toHaveLength(1);
    source.send(posted(4));
    expect(views.at(-1)?.cursor).toBe(4);
  });

  it("reloads the snapshot instead of skipping a malformed known event", async () => {
    // The first snapshot is at 2; the reload reflects the event that was malformed on the wire.
    const snapshots = [snapshot, { ...snapshot, cursor: 4 }];
    const { fetch, calls } = mockFetch({
      "GET /api/tasks/task-1": () => json(200, snapshots.shift() ?? snapshot),
    });
    const { views, errors, states } = follow(fetch);
    await flush();
    const first = latestSource();
    first.open();
    first.send(posted(3));
    first.send({ ...posted(4), payload: { message: { text: 1 } } });
    expect(errors.map((e) => e.code)).toEqual(["INVALID_RESPONSE"]);
    // The stream is closed at once, so nothing after the bad frame is applied out of order.
    expect(first.closed).toBe(true);
    first.send(posted(5));
    expect(views.map((v) => v.cursor)).toEqual([2, 3]);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(
      calls.filter((c) => c.url === "/api/tasks/task-1").map((c) => c.url),
    ).toHaveLength(2);
    const second = latestSource();
    expect(second.url).toBe("/api/tasks/task-1/stream?after=4");
    second.open();
    second.send(posted(5));
    expect(views.map((v) => v.cursor)).toEqual([2, 3, 4, 5]);
    expect(states).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  it("backs off while the server keeps sending the same malformed event", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = mockFetch({ "GET /api/tasks/task-1": snapshot });
      const api = createLiveApi({ bootstrap, fetch, eventSource, retryMs: 10 });
      const unsubscribe = api.subscribeTask("task-1", () => {});
      const loads = () =>
        calls.filter((c) => c.url === "/api/tasks/task-1").length;
      const sendBad = async () => {
        await vi.advanceTimersByTimeAsync(0);
        const source = latestSource();
        source.open();
        source.send({ ...posted(3), payload: { message: { text: 1 } } });
      };
      await sendBad();
      expect(loads()).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(loads()).toBe(2);
      await sendBad();
      // The second reload waits twice as long.
      await vi.advanceTimersByTimeAsync(10);
      expect(loads()).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(loads()).toBe(3);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops tool output previews from streamed events, as snapshots do", async () => {
    const { views } = follow();
    await flush();
    const source = latestSource();
    source.open();
    source.send({
      ...base(3),
      type: "tool.finished",
      payload: {
        toolCallId: "t1",
        tool: "bash",
        summary: "npm test",
        ok: true,
        output: "12 tests passed",
        truncated: false,
      },
    });
    const event = views.at(-1)?.events.at(-1);
    expect(event?.type).toBe("tool.finished");
    expect(event && "output" in event.payload).toBe(false);
  });

  it("stops retrying a task that does not exist and says why", async () => {
    const { fetch, calls } = mockFetch({});
    const { errors, states, views } = follow(fetch);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(views).toEqual([]);
    expect(errors.map((e) => e.code)).toEqual(["NOT_FOUND"]);
    expect(states).toEqual(["connecting", "closed"]);
    expect(calls).toHaveLength(1);
  });

  it("keeps retrying a snapshot that fails for another reason", async () => {
    let failures = 2;
    const { fetch } = mockFetch({
      "GET /api/tasks/task-1": () =>
        failures-- > 0
          ? json(503, { error: { code: "INTERNAL", message: "Restarting" } })
          : json(200, snapshot),
    });
    const { errors, views } = follow(fetch);
    await vi.waitFor(() => expect(views).toEqual([snapshot]));
    expect(errors.map((e) => e.message)).toEqual(["Restarting", "Restarting"]);
  });

  it("lets the browser resume with Last-Event-ID after a dropped connection", async () => {
    const { views, states } = follow();
    await flush();
    const source = latestSource();
    source.open();
    source.send(posted(3));
    source.fail(false);
    source.open();
    // The resumed stream may repeat what was already applied.
    source.send(posted(3));
    source.send(posted(4));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(views.map((v) => v.cursor)).toEqual([2, 3, 4]);
    expect(states).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  it("reconnects with ?after= when the browser gives up", async () => {
    const { views, states } = follow();
    await flush();
    const first = latestSource();
    first.open();
    first.send(posted(3));
    first.send(posted(4));
    first.fail(true);
    expect(first.closed).toBe(true);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const second = latestSource();
    expect(second.url).toBe("/api/tasks/task-1/stream?after=4");
    second.open();
    second.send(posted(4));
    second.send(posted(5));
    expect(views.map((v) => v.cursor)).toEqual([2, 3, 4, 5]);
    expect(states).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  it("stops cleanly", async () => {
    const { unsubscribe, states } = follow();
    await flush();
    const source = latestSource();
    unsubscribe();
    expect(source.closed).toBe(true);
    expect(states.at(-1)).toBe("closed");
  });

  it("with a token, streams over fetch with Authorization and Last-Event-ID", async () => {
    const encoder = new TextEncoder();
    const frames = [
      `: comment\nid: 3\nevent: message.posted\ndata: ${JSON.stringify(posted(3))}\n\n`,
      `id: 4\nevent: future.thing\ndata: ${JSON.stringify(unknownEvent(4))}\n\n`,
    ].join("");
    const streams = [
      frames,
      `id: 5\nevent: message.posted\ndata: ${JSON.stringify(posted(5))}\n\n`,
    ];
    const { fetch, calls } = mockFetch({
      "GET /api/tasks/task-1": snapshot,
      "GET /api/tasks/task-1/stream": () => {
        const body = streams.shift() ?? "";
        // Split mid-frame to exercise the incremental parser.
        const cut = Math.floor(body.length / 2);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(body.slice(0, cut)));
            controller.enqueue(encoder.encode(body.slice(cut)));
            if (streams.length === 0) return; // keep the last connection open
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    const api = createLiveApi({
      bootstrap,
      fetch,
      token: "secret",
      retryMs: 1,
    });
    const views: TaskView[] = [];
    const unsubscribe = api.subscribeTask("task-1", (view) => views.push(view));
    await vi.waitFor(() => expect(views.at(-1)?.cursor).toBe(5));
    unsubscribe();
    const streamCalls = calls.filter((c) => c.url.includes("/stream"));
    expect(streamCalls.map((c) => c.url)).toEqual([
      "/api/tasks/task-1/stream?after=2",
      "/api/tasks/task-1/stream?after=4",
    ]);
    const headers = streamCalls.map(
      (c) => c.init.headers as Record<string, string>,
    );
    expect(
      headers.map((h) => [h.Authorization, h["Last-Event-ID"], h.Accept]),
    ).toEqual([
      ["Bearer secret", "2", "text/event-stream"],
      ["Bearer secret", "4", "text/event-stream"],
    ]);
    expect(views.map((v) => v.cursor)).toEqual([2, 3, 5]);
  });
});

describe("live workspace hints", () => {
  it("shares one stream and refetches only the changed conversation", async () => {
    const { fetch, calls } = mockFetch({
      "GET /api/bots/bot-a/messages": conversation("bot-a"),
      "GET /api/bots/bot-b/messages": conversation("bot-b"),
    });
    const api = createLiveApi({ bootstrap, fetch, eventSource, retryMs: 1 });
    const seen: string[] = [];
    const stopA = api.subscribeConversation("bot-a", (v) => seen.push(v.botId));
    const stopB = api.subscribeConversation("bot-b", (v) => seen.push(v.botId));
    await flush();
    expect(FakeEventSource.instances.map((s) => s.url)).toEqual([
      "/api/stream",
    ]);
    const source = latestSource();
    source.open();
    source.send({ type: "conversation.changed", botId: "bot-a" });
    source.send({ type: "something.new" });
    await flush();
    expect(seen.sort()).toEqual(["bot-a", "bot-a", "bot-b"]);

    // Hints are not resumable: a reconnect refetches everything shown.
    source.fail(true);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    latestSource().open();
    await flush();
    expect(calls.filter((c) => c.url.endsWith("bot-b/messages"))).toHaveLength(
      2,
    );
    stopA();
    stopB();
    expect(latestSource().closed).toBe(true);
  });
});

describe("backend probe", () => {
  it("explains why the live API is not used", async () => {
    const unreachable = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    expect(await probeBackend({ fetch: unreachable })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/isn't reachable/),
    });
    const html = vi.fn(
      async () => new Response("<!doctype html>", { status: 200 }),
    );
    expect(
      await probeBackend({ fetch: html as unknown as typeof globalThis.fetch }),
    ).toMatchObject({
      reason: expect.stringMatching(/isn't reachable/),
    });
    const legacy = mockFetch({
      "GET /api/bootstrap": { mode: "backend", contractVersion: "0.4.0" },
    });
    expect(await probeBackend({ fetch: legacy.fetch })).toMatchObject({
      reason: expect.stringMatching(/doesn't match contract/),
    });
    const locked = mockFetch({
      "GET /api/bootstrap": () => json(401, { error: "UNAUTHORIZED" }),
    });
    expect(await probeBackend({ fetch: locked.fetch })).toMatchObject({
      reason: expect.stringMatching(/\?token=/),
    });
    const scaffold = mockFetch({
      "GET /api/bootstrap": { ...bootstrap, mode: "scaffold" },
    });
    expect(await probeBackend({ fetch: scaffold.fetch })).toMatchObject({
      reason: expect.stringMatching(/scaffold/),
    });
    const ok = mockFetch({ "GET /api/bootstrap": bootstrap });
    expect(await probeBackend({ fetch: ok.fetch })).toMatchObject({
      ok: true,
      models: null,
    });
  });
});

describe("SSE parser", () => {
  it("handles CRLF, multi-line data, comments and a persistent id", () => {
    const frames: SseFrame[] = [];
    const parser = new SseParser((frame) => frames.push(frame));
    parser.push(
      "id: 7\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\n: keep-alive\n\n",
    );
    parser.push("data: three\n");
    parser.push("\n");
    expect(frames).toEqual([
      { id: "7", event: "a", data: "one\ntwo" },
      { id: "7", event: "message", data: "three" },
    ]);
  });
});

describe("API token", () => {
  const storage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };
  };

  it("keeps a pasted ?token= in storage and removes it from the address bar", () => {
    const store = storage();
    const replaceState = vi.fn();
    expect(
      readApiToken({
        location: { href: "http://localhost:5173/?token=abc&demo" },
        history: { replaceState },
        storage: store,
      }),
    ).toBe("abc");
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "http://localhost:5173/?demo",
    );
    expect(
      readApiToken({
        location: { href: "http://localhost:5173/" },
        storage: store,
      }),
    ).toBe("abc");
    expect(
      readApiToken({
        location: { href: "http://localhost:5173/?token=" },
        storage: store,
      }),
    ).toBeNull();
    expect(
      readApiToken({
        location: { href: "http://localhost:5173/" },
        storage: store,
      }),
    ).toBeNull();
  });
});
