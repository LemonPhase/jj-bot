import { lazy } from "react";
import type { Route } from "./router";

// Every screen but Bots, the one the app opens on, loads on demand, so the
// entry chunk carries none of their code: Tasks pulls in the graph and
// (lazily) Three.js, and Studio and Settings are visited now and then. Routes
// are parsed in the entry, so deep links and reloads land on the right screen,
// which shows a spinner naming it until its chunk arrives.

/** The routes whose screen is a chunk of its own. */
export type LazyRouteName = Exclude<Route["name"], "bots">;

/** Starts `load` on the first call; every later call gets the same promise. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | undefined;
  return () => {
    loading ??= load();
    return loading;
  };
}

// One import per screen, shared by `preloadScreen` and `React.lazy`.
const load = {
  tasks: once(() => import("../tasks/TasksScreen")),
  studio: once(() => import("../studio/StudioScreen")),
  settings: once(() => import("../settings/SettingsScreen")),
} satisfies Record<LazyRouteName, () => Promise<unknown>>;

export const TasksScreen = lazy(() =>
  load.tasks().then((m) => ({ default: m.TasksScreen })),
);
export const StudioScreen = lazy(() =>
  load.studio().then((m) => ({ default: m.StudioScreen })),
);
export const SettingsScreen = lazy(() =>
  load.settings().then((m) => ({ default: m.SettingsScreen })),
);

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
  load[route.name]().catch(() => {});
}
