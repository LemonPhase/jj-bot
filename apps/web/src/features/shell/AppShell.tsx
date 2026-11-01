import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ErrorBanner, Spinner } from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotsScreen } from "../bots/BotsScreen";
import { SettingsScreen } from "../settings/SettingsScreen";
import { StudioScreen } from "../studio/StudioScreen";
import { NewTaskDialog } from "../tasks/NewTaskDialog";
import { canonicalRoute, type Route, type Section, sectionOf } from "./router";
import { type ShellActions, ShellContext } from "./ShellContext";
import { Sidebar } from "./Sidebar";
import { navigate, useRoute } from "./useRoute";
import "./shell.css";

// The Tasks screen pulls in the graph and (lazily) Three.js; load it on demand.
const TasksScreen = lazy(() =>
  import("../tasks/TasksScreen").then((m) => ({ default: m.TasksScreen })),
);

type OpenDialog = { kind: "none" } | { kind: "task"; botIds: string[] };

/**
 * The app frame (SPEC §2): no top bar; the sidebar, then the routed screen.
 * It owns the URL bookkeeping: a list route without an id opens the first
 * item, and each list remembers its last selection for the Bots/Tasks switch.
 */
export function AppShell() {
  const route = useRoute();
  const { loading, bots, tasks, error, dismissError, selectedBotId } =
    useWorkspace();
  const [dialog, setDialog] = useState<OpenDialog>({ kind: "none" });
  const lastSection = useRef<Section>("bots");
  const lastIds = useRef<Record<Section, string | null>>({
    bots: null,
    tasks: null,
  });

  const routeSection = sectionOf(route);
  const section = routeSection ?? lastSection.current;
  useEffect(() => {
    if (routeSection) lastSection.current = routeSection;
    if (route.name === "bots" && route.botId)
      lastIds.current.bots = route.botId;
    if (route.name === "tasks" && route.taskId)
      lastIds.current.tasks = route.taskId;
  }, [route, routeSection]);

  const botIds = bots.map((bot) => bot.id);
  const taskIds = tasks.map((task) => task.id);
  const listedKey = `${botIds.join("\n")}\t${taskIds.join("\n")}`;
  // `listedKey` stands for the two id lists, which are new arrays every render.
  useEffect(() => {
    if (loading) return;
    const next = canonicalRoute(route, { bots: botIds, tasks: taskIds });
    if (next) navigate(next, { replace: true });
  }, [loading, route, listedKey]);

  const switchSection = (next: Section) => {
    const remembered = lastIds.current[next];
    const ids = next === "bots" ? botIds : taskIds;
    const id = remembered && ids.includes(remembered) ? remembered : null;
    navigate(
      next === "bots"
        ? { name: "bots", botId: id }
        : { name: "tasks", taskId: id },
    );
  };

  const actions = useMemo<ShellActions>(
    () => ({
      openNewBot: () => navigate({ name: "studio", botId: null }),
      openNewTask: (botIds) =>
        setDialog({
          kind: "task",
          botIds: botIds?.length
            ? botIds
            : selectedBotId
              ? [selectedBotId]
              : [],
        }),
    }),
    [selectedBotId],
  );
  const closeDialog = () => setDialog({ kind: "none" });

  return (
    <ShellContext.Provider value={actions}>
      <div className="shell">
        <Sidebar
          route={route}
          section={section}
          onSwitchSection={switchSection}
        />
        <div className="shell-main">
          {error && (
            <div className="shell-alert">
              <ErrorBanner onDismiss={dismissError}>{error}</ErrorBanner>
            </div>
          )}
          {loading ? <ShellLoading /> : <Screen route={route} />}
        </div>
      </div>
      {dialog.kind === "task" && (
        <NewTaskDialog initialBotIds={dialog.botIds} onClose={closeDialog} />
      )}
    </ShellContext.Provider>
  );
}

function ShellLoading({ label = "Loading workspace…" }: { label?: string }) {
  return (
    <main className="screen screen--center">
      <Spinner label={label} showLabel />
    </main>
  );
}

/** The routed screen. Later screens plug in here. */
function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "bots":
      return <BotsScreen botId={route.botId} />;
    case "tasks":
      return (
        <Suspense fallback={<ShellLoading label="Loading…" />}>
          <TasksScreen />
        </Suspense>
      );
    case "studio":
      return <StudioScreen botId={route.botId} />;
    case "settings":
      return <SettingsScreen />;
  }
}
