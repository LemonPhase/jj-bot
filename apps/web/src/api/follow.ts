/**
 * Subscription logic shared by the live and demo APIs, so both run the same
 * client code and differ only in where events and hints come from.
 *
 * - `followTask`: load the snapshot, then fold every streamed event onto it
 *   with `applyTaskEvent`, reopening after the last sequence when the stream
 *   closes. A malformed known event cannot be skipped (the cursor would move
 *   past a change for good), so it closes the stream and reloads the snapshot.
 * - `followConversation`: load the conversation, then reload it on every
 *   `conversation.changed` hint for that bot and on a hint-stream resync.
 */
import {
  applyTaskEvent,
  type ConversationView,
  type ParsedTaskEvent,
  parseTaskEvent,
  type TaskEvent,
  type TaskView,
} from "@jj/contracts";
import {
  ApiError,
  type HintOptions,
  type JJApi,
  type StreamOptions,
  type StreamState,
  type Unsubscribe,
} from "./client";

export interface TaskEventHandlers {
  onOpen(): void;
  /** One frame's payload, before validation. */
  onEvent(raw: unknown): void;
  /**
   * The connection failed. `retrying` means the transport reconnects by
   * itself (a browser EventSource sending `Last-Event-ID`); otherwise the
   * subscription reopens it after its cursor.
   */
  onError(retrying: boolean): void;
}

/** Opens a stream of the task's events after sequence `after`. Returns close. */
export type OpenTaskEvents = (
  taskId: string,
  after: number,
  handlers: TaskEventHandlers,
) => () => void;

export interface FollowOptions extends StreamOptions {
  /** Delay before reopening a closed stream; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
}

const text = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

export const toApiError = (reason: unknown): ApiError =>
  reason instanceof ApiError
    ? reason
    : new ApiError("NETWORK_ERROR", text(reason));

/**
 * A task load failure that retrying cannot fix: the task does not exist or
 * the API refused the request. The subscription stops; anything else retries.
 */
export const isTerminalTaskError = (error: ApiError): boolean =>
  error.code === "NOT_FOUND" || error.code === "UNAUTHORIZED";

/**
 * Drops a `tool.finished` output preview. Snapshots never carry them, so
 * folding streamed events without them keeps a followed view equal to a fresh
 * snapshot at the same cursor and keeps its memory bounded.
 */
export function stripToolOutput(event: TaskEvent): TaskEvent {
  if (event.type !== "tool.finished" || event.payload.output === undefined)
    return event;
  const { output: _output, ...payload } = event.payload;
  return { ...event, payload };
}

export function followTask(
  taskId: string,
  loadSnapshot: (taskId: string) => Promise<TaskView>,
  open: OpenTaskEvents,
  onView: (view: TaskView) => void,
  options: FollowOptions = {},
): Unsubscribe {
  const baseRetry = options.retryMs ?? 1000;
  const maxRetry = options.maxRetryMs ?? 15_000;
  let view: TaskView | null = null;
  let closeStream: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = baseRetry;
  /** Backoff for snapshot reloads after malformed events; reset by a good event. */
  let reloadDelay = baseRetry;
  /** Bumped per stream, so a closed stream's late callbacks are ignored. */
  let generation = 0;
  let stopped = false;
  let state: StreamState | null = null;

  const setState = (next: StreamState) => {
    if (next === state) return;
    state = next;
    options.onState?.(next);
  };
  const retry = (action: () => void) => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(action, retryDelay);
    retryDelay = Math.min(retryDelay * 2, maxRetry);
  };
  const dropStream = () => {
    generation += 1;
    closeStream?.();
    closeStream = null;
  };

  /** Folds one event; true when the view moved forward. */
  const apply = (event: ParsedTaskEvent): boolean => {
    if (!view || event.taskId !== taskId) return false;
    const next = applyTaskEvent(
      view,
      "unknown" in event ? event : stripToolOutput(event),
    );
    if (next === view) return false; // at or before the cursor: a replayed duplicate
    view = next;
    // Unknown event types only advance the cursor; nothing on screen changed.
    if (!("unknown" in event)) onView(view);
    return true;
  };

  const connect = () => {
    if (stopped || !view) return;
    dropStream();
    const current = generation;
    const live = () => !stopped && current === generation;
    setState(state === "reconnecting" ? "reconnecting" : "connecting");
    closeStream = open(taskId, view.cursor, {
      onOpen: () => {
        if (!live()) return;
        retryDelay = baseRetry;
        setState("open");
      },
      onEvent: (raw) => {
        if (!live()) return;
        let event: ParsedTaskEvent;
        try {
          event = parseTaskEvent(raw);
        } catch (reason) {
          options.onError?.(
            new ApiError(
              "INVALID_RESPONSE",
              `A malformed task event arrived; reloading the task: ${text(reason)}`,
              reason,
            ),
          );
          // Skipping it would lose the change it carries: start over from a
          // fresh snapshot, backing off in case the server keeps sending it.
          dropStream();
          setState("reconnecting");
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => void load(), reloadDelay);
          reloadDelay = Math.min(reloadDelay * 2, maxRetry);
          return;
        }
        if (apply(event)) reloadDelay = baseRetry;
      },
      onError: (retrying) => {
        if (!live()) return;
        setState("reconnecting");
        if (retrying) return;
        dropStream();
        retry(connect);
      },
    });
  };

  const load = async () => {
    try {
      const snapshot = await loadSnapshot(taskId);
      if (stopped) return;
      view = snapshot;
      onView(snapshot);
      connect();
    } catch (reason) {
      if (stopped) return;
      const error = toApiError(reason);
      options.onError?.(error);
      if (isTerminalTaskError(error)) {
        setState("closed");
        return;
      }
      setState("reconnecting");
      retry(() => void load());
    }
  };

  setState("connecting");
  void load();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    dropStream();
    setState("closed");
  };
}

export function followConversation(
  botId: string,
  getConversation: (botId: string) => Promise<ConversationView>,
  subscribeHints: JJApi["subscribeHints"],
  onView: (view: ConversationView) => void,
  options: StreamOptions = {},
): Unsubscribe {
  let stopped = false;
  let latest = 0;
  const refresh = async () => {
    const request = ++latest;
    try {
      const view = await getConversation(botId);
      // Only the newest request may land, so a slow older answer never wins.
      if (!stopped && request === latest) onView(view);
    } catch (reason) {
      if (!stopped) options.onError?.(toApiError(reason));
    }
  };
  const hintOptions: HintOptions = {
    onResync: () => void refresh(),
    onState: options.onState,
  };
  const unsubscribe = subscribeHints((hint) => {
    if (hint.type === "conversation.changed" && hint.botId === botId)
      void refresh();
  }, hintOptions);
  void refresh();
  return () => {
    stopped = true;
    unsubscribe();
  };
}
