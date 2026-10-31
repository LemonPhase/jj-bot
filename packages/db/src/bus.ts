import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { Client, type ClientConfig, type Notification } from "pg";
import type { Executor } from "./database";

export const CHANNELS = ["jj_task_event", "jj_control", "jj_hint"] as const;
export type Channel = (typeof CHANNELS)[number];

/** `jj_task_event`: task `taskId` has a new event at `sequence`. Wire format `taskId:sequence`. */
export interface TaskEventNotice {
  taskId: string;
  sequence: number;
}

export const CONTROL_KINDS = ["steer", "cancel", "wake"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/** `jj_control`: a request to the worker running a task's sessions. JSON on the wire. */
export interface ControlMessage {
  kind: ControlKind;
  taskId: string;
  sessionId?: string;
}

/** `jj_hint`: a workspace change clients may want to refetch, e.g. `{ kind: "conversation.changed", botId }`. JSON on the wire. */
export type WorkspaceHint = { kind: string } & { [key: string]: unknown };

export interface ChannelMessages {
  jj_task_event: TaskEventNotice;
  jj_control: ControlMessage;
  jj_hint: WorkspaceHint;
}

export type Handler<C extends Channel> = (message: ChannelMessages[C]) => void;
export type Unsubscribe = () => Promise<void>;

/**
 * LISTEN/NOTIFY over the database, the same on PGlite and PostgreSQL.
 * Notifications are hints, not data: a notification sent in a transaction is
 * delivered only after it commits, can be lost while a listener reconnects, and
 * consumers re-read the durable rows (for example events after their cursor).
 */
export interface Bus {
  /** Resolves once the channel is being listened to, so a read that follows cannot miss a later notification. */
  subscribe<C extends Channel>(
    channel: C,
    handler: Handler<C>,
  ): Promise<Unsubscribe>;
  /** Sends through `exec`; inside a transaction the notification is delivered on commit and dropped on rollback. */
  notify<C extends Channel>(
    exec: Executor,
    channel: C,
    message: ChannelMessages[C],
  ): Promise<void>;
  /**
   * Called after the PostgreSQL listener reconnects. Notifications sent while it
   * was down are lost, so subscribers re-read durable state. Never called on PGlite.
   */
  onReconnect(handler: () => void): () => void;
  close(): Promise<void>;
}

/** PostgreSQL rejects NOTIFY payloads of 8000 bytes or more. */
export const MAX_PAYLOAD_BYTES = 7999;

function assertChannel(channel: string): asserts channel is Channel {
  if (!(CHANNELS as readonly string[]).includes(channel))
    throw new Error(`Unknown bus channel: ${channel}`);
}

export function encodeMessage<C extends Channel>(
  channel: C,
  message: ChannelMessages[C],
): string {
  assertChannel(channel);
  let payload: string;
  if (channel === "jj_task_event") {
    const { taskId, sequence } = message as TaskEventNotice;
    if (!taskId || taskId.includes(":"))
      throw new Error("Task ids on the bus must be non-empty without ':'.");
    if (!Number.isSafeInteger(sequence) || sequence < 1)
      throw new Error("Event sequence must be a positive integer.");
    payload = `${taskId}:${sequence}`;
  } else {
    payload = JSON.stringify(message);
  }
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES)
    throw new Error(`Bus payload exceeds ${MAX_PAYLOAD_BYTES} bytes.`);
  return payload;
}

/** Parses a wire payload; throws on a malformed one. */
export function decodeMessage<C extends Channel>(
  channel: C,
  payload: string,
): ChannelMessages[C] {
  assertChannel(channel);
  if (channel === "jj_task_event") {
    const split = payload.lastIndexOf(":");
    const sequence = Number(payload.slice(split + 1));
    if (split < 1 || !Number.isSafeInteger(sequence) || sequence < 1)
      throw new Error(`Malformed ${channel} payload: ${payload}`);
    return {
      taskId: payload.slice(0, split),
      sequence,
    } as ChannelMessages[C];
  }
  const value: unknown = JSON.parse(payload);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Malformed ${channel} payload: ${payload}`);
  const record = value as Record<string, unknown>;
  if (channel === "jj_control") {
    const valid =
      (CONTROL_KINDS as readonly unknown[]).includes(record.kind) &&
      typeof record.taskId === "string" &&
      (record.sessionId === undefined || typeof record.sessionId === "string");
    if (!valid) throw new Error(`Malformed ${channel} payload: ${payload}`);
  } else if (typeof record.kind !== "string") {
    throw new Error(`Malformed ${channel} payload: ${payload}`);
  }
  return record as ChannelMessages[C];
}

/** `pg_notify` through `exec` (a transaction, or the database for an immediate send). */
export async function notify<C extends Channel>(
  exec: Executor,
  channel: C,
  message: ChannelMessages[C],
): Promise<void> {
  const payload = encodeMessage(channel, message);
  await exec.execute(sql`select pg_notify(${channel}, ${payload})`);
}

/** The driver-specific half of the bus: one LISTEN per channel. */
export interface Listener {
  listen(channel: Channel, deliver: (payload: string) => void): Promise<void>;
  unlisten(channel: Channel): Promise<void>;
  /** Registers the callback fired after a lost connection is re-established. */
  setReconnectHandler(handler: () => void): void;
  close(): Promise<void>;
}

/** Bus logic shared by both drivers: handler fan-out, decoding and error isolation. */
export function createBus(
  listener: Listener,
  onError: (error: unknown) => void,
): Bus {
  const handlers = new Map<Channel, Set<(payload: string) => void>>();
  const listening = new Map<Channel, Promise<void>>();
  const reconnectHandlers = new Set<() => void>();
  let closed = false;

  listener.setReconnectHandler(() => {
    for (const handler of [...reconnectHandlers]) {
      try {
        handler();
      } catch (error) {
        onError(error);
      }
    }
  });

  function dispatch(channel: Channel, payload: string) {
    for (const deliver of [...(handlers.get(channel) ?? [])]) deliver(payload);
  }

  return {
    async subscribe(channel, handler) {
      if (closed) throw new Error("The bus is closed.");
      assertChannel(channel);
      const deliver = (payload: string) => {
        let message: ChannelMessages[typeof channel];
        try {
          message = decodeMessage(channel, payload);
        } catch (error) {
          onError(error);
          return;
        }
        try {
          handler(message);
        } catch (error) {
          onError(error);
        }
      };
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
        listening.set(
          channel,
          listener.listen(channel, (payload) => dispatch(channel, payload)),
        );
      }
      set.add(deliver);
      const current = set;
      const drop = async () => {
        if (!current.delete(deliver) || current.size > 0) return;
        if (handlers.get(channel) !== current) return;
        handlers.delete(channel);
        listening.delete(channel);
        if (!closed) await listener.unlisten(channel);
      };
      try {
        await listening.get(channel);
      } catch (error) {
        await drop().catch(() => {});
        throw error;
      }
      return drop;
    },
    notify,
    onReconnect(handler) {
      reconnectHandlers.add(handler);
      return () => {
        reconnectHandlers.delete(handler);
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      handlers.clear();
      listening.clear();
      reconnectHandlers.clear();
      await listener.close();
    },
  };
}

/**
 * PGlite delivers notifications on its single connection after the notifying
 * transaction commits. Do not subscribe from inside a PGlite transaction
 * callback: PGlite runs one transaction at a time, so it would wait forever.
 */
export function pgliteListener(client: PGlite): Listener {
  const active = new Map<Channel, () => Promise<void>>();
  return {
    async listen(channel, deliver) {
      active.set(channel, await client.listen(channel, deliver));
    },
    async unlisten(channel) {
      const stop = active.get(channel);
      active.delete(channel);
      await stop?.();
    },
    setReconnectHandler() {},
    async close() {
      const stops = [...active.values()];
      active.clear();
      if (client.closed) return;
      for (const stop of stops) await stop();
    },
  };
}

/** `application_name` of the bus's LISTEN connection, as shown in `pg_stat_activity`. */
export const LISTENER_APPLICATION_NAME = "jj-bus-listener";

const RECONNECT_MIN_MS = 100;
const RECONNECT_MAX_MS = 5_000;
export const DEFAULT_PING_INTERVAL_MS = 30_000;
export const DEFAULT_PING_TIMEOUT_MS = 10_000;

/** Liveness of the PostgreSQL listener connection. */
export interface BusOptions {
  /** How often the listener runs `SELECT 1` on its connection. Default 30 s. */
  pingIntervalMs?: number;
  /** A ping slower than this counts as a dead connection. Default 10 s. */
  pingTimeoutMs?: number;
}

export interface ListenerOptions extends BusOptions {
  /** Builds the listener's client; a seam for tests. */
  createClient?: (config: ClientConfig) => Client;
}

/**
 * One dedicated connection (outside the pool) for LISTEN, opened on the first
 * subscription, with TCP keepalive and a periodic ping. When it errors, ends
 * or misses a ping, the listener reconnects with backoff, re-issues LISTEN
 * for every channel, then fires the reconnect handler.
 */
export function postgresListener(
  connectionString: string,
  onError: (error: unknown) => void,
  options: ListenerOptions = {},
): Listener {
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const createClient =
    options.createClient ?? ((config: ClientConfig) => new Client(config));
  const channels = new Map<Channel, (payload: string) => void>();
  let client: Client | undefined;
  let connecting: Promise<Client> | undefined;
  let lost = false;
  let closed = false;
  let retryTimer: NodeJS.Timeout | undefined;
  let pingTimer: NodeJS.Timeout | undefined;
  let retryDelay = RECONNECT_MIN_MS;
  let reconnected: () => void = () => {};

  const quote = (channel: Channel) => `"${channel}"`;

  async function connect(): Promise<Client> {
    const next = createClient({
      connectionString,
      application_name: LISTENER_APPLICATION_NAME,
      keepAlive: true,
    });
    next.on("notification", (message: Notification) => {
      channels.get(message.channel as Channel)?.(message.payload ?? "");
    });
    next.on("error", (error) => {
      onError(error);
      dropped(next);
    });
    next.on("end", () => dropped(next));
    try {
      await next.connect();
      for (const channel of [...channels.keys()])
        await next.query(`LISTEN ${quote(channel)}`);
    } catch (error) {
      next.removeAllListeners("end");
      await next.end().catch(() => {});
      throw error;
    }
    if (closed) {
      await next.end().catch(() => {});
      throw new Error("The bus is closed.");
    }
    return next;
  }

  function ensure(): Promise<Client> {
    if (client) return Promise.resolve(client);
    connecting ??= connect().then(
      (next) => {
        client = next;
        connecting = undefined;
        retryDelay = RECONNECT_MIN_MS;
        schedulePing(next);
        if (lost) {
          lost = false;
          reconnected();
        }
        return next;
      },
      (error) => {
        connecting = undefined;
        throw error;
      },
    );
    return connecting;
  }

  function schedulePing(current: Client) {
    if (pingTimer) clearTimeout(pingTimer);
    pingTimer = setTimeout(() => {
      pingTimer = undefined;
      if (closed || client !== current) return;
      let timeout: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Bus listener ping timed out after ${pingTimeoutMs} ms.`,
              ),
            ),
          pingTimeoutMs,
        );
      });
      Promise.race([current.query("SELECT 1"), timedOut]).then(
        () => {
          clearTimeout(timeout);
          if (client === current) schedulePing(current);
        },
        (error) => {
          clearTimeout(timeout);
          if (client !== current) return;
          onError(error);
          dropped(current);
        },
      );
    }, pingIntervalMs);
    pingTimer.unref();
  }

  function dropped(which: Client) {
    if (client !== which) return;
    client = undefined;
    lost = true;
    if (pingTimer) clearTimeout(pingTimer);
    pingTimer = undefined;
    which.end().catch(() => {});
    // A dead peer may never answer the termination; drop the socket outright.
    (
      which as unknown as { connection?: { stream?: { destroy(): void } } }
    ).connection?.stream?.destroy();
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (closed || retryTimer || channels.size === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (closed || client || channels.size === 0) return;
      ensure().catch((error) => {
        onError(error);
        retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
        scheduleReconnect();
      });
    }, retryDelay);
    retryTimer.unref();
  }

  return {
    async listen(channel, deliver) {
      channels.set(channel, deliver);
      try {
        const active = await ensure();
        await active.query(`LISTEN ${quote(channel)}`);
      } catch (error) {
        channels.delete(channel);
        throw error;
      }
    },
    async unlisten(channel) {
      channels.delete(channel);
      // A broken connection has already dropped its LISTENs.
      await client?.query(`UNLISTEN ${quote(channel)}`).catch(() => {});
    },
    setReconnectHandler(handler) {
      reconnected = handler;
    },
    async close() {
      closed = true;
      channels.clear();
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      if (pingTimer) clearTimeout(pingTimer);
      pingTimer = undefined;
      const active = client ?? (await connecting?.catch(() => undefined));
      client = undefined;
      if (active) {
        active.removeAllListeners("end");
        await active.end().catch(() => {});
      }
    },
  };
}
