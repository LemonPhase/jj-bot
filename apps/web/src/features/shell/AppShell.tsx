import {
  Component,
  type ReactNode,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, ErrorBanner, Spinner } from "../../components/ui";
import { NARROW_QUERY, useMediaQuery } from "../../lib/media";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotsScreen } from "../bots/BotsScreen";
import { NewTaskDialog } from "../tasks/NewTaskDialog";
import { NavDrawer, TopBar } from "./MobileNav";
import {
  canonicalRoute,
  parseRoute,
  type Route,
  routeHref,
  type Section,
  sectionOf,
} from "./router";
import { type ShellActions, ShellContext } from "./ShellContext";
import { Sidebar, useModeBadge } from "./Sidebar";
import {
  SCREEN_NAMES,
  SettingsScreen,
  StudioScreen,
  TasksScreen,
} from "./screens";
import { navigate, useRoute } from "./useRoute";
import "./shell.css";

type OpenDialog = { kind: "none" } | { kind: "task"; botIds: string[] };

/**
 * The app frame (SPEC §2): no top bar; the sidebar, then the routed screen.
 * Below 760px (`NARROW_QUERY`) a top bar takes the sidebar's place and the
 * sidebar opens from its menu button as a drawer. The shell owns the URL
 * bookkeeping: a list route without an id opens the first item, and each list
 * remembers its last selection for the Bots/Tasks switch.
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
  const narrow = useMediaQuery(NARROW_QUERY);
  const [navOpen, setNavOpen] = useState(false);
  const badge = useModeBadge();
  const menuId = useId();
  const drawerId = useId();
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

  // Growing past phone width puts the sidebar back in place, and the drawer
  // stays shut if the screen narrows again.
  if (!narrow && navOpen) setNavOpen(false);

  // The Bots/Tasks switch keeps the drawer open on the other list; a link or
  // a row in it (NavDrawer) and the New actions (below) close it.
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
      openNewBot: () => {
        setNavOpen(false);
        navigate({ name: "studio", botId: null });
      },
      openNewTask: (botIds) => {
        // From the drawer: the dialog takes its place, and gives focus back
        // to the menu button when it closes.
        setNavOpen(false);
        setDialog({
          kind: "task",
          botIds: botIds?.length
            ? botIds
            : selectedBotId
              ? [selectedBotId]
              : [],
        });
      },
    }),
    [selectedBotId],
  );
  const closeDialog = () => setDialog({ kind: "none" });

  return (
    <ShellContext.Provider value={actions}>
      <div className="shell">
        {narrow ? (
          <>
            <TopBar
              menuId={menuId}
              drawerId={drawerId}
              menuOpen={navOpen}
              onMenu={() => setNavOpen(true)}
              badge={badge}
            />
            <NavDrawer
              id={drawerId}
              open={navOpen}
              onClose={() => setNavOpen(false)}
              returnFocusTo={menuId}
            >
              <Sidebar
                route={route}
                section={section}
                onSwitchSection={switchSection}
                badge={badge}
                onClose={() => setNavOpen(false)}
              />
            </NavDrawer>
          </>
        ) : (
          <Sidebar
            route={route}
            section={section}
            onSwitchSection={switchSection}
            badge={badge}
          />
        )}
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
 * The app could not start (`resolveApi` rejected): the backend is unreachable,
 * asks for a token or cannot be used, or the demo data it was opened on did
 * not load. Says why, with a reload.
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
      <Suspense
        fallback={
          <ShellLoading label={`Loading ${SCREEN_NAMES[route.name]}…`} />
        }
      >
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
