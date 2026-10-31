import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useApi } from "../api/ApiContext";
import type {
  BotPatch,
  BotProfile,
  DirectMessage,
  NewBotInput,
  NewTaskInput,
  TaskView,
} from "../api/types";

export type MainTab = "bots" | "tasks";

interface WorkspaceValue {
  loading: boolean;
  error: string | null;
  dismissError: () => void;

  bots: BotProfile[];
  tasks: TaskView[];
  conversations: Record<string, DirectMessage[]>;
  getBot: (botId: string) => BotProfile | undefined;
  getTask: (taskId: string) => TaskView | undefined;

  activeTab: MainTab;
  setActiveTab: (tab: MainTab) => void;
  selectedBotId: string | null;
  selectBot: (botId: string) => void;
  selectedTaskId: string | null;
  selectTask: (taskId: string) => void;
  selectedNodeId: string | null;
  selectNode: (nodeId: string) => void;
  jumpToTask: (taskId: string) => void;
  jumpToBot: (botId: string) => void;

  createBot: (input: NewBotInput) => Promise<void>;
  updateBot: (botId: string, patch: BotPatch) => Promise<void>;
  sendDirectMessage: (botId: string, text: string) => Promise<void>;
  createTask: (input: NewTaskInput) => Promise<void>;
  postTaskMessage: (
    taskId: string,
    text: string,
    steering: boolean,
  ) => Promise<void>;
  stopTask: (taskId: string) => Promise<void>;
  advanceDemoTask?: (taskId: string) => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : "Something went wrong";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bots, setBots] = useState<BotProfile[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [conversations, setConversations] = useState<
    Record<string, DirectMessage[]>
  >({});
  const [activeTab, setActiveTab] = useState<MainTab>("bots");
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const upsertTask = useCallback((task: TaskView) => {
    setTasks((current) =>
      current.some((t) => t.id === task.id)
        ? current.map((t) => (t.id === task.id ? task : t))
        : [task, ...current],
    );
  }, []);

  // Initial load. TODO(backend): add pagination once lists can grow.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loadedBots, loadedTasks] = await Promise.all([
          api.listBots(),
          api.listTasks(),
        ]);
        const threads = await Promise.all(
          loadedBots.map(
            async (bot) =>
              [bot.id, await api.listDirectMessages(bot.id)] as const,
          ),
        );
        if (cancelled) return;
        setBots(loadedBots);
        setTasks(loadedTasks);
        setConversations(Object.fromEntries(threads));
        setSelectedBotId((id) => id ?? loadedBots[0]?.id ?? null);
        setSelectedTaskId((id) => id ?? loadedTasks[0]?.id ?? null);
        setSelectedNodeId(
          (id) => id ?? loadedTasks[0]?.sessions[0]?.id ?? null,
        );
      } catch (reason) {
        if (!cancelled) setError(message(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Live updates for the open task.
  useEffect(() => {
    if (!selectedTaskId) return;
    return api.subscribeToTask(selectedTaskId, upsertTask);
  }, [api, selectedTaskId, upsertTask]);

  const run = useCallback(async (action: () => Promise<void>) => {
    try {
      setError(null);
      await action();
    } catch (reason) {
      setError(message(reason));
    }
  }, []);

  const selectTask = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      const task = tasks.find((t) => t.id === taskId);
      setSelectedNodeId(task?.sessions[0]?.id ?? "gate");
    },
    [tasks],
  );

  const value = useMemo<WorkspaceValue>(
    () => ({
      loading,
      error,
      dismissError: () => setError(null),
      bots,
      tasks,
      conversations,
      getBot: (botId) => bots.find((b) => b.id === botId),
      getTask: (taskId) => tasks.find((t) => t.id === taskId),
      activeTab,
      setActiveTab,
      selectedBotId,
      selectBot: setSelectedBotId,
      selectedTaskId,
      selectTask,
      selectedNodeId,
      selectNode: setSelectedNodeId,
      jumpToTask: (taskId) => {
        selectTask(taskId);
        setActiveTab("tasks");
      },
      jumpToBot: (botId) => {
        setSelectedBotId(botId);
        setActiveTab("bots");
      },
      createBot: (input) =>
        run(async () => {
          const bot = await api.createBot(input);
          setBots((current) => [...current, bot]);
          setConversations((current) => ({ ...current, [bot.id]: [] }));
          setSelectedBotId(bot.id);
          setActiveTab("bots");
        }),
      updateBot: (botId, patch) =>
        run(async () => {
          const bot = await api.updateBot(botId, patch);
          setBots((current) => current.map((b) => (b.id === botId ? bot : b)));
        }),
      sendDirectMessage: (botId, text) =>
        run(async () => {
          const thread = await api.sendDirectMessage(botId, text);
          setConversations((current) => ({ ...current, [botId]: thread }));
        }),
      createTask: (input) =>
        run(async () => {
          const task = await api.createTask(input);
          upsertTask(task);
          setSelectedTaskId(task.id);
          setSelectedNodeId(task.sessions[0]?.id ?? "gate");
          setActiveTab("tasks");
        }),
      postTaskMessage: (taskId, text, steering) =>
        run(async () => {
          upsertTask(await api.postTaskMessage(taskId, { text, steering }));
        }),
      stopTask: (taskId) =>
        run(async () => {
          upsertTask(await api.stopTask(taskId));
        }),
      advanceDemoTask: api.advanceDemoTask
        ? (taskId) =>
            run(async () => {
              const advance = api.advanceDemoTask;
              if (advance) upsertTask(await advance(taskId));
            })
        : undefined,
    }),
    [
      api,
      loading,
      error,
      bots,
      tasks,
      conversations,
      activeTab,
      selectedBotId,
      selectedTaskId,
      selectedNodeId,
      selectTask,
      run,
      upsertTask,
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
