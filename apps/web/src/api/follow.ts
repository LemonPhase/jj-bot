/**
 * Subscription logic shared by the live and demo APIs, so both run the same
 * client code and differ only in where events and hints come from.
 *
 * - `followTask`: load the snapshot, then fold every streamed event onto it
 *   with `applyTaskEvent`, reopening after the last sequence when the stream
 *   closes.
 * - `followConversation`: load the conversation, then reload it on every
 *   `conversation.changed` hint for that bot and on a hint-stream resync.
 */
import {
  applyTaskEvent,
  type ConversationView,
  type ParsedTaskEvent,
  parseTaskEvent,
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

  const apply = (event: ParsedTaskEvent) => {
    if (!view || event.taskId !== taskId) return;
    const next = applyTaskEvent(view, event);
    if (next === view) return; // at or before the cursor: a replayed duplicate
    view = next;
    // Unknown event types only advance the cursor; nothing on screen changed.
    if (!("unknown" in event)) onView(view);
  };

  const connect = () => {
    if (stopped || !view) return;
    closeStream?.();
    setState(state === "reconnecting" ? "reconnecting" : "connecting");
    closeStream = open(taskId, view.cursor, {
      onOpen: () => {
        if (stopped) return;
        retryDelay = baseRetry;
        setState("open");
      },
      onEvent: (raw) => {
        if (stopped) return;
        let event: ParsedTaskEvent;
        try {
          event = parseTaskEvent(raw);
        } catch (reason) {
          options.onError?.(
            new ApiError(
              "INVALID_RESPONSE",
              `Ignored a malformed task event: ${text(reason)}`,
              reason,
            ),
          );
          return;
        }
        apply(event);
      },
      onError: (retrying) => {
        if (stopped) return;
        setState("reconnecting");
        if (retrying) return;
        closeStream?.();
        closeStream = null;
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
      if (error.code === "NOT_FOUND" || error.code === "UNAUTHORIZED") {
        setState("closed");
        return;
      }
      setState("reconnecting");
      retry(load);
    }
  };

  setState("connecting");
  void load();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    closeStream?.();
    closeStream = null;
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
