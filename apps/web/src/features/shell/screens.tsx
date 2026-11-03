import { type ComponentType, lazy, useState } from "react";
import type { Route } from "./router";

// Every screen but Bots, the one the app opens on, loads on demand, so the
// entry chunk carries none of their code: Tasks pulls in the graph and
// (lazily) Three.js, and Studio and Settings are visited now and then. Routes
// are parsed in the entry, so deep links and reloads land on the right screen,
// which shows a spinner naming it until its chunk arrives.

/** The routes whose screen is a chunk of its own. */
export type LazyRouteName = Exclude<Route["name"], "bots">;

interface LazyScreen<P extends object> {
  /** The screen; it suspends while its chunk loads. */
  Screen: ComponentType<P>;
  /** Starts loading the chunk on the first call; later calls share that load. */
  load: () => Promise<unknown>;
}

/**
 * A screen in a chunk of its own, with one import for its preload and its
 * render. A screen whose chunk is already in renders at once: `React.lazy`
 * suspends on its first render even then, which would flash the spinner for
 * as long as React holds a fallback on screen (about 300 ms).
 */
function lazyScreen<P extends object>(
  importScreen: () => Promise<ComponentType<P>>,
): LazyScreen<P> {
  let loading: Promise<ComponentType<P>> | undefined;
  let loaded: ComponentType<P> | undefined;
  const load = () => {
    loading ??= importScreen().then((component) => {
      loaded = component;
      return component;
    });
    return loading;
  };
  const Lazy = lazy(() => load().then((component) => ({ default: component })));
  function Screen(props: P) {
    // Chosen once per mount, so the screen never remounts when its chunk lands.
    const [Component] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return <Component {...props} />;
  }
  return { Screen, load };
}

const screens = {
  tasks: lazyScreen(() =>
    import("../tasks/TasksScreen").then((m) => m.TasksScreen),
  ),
  studio: lazyScreen(() =>
    import("../studio/StudioScreen").then((m) => m.StudioScreen),
  ),
  settings: lazyScreen(() =>
    import("../settings/SettingsScreen").then((m) => m.SettingsScreen),
  ),
};

export const TasksScreen = screens.tasks.Screen;
export const StudioScreen = screens.studio.Screen;
export const SettingsScreen = screens.settings.Screen;

/** The screen's name in its spinner while the chunk loads: "Loading Settings…". */
export const SCREEN_NAMES: Record<LazyRouteName, string> = {
  tasks: "Tasks",
  studio: "Bot Studio",
  settings: "Settings",
};

/**
 * Starts downloading the chunk of the screen `route` shows, if it has one.
 * Called at boot with the URL's route, so a deep link or reload fetches its
 * screen while the API is probed and the workspace loads, not after. A chunk
 * that fails to load fails only when the screen renders, in its boundary.
 */
export function preloadScreen(route: Route): void {
  if (route.name === "bots") return;
  screens[route.name].load().catch(() => {});
}
