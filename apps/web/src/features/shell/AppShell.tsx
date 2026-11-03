import {
  Component,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, ErrorBanner, Spinner } from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotsScreen } from "../bots/BotsScreen";
import { NewTaskDialog } from "../tasks/NewTaskDialog";
import {
  canonicalRoute,
  parseRoute,
  type Route,
  routeHref,
  type Section,
  sectionOf,
} from "./router";
import { type ShellActions, ShellContext } from "./ShellContext";
import { Sidebar } from "./Sidebar";
import { navigate, useRoute } from "./useRoute";
import "./shell.css";

// Every screen but Bots, the one the app opens on, loads on demand, so the
// entry chunk carries none of their code: Tasks pulls in the graph and
// (lazily) Three.js, and Studio and Settings are visited now and then. Routes
// are parsed in the entry, so deep links and reloads land on the right screen,
// which shows a spinner until its chunk arrives.
const TasksScreen = lazy(() =>
  import("../tasks/TasksScreen").then((m) => ({ default: m.TasksScreen })),
);
const StudioScreen = lazy(() =>
  import("../studio/StudioScreen").then((m) => ({ default: m.StudioScreen })),
);
const SettingsScreen = lazy(() =>
  import("../settings/SettingsScreen").then((m) => ({
    default: m.SettingsScreen,
  })),
);

type OpenDialog = { kind: "none" } | { kind: "task"; botIds: string[] };

/**
 * The app frame (SPEC §2): no top bar; the sidebar, then the routed screen.
 * It owns the URL bookkeeping: a list route without an id opens the first
 * item, and each list remembers its last selection for the Bots/Tasks switch.
 */
export function AppShell() {
  const route = useRoute();
  const {
    loading,
    loadError,
    retryLoad,
    bots,
    tasks,
    error,
    dismissError,
    selectedBotId,
  } = useWorkspace();
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
  // One effect keeps the URL naming what is on screen, always with
  // history.replace: a list route without an id opens the first item (once
  // the lists are loaded), and any route is spelled canonically ("#bots",
  // "#/studio" and no hash at all are rewritten). Two effects would undo each
  // other within one commit. `listedKey` stands for the two id lists, which are
  // new arrays every render. A navigation can land between a commit and its
  // effects (a click as soon as the screen shows): then the URL names another
  // route than this render did, and rewriting it from this one would undo the
  // navigation. Its own render, on `hashchange`, fixes it up instead.
  useEffect(() => {
    if (routeHref(parseRoute(window.location.hash)) !== routeHref(route))
      return;
    const target =
      (loading
        ? null
        : canonicalRoute(route, { bots: botIds, tasks: taskIds })) ?? route;
    if (window.location.hash !== routeHref(target))
      navigate(target, { replace: true });
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
          {loading ? (
            <ShellLoading />
          ) : loadError ? (
            <ShellLoadFailed message={loadError} onRetry={retryLoad} />
          ) : (
            <Screen route={route} />
          )}
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

/** The bootstrap failed: say so, instead of showing an empty workspace. */
function ShellLoadFailed({
  message,
  onRetry,
  retryLabel = "Retry",
}: {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}) {
  return (
    <main className="screen screen--center">
      <div className="shell-failed">
        <ErrorBanner word="Couldn't load">{message}</ErrorBanner>
        <Button onClick={onRetry}>{retryLabel}</Button>
      </div>
    </main>
  );
}

/**
 * The app could not start: neither the backend nor the demo data is
 * available (`resolveApi` rejected). Says why, with a reload.
 */
export function StartFailed({ message }: { message: string }) {
  return (
    <div className="shell">
      <ShellLoadFailed
        message={message}
        onRetry={() => window.location.reload()}
        retryLabel="Reload"
      />
    </div>
  );
}

/**
 * A screen that fails to load or render says so, with a reload, instead of
 * unmounting the whole app. A lazy screen's chunk can fail to arrive: the
 * connection dropped, or a redeploy replaced it while the page was open. React
 * keeps a failed import's rejection, so only a reload fetches it again.
 * Mounted per screen (keyed by route name), so leaving the screen clears it.
 */
class ScreenBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <ShellLoadFailed
        message={`this screen: ${error.message}`}
        onRetry={() => window.location.reload()}
        retryLabel="Reload"
      />
    );
  }
}

/** The routed screen. Later screens plug in here. */
function Screen({ route }: { route: Route }) {
  if (route.name === "bots") return <BotsScreen botId={route.botId} />;
  return (
    <ScreenBoundary key={route.name}>
      <Suspense fallback={<ShellLoading label="Loading…" />}>
        <LazyScreen route={route} />
      </Suspense>
    </ScreenBoundary>
  );
}

function LazyScreen({ route }: { route: Exclude<Route, { name: "bots" }> }) {
  switch (route.name) {
    case "tasks":
      return <TasksScreen />;
    case "studio":
      return <StudioScreen botId={route.botId} />;
    case "settings":
      return <SettingsScreen />;
  }
}
