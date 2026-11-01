import {
  type Bot,
  type BotMemory,
  type ConversationMessage,
  type ConversationView,
  type CreateBotCommand,
  emptyUsage,
  type RuntimeProfile,
  type Task,
  type TaskSummary,
  type TaskView,
  type UpdateBotCommand,
} from "@jj/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApi } from "../api/ApiContext";
import type { ApiError, StreamState } from "../api/client";
import { toApiError } from "../api/follow";
import { navigate, useRoute } from "../features/shell/useRoute";
import { summaryFromView } from "../lib/tasks";
import {
  unknownTaskIds,
  withStoredMessage,
  withUnseenMessages,
} from "./conversationState";
import { createRefetcher } from "./refetch";
import {
  applyOverlay,
  hintNeedsTaskList,
  overlayMessage,
  overlayTask,
  pruneOverlay,
  type TaskOverlay,
  type TaskProblem,
  taskProblem,
} from "./taskState";

export type { TaskProblem } from "./taskState";

/** A task-chat message that has been submitted but not yet acknowledged. */
export interface PendingTaskSend {
  text: string;
  /** The message also replaces the task goal. */
  changesGoal: boolean;
}

/** How an action the screen shows in place went: the server's error when it failed. */
export type ActionResult = { ok: true } | { ok: false; error: ApiError };

export interface NewTaskInput {
  goal: string;
  /** The first entry is the coordinator. */
  participantBotIds: string[];
}

interface WorkspaceValue {
  loading: boolean;
  /** Why the workspace did not load (bootstrap failed); null once it has. */
  loadError: string | null;
  /** Tries the bootstrap again after `loadError`. */
  retryLoad: () => void;
  error: string | null;
  dismissError: () => void;

  bots: Bot[];
  tasks: TaskSummary[];
  profiles: RuntimeProfile[];
  /** The open bot's conversation (the last one seen for others). */
  conversations: Record<string, ConversationView>;
  /**
   * Full views of the tasks being followed (the open one), with the message a
   * post returned and the task a stop returned applied until the stream
   * delivers them.
   */
  taskViews: Record<string, TaskView>;
  /** Connection state of the open task's event stream. */
  taskStreamState: StreamState | null;
  /** Why the open task failed to load or follow; cleared by the next view. */
  taskProblem: TaskProblem | null;
  /** Reloads the open task from a fresh snapshot (after a failure or a stale goal). */
  retryTask: () => void;
  memories: Record<string, BotMemory>;
  getBot: (botId: string) => Bot | undefined;
  getTask: (taskId: string) => TaskSummary | undefined;

  /** The bot in the URL (`#/bots/:id`); null on other screens. */
  selectedBotId: string | null;
  selectBot: (botId: string) => void;
  /** The task in the URL (`#/tasks/:id`), whose event stream is followed. */
  selectedTaskId: string | null;
  selectTask: (taskId: string) => void;
  selectedNodeId: string | null;
  selectNode: (nodeId: string) => void;
  jumpToTask: (taskId: string) => void;
  jumpToBot: (botId: string) => void;

  // Form actions resolve with the stored record and reject with the ApiError,
  // so the form that called them can show the server's message in place.
  /** Creates the bot and opens it. */
  createBot: (command: CreateBotCommand) => Promise<Bot>;
  updateBot: (botId: string, command: UpdateBotCommand) => Promise<Bot>;
  /** Rejects with `CONFLICT` while the bot has active tasks. */
  archiveBot: (botId: string) => Promise<void>;
  /** Refetches the runtime profiles, e.g. after Settings changed one. */
  refreshProfiles: () => Promise<void>;
  /** Refetches the bots, e.g. after the server refused an action on stale state. */
  refreshBots: () => Promise<void>;
  saveMemory: (botId: string, text: string) => Promise<BotMemory>;
  /** Creates the task and opens it. */
  createTask: (input: NewTaskInput) => Promise<Task>;

  /** Loads a bot's memory; a failure lands in `memoryErrors`, not `error`. */
  loadMemory: (botId: string) => Promise<void>;
  /** Why a bot's memory did not load, keyed by bot id, until it does. */
  memoryErrors: Record<string, string>;

  // Fire-and-forget actions report failures in `error`.
  /**
   * Resolves false when the message was not accepted (the error is in
   * `error`). Once accepted, the stored message shows in the conversation at
   * once, with the bot replying.
   */
  sendBotMessage: (botId: string, text: string) => Promise<boolean>;
  /**
   * Posts to the task chat; `changesGoal` also replaces the goal against the
   * version on screen. Failures (STALE_GOAL_VERSION, TASK_TERMINAL…) come back
   * in the result for the chat to show in place.
   */
  postTaskMessage: (
    taskId: string,
    text: string,
    changesGoal: boolean,
  ) => Promise<ActionResult>;
  stopTask: (taskId: string) => Promise<ActionResult>;
  advanceDemoTask?: (taskId: string) => Promise<void>;
  /** Text of a bot-chat message being sent, keyed by bot id. */
  pendingBotTurns: Record<string, string>;
  /** Task-chat message awaiting acknowledgement, keyed by task id. */
  pendingTaskSends: Record<string, PendingTaskSend>;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : "Something went wrong";

const upsert = <Item extends { id: string }>(items: Item[], item: Item) =>
  items.some((existing) => existing.id === item.id)
    ? items.map((existing) => (existing.id === item.id ? item : existing))
    : [item, ...items];

const without = <Value,>(record: Record<string, Value>, key: string) => {
  const next = { ...record };
  delete next[key];
  return next;
};

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [profiles, setProfiles] = useState<RuntimeProfile[]>([]);
  const [conversations, setConversations] = useState<
    Record<string, ConversationView>
  >({});
  const [streamedViews, setStreamedViews] = useState<Record<string, TaskView>>(
    {},
  );
  const [overlays, setOverlays] = useState<Record<string, TaskOverlay>>({});
  const [taskStreamState, setTaskStreamState] = useState<StreamState | null>(
    null,
  );
  const [problem, setProblem] = useState<TaskProblem | null>(null);
  const [taskReload, setTaskReload] = useState(0);
  const [memories, setMemories] = useState<Record<string, BotMemory>>({});
  const [memoryErrors, setMemoryErrors] = useState<Record<string, string>>({});
  const [pendingBotTurns, setPendingBotTurns] = useState<
    Record<string, string>
  >({});
  const [pendingTaskSends, setPendingTaskSends] = useState<
    Record<string, PendingTaskSend>
  >({});
  const route = useRoute();
  const selectedBotId = route.name === "bots" ? route.botId : null;
  const selectedTaskId = route.name === "tasks" ? route.taskId : null;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const taskViews = useMemo(() => {
    const merged: Record<string, TaskView> = {};
    for (const [taskId, view] of Object.entries(streamedViews))
      merged[taskId] = applyOverlay(view, overlays[taskId]);
    return merged;
  }, [streamedViews, overlays]);

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const viewsRef = useRef(taskViews);
  viewsRef.current = taskViews;
  const selectedTaskRef = useRef(selectedTaskId);
  selectedTaskRef.current = selectedTaskId;

  const report = useCallback(
    (reason: unknown) => setError(message(reason)),
    [],
  );

  const refreshProfiles = useCallback(
    async () => setProfiles(await api.listProfiles()),
    [api],
  );
  const refreshBots = useCallback(
    async () => setBots(await api.listBots()),
    [api],
  );

  const applyTaskList = useCallback((summaries: TaskSummary[]) => {
    // An open task's streamed view may be newer than the list it raced with.
    setTasks(
      summaries.map((summary) => {
        const view = viewsRef.current[summary.id];
        return view &&
          view.cursor > 0 &&
          view.task.updatedAt > summary.updatedAt
          ? summaryFromView(view)
          : summary;
      }),
    );
  }, []);

  // Initial load. A failure is its own state, so screens never mistake it
  // for an empty workspace.
  useEffect(() => {
    let cancelled = false;
    void loadAttempt;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const boot = await api.bootstrap();
        if (cancelled) return;
        setBots(boot.bots);
        setTasks(boot.tasks);
        setProfiles(boot.profiles);
      } catch (reason) {
        if (!cancelled) setLoadError(message(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, loadAttempt]);

  // Workspace hints say what to refetch. Each kind of refetch is debounced so
  // a burst of hints costs one request, and only its newest answer lands.
  useEffect(() => {
    const ignore = () => {};
    const delayMs = 200;
    const botsRefetch = createRefetcher(api.listBots, setBots, {
      delayMs,
      onError: ignore,
    });
    const profilesRefetch = createRefetcher(api.listProfiles, setProfiles, {
      delayMs,
      onError: ignore,
    });
    const tasksRefetch = createRefetcher(api.listTasks, applyTaskList, {
      delayMs,
      onError: ignore,
    });
    // The open task's summary comes from its streamed view, so its own
    // `tasks.changed` hints need no list refetch while that view is live.
    const streamed = () => {
      const taskId = selectedTaskRef.current;
      return taskId && viewsRef.current[taskId] ? taskId : null;
    };
    const unsubscribe = api.subscribeHints(
      (hint) => {
        if (hint.type === "bots.changed") botsRefetch.schedule();
        else if (hint.type === "profiles.changed") profilesRefetch.schedule();
        else if (hintNeedsTaskList(hint, streamed())) tasksRefetch.schedule();
      },
      {
        onResync: () => {
          botsRefetch.schedule();
          profilesRefetch.schedule();
          tasksRefetch.schedule();
        },
      },
    );
    return () => {
      botsRefetch.cancel();
      profilesRefetch.cancel();
      tasksRefetch.cancel();
      unsubscribe();
    };
  }, [api, applyTaskList]);

  // The open bot's conversation only. Messages a send stored stay merged in
  // until a fetched view includes them, and task cards the replies link to are
  // filled in from the task itself instead of waiting for the list refetch.
  const storedRef = useRef<Record<string, ConversationMessage[]>>({});
  const seedingRef = useRef(new Set<string>());
  useEffect(() => {
    if (!selectedBotId) return;
    const botId = selectedBotId;
    const seedTasks = (view: ConversationView) => {
      const known = new Set([
        ...tasksRef.current.map((task) => task.id),
        ...seedingRef.current,
      ]);
      for (const taskId of unknownTaskIds(view, known)) {
        seedingRef.current.add(taskId);
        api
          .getTask(taskId)
          .then((taskView) =>
            setTasks((current) =>
              current.some((task) => task.id === taskId)
                ? current
                : [summaryFromView(taskView), ...current],
            ),
          )
          .catch(() => {})
          .finally(() => seedingRef.current.delete(taskId));
      }
    };
    return api.subscribeConversation(botId, (fetched) => {
      const { view, unseen } = withUnseenMessages(
        fetched,
        storedRef.current[botId] ?? [],
      );
      storedRef.current[botId] = unseen;
      setConversations((current) => ({ ...current, [botId]: view }));
      seedTasks(view);
    });
  }, [api, selectedBotId]);

  // The open task: its snapshot, then its event stream. A new task starts
  // with no graph node picked. `taskReload` restarts it from a fresh snapshot.
  const followedTaskRef = useRef<string | null>(null);
  useEffect(() => {
    // A reload of the same task keeps the reader's graph selection.
    if (followedTaskRef.current !== selectedTaskId) setSelectedNodeId(null);
    followedTaskRef.current = selectedTaskId;
    setProblem(null);
    if (!selectedTaskId) return;
    void taskReload;
    setTaskStreamState(null);
    const unsubscribe = api.subscribeTask(
      selectedTaskId,
      (view) => {
        setStreamedViews((current) => ({ ...current, [view.task.id]: view }));
        setOverlays((current) => {
          const overlay = current[view.task.id];
          if (!overlay) return current;
          const pending = pruneOverlay(view, overlay);
          if (pending === overlay) return current;
          if (!pending) return without(current, view.task.id);
          return { ...current, [view.task.id]: pending };
        });
        setTasks((current) => upsert(current, summaryFromView(view)));
        setProblem((current) =>
          current?.taskId === view.task.id ? null : current,
        );
      },
      {
        onState: setTaskStreamState,
        onError: (failure) => setProblem(taskProblem(selectedTaskId, failure)),
      },
    );
    return () => {
      unsubscribe();
      // A reload keeps showing the current view until the fresh snapshot lands.
      if (selectedTaskRef.current === selectedTaskId) return;
      setStreamedViews((current) => without(current, selectedTaskId));
      setOverlays((current) => without(current, selectedTaskId));
    };
  }, [api, selectedTaskId, taskReload]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      try {
        setError(null);
        await action();
      } catch (reason) {
        report(reason);
      }
    },
    [report],
  );

  const selectTask = useCallback(
    (taskId: string) => navigate({ name: "tasks", taskId }),
    [],
  );
  const selectBot = useCallback(
    (botId: string) => navigate({ name: "bots", botId }),
    [],
  );

  const value = useMemo<WorkspaceValue>(
    () => ({
      loading,
      loadError,
      retryLoad: () => setLoadAttempt((count) => count + 1),
      error,
      dismissError: () => setError(null),
      bots,
      tasks,
      profiles,
      conversations,
      taskViews,
      taskStreamState,
      taskProblem: problem,
      retryTask: () => setTaskReload((count) => count + 1),
      memories,
      getBot: (botId) => bots.find((b) => b.id === botId),
      getTask: (taskId) => tasks.find((t) => t.id === taskId),
      selectedBotId,
      selectBot,
      selectedTaskId,
      selectTask,
      selectedNodeId,
      selectNode: setSelectedNodeId,
      jumpToTask: selectTask,
      jumpToBot: selectBot,
      createBot: async (command) => {
        const bot = await api.createBot(command);
        setBots((current) => [...current.filter((b) => b.id !== bot.id), bot]);
        selectBot(bot.id);
        return bot;
      },
      updateBot: async (botId, command) => {
        const bot = await api.updateBot(botId, command);
        setBots((current) => current.map((b) => (b.id === botId ? bot : b)));
        return bot;
      },
      archiveBot: async (botId) => {
        await api.archiveBot(botId);
        setBots((current) => current.filter((b) => b.id !== botId));
        setMemories((current) => without(current, botId));
      },
      refreshProfiles,
      refreshBots,
      loadMemory: async (botId) => {
        try {
          const memory = await api.getMemory(botId);
          setMemories((current) => ({ ...current, [botId]: memory }));
          setMemoryErrors((current) => without(current, botId));
        } catch (reason) {
          setMemoryErrors((current) => ({
            ...current,
            [botId]: message(reason),
          }));
        }
      },
      memoryErrors,
      saveMemory: async (botId, text) => {
        const memory = await api.putMemory(botId, { text });
        setMemories((current) => ({ ...current, [botId]: memory }));
        return memory;
      },
      sendBotMessage: async (botId, text) => {
        setError(null);
        setPendingBotTurns((current) => ({ ...current, [botId]: text }));
        try {
          const stored = await api.sendBotMessage(botId, { text });
          // Shown in the same render that drops the pending bubble, so it
          // never blinks out; the hint-driven refetch confirms it.
          storedRef.current[botId] = [
            ...(storedRef.current[botId] ?? []),
            stored,
          ];
          setConversations((current) => ({
            ...current,
            [botId]: withStoredMessage(current[botId], stored),
          }));
        } catch (reason) {
          report(reason);
          return false;
        } finally {
          setPendingBotTurns((current) => without(current, botId));
        }
        return true;
      },
      createTask: async ({ goal, participantBotIds }) => {
        const [coordinatorBotId] = participantBotIds;
        if (!coordinatorBotId)
          throw new Error("A task needs at least one bot.");
        const task = await api.createTask({
          goal,
          coordinatorBotId,
          participantBotIds,
        });
        setTasks((current) =>
          upsert(current, {
            ...task,
            activeSessionCount: 0,
            sessionCount: 0,
            usage: emptyUsage(),
          }),
        );
        selectTask(task.id);
        return task;
      },
      postTaskMessage: async (taskId, text, changesGoal) => {
        setPendingTaskSends((current) => ({
          ...current,
          [taskId]: { text, changesGoal },
        }));
        try {
          const observedGoalVersion =
            viewsRef.current[taskId]?.task.goalVersion ??
            tasksRef.current.find((t) => t.id === taskId)?.goalVersion;
          const message = await api.postTaskMessage(
            taskId,
            changesGoal ? { text, goal: text, observedGoalVersion } : { text },
          );
          // Show it now; the streamed `message.posted` replaces it by id.
          setOverlays((current) => ({
            ...current,
            [taskId]: overlayMessage(current[taskId], message),
          }));
          return { ok: true };
        } catch (reason) {
          return { ok: false, error: toApiError(reason) };
        } finally {
          setPendingTaskSends((current) => without(current, taskId));
        }
      },
      stopTask: async (taskId) => {
        try {
          const task = await api.stopTask(taskId);
          // "Stopping" shows at once, before `task.updated` streams in.
          setOverlays((current) => ({
            ...current,
            [taskId]: overlayTask(current[taskId], task),
          }));
          setTasks((current) =>
            current.map((t) => (t.id === task.id ? { ...t, ...task } : t)),
          );
          return { ok: true };
        } catch (reason) {
          return { ok: false, error: toApiError(reason) };
        }
      },
      pendingBotTurns,
      pendingTaskSends,
      advanceDemoTask: api.advanceDemoTask
        ? (taskId) =>
            run(async () => {
              await api.advanceDemoTask?.(taskId);
            })
        : undefined,
    }),
    [
      api,
      loading,
      error,
      bots,
      tasks,
      profiles,
      conversations,
      taskViews,
      taskStreamState,
      problem,
      memories,
      memoryErrors,
      loadError,
      selectedBotId,
      selectedTaskId,
      selectedNodeId,
      pendingBotTurns,
      pendingTaskSends,
      selectTask,
      selectBot,
      refreshProfiles,
      refreshBots,
      report,
      run,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value)
    throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return value;
}
