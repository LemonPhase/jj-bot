import {
  type Bot,
  type BotMemory,
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
import type { StreamState } from "../api/client";
import { navigate, useRoute } from "../features/shell/useRoute";
import { summaryFromView } from "../lib/tasks";

/** A task-chat message that has been submitted but not yet acknowledged. */
export interface PendingTaskSend {
  text: string;
  /** The message also replaces the task goal. */
  changesGoal: boolean;
}

export interface NewTaskInput {
  goal: string;
  /** The first entry is the coordinator. */
  participantBotIds: string[];
}

interface WorkspaceValue {
  loading: boolean;
  error: string | null;
  dismissError: () => void;

  bots: Bot[];
  tasks: TaskSummary[];
  profiles: RuntimeProfile[];
  conversations: Record<string, ConversationView>;
  /** Full views of the tasks being followed (the open one). */
  taskViews: Record<string, TaskView>;
  /** Connection state of the open task's event stream. */
  taskStreamState: StreamState | null;
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
  saveMemory: (botId: string, text: string) => Promise<BotMemory>;
  /** Creates the task and opens it. */
  createTask: (input: NewTaskInput) => Promise<Task>;

  // Fire-and-forget actions report failures in `error`.
  loadMemory: (botId: string) => Promise<void>;
  /** Resolves false when the message was not accepted (the error is in `error`). */
  sendBotMessage: (botId: string, text: string) => Promise<boolean>;
  postTaskMessage: (
    taskId: string,
    text: string,
    changesGoal: boolean,
  ) => Promise<void>;
  stopTask: (taskId: string) => Promise<void>;
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
  const [error, setError] = useState<string | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [profiles, setProfiles] = useState<RuntimeProfile[]>([]);
  const [conversations, setConversations] = useState<
    Record<string, ConversationView>
  >({});
  const [taskViews, setTaskViews] = useState<Record<string, TaskView>>({});
  const [taskStreamState, setTaskStreamState] = useState<StreamState | null>(
    null,
  );
  const [memories, setMemories] = useState<Record<string, BotMemory>>({});
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

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const viewsRef = useRef(taskViews);
  viewsRef.current = taskViews;

  const report = useCallback(
    (reason: unknown) => setError(message(reason)),
    [],
  );

  const refreshBots = useCallback(
    async () => setBots(await api.listBots()),
    [api],
  );
  const refreshProfiles = useCallback(
    async () => setProfiles(await api.listProfiles()),
    [api],
  );
  const refreshTasks = useCallback(async () => {
    const summaries = await api.listTasks();
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
  }, [api]);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const boot = await api.bootstrap();
        if (cancelled) return;
        setBots(boot.bots);
        setTasks(boot.tasks);
        setProfiles(boot.profiles);
      } catch (reason) {
        if (!cancelled) report(reason);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, report]);

  // Workspace hints say what to refetch; the task list refetch is debounced.
  useEffect(() => {
    let taskTimer: ReturnType<typeof setTimeout> | undefined;
    const refetchTasks = () => {
      clearTimeout(taskTimer);
      taskTimer = setTimeout(() => void refreshTasks().catch(() => {}), 200);
    };
    const unsubscribe = api.subscribeHints(
      (hint) => {
        if (hint.type === "bots.changed") void refreshBots().catch(() => {});
        else if (hint.type === "tasks.changed") refetchTasks();
        else if (hint.type === "profiles.changed")
          void refreshProfiles().catch(() => {});
      },
      {
        onResync: () => {
          void refreshBots().catch(() => {});
          void refreshProfiles().catch(() => {});
          refetchTasks();
        },
      },
    );
    return () => {
      clearTimeout(taskTimer);
      unsubscribe();
    };
  }, [api, refreshBots, refreshProfiles, refreshTasks]);

  // Every bot's conversation, for the list previews and the open chat.
  const botIds = bots.map((bot) => bot.id).join("\n");
  useEffect(() => {
    if (!botIds) return;
    const unsubscribes = botIds
      .split("\n")
      .map((botId) =>
        api.subscribeConversation(botId, (view) =>
          setConversations((current) => ({ ...current, [botId]: view })),
        ),
      );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [api, botIds]);

  // The open task: its snapshot, then its event stream. A new task starts
  // with no graph node picked.
  useEffect(() => {
    setSelectedNodeId(null);
    if (!selectedTaskId) return;
    setTaskStreamState(null);
    const unsubscribe = api.subscribeTask(
      selectedTaskId,
      (view) => {
        setTaskViews((current) => ({ ...current, [view.task.id]: view }));
        setTasks((current) => upsert(current, summaryFromView(view)));
      },
      { onState: setTaskStreamState },
    );
    return () => {
      unsubscribe();
      setTaskViews((current) => without(current, selectedTaskId));
    };
  }, [api, selectedTaskId]);

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
      error,
      dismissError: () => setError(null),
      bots,
      tasks,
      profiles,
      conversations,
      taskViews,
      taskStreamState,
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
      loadMemory: (botId) =>
        run(async () => {
          const memory = await api.getMemory(botId);
          setMemories((current) => ({ ...current, [botId]: memory }));
        }),
      saveMemory: async (botId, text) => {
        const memory = await api.putMemory(botId, { text });
        setMemories((current) => ({ ...current, [botId]: memory }));
        return memory;
      },
      sendBotMessage: async (botId, text) => {
        setError(null);
        setPendingBotTurns((current) => ({ ...current, [botId]: text }));
        try {
          await api.sendBotMessage(botId, { text });
        } catch (reason) {
          report(reason);
          return false;
        } finally {
          setPendingBotTurns((current) => without(current, botId));
        }
        // The message is stored; a failed refetch only delays showing it.
        try {
          const view = await api.getConversation(botId);
          setConversations((current) => ({ ...current, [botId]: view }));
        } catch {}
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
      postTaskMessage: (taskId, text, changesGoal) =>
        run(async () => {
          setPendingTaskSends((current) => ({
            ...current,
            [taskId]: { text, changesGoal },
          }));
          try {
            const observedGoalVersion =
              viewsRef.current[taskId]?.task.goalVersion ??
              tasksRef.current.find((t) => t.id === taskId)?.goalVersion;
            await api.postTaskMessage(
              taskId,
              changesGoal
                ? { text, goal: text, observedGoalVersion }
                : { text },
            );
          } finally {
            setPendingTaskSends((current) => without(current, taskId));
          }
        }),
      stopTask: (taskId) =>
        run(async () => {
          const task = await api.stopTask(taskId);
          setTasks((current) =>
            current.map((t) => (t.id === task.id ? { ...t, ...task } : t)),
          );
        }),
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
      memories,
      selectedBotId,
      selectedTaskId,
      selectedNodeId,
      pendingBotTurns,
      pendingTaskSends,
      selectTask,
      selectBot,
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
