import { lazyComponent } from "../../lib/lazyComponent";
import { preloadBotsScreen } from "../bots/BotsScreen";
import type { Route } from "./router";

// Every screen but Bots, the one the app opens on, loads on demand, so the
// entry chunk carries none of their code: Tasks pulls in the graph and
// (lazily) Three.js, and Studio and Settings are visited now and then. Routes
// are parsed in the entry, so deep links and reloads land on the right screen,
// which shows a spinner naming it until its chunk arrives.

/** The routes whose screen is a chunk of its own. */
export type LazyRouteName = Exclude<Route["name"], "bots">;

const screens = {
  tasks: lazyComponent("TasksScreen", () =>
    import("../tasks/TasksScreen").then((m) => m.TasksScreen),
  ),
  studio: lazyComponent("StudioScreen", () =>
    import("../studio/StudioScreen").then((m) => m.StudioScreen),
  ),
  settings: lazyComponent("SettingsScreen", () =>
    import("../settings/SettingsScreen").then((m) => m.SettingsScreen),
  ),
};

export const TasksScreen = screens.tasks.Component;
export const StudioScreen = screens.studio.Component;
export const SettingsScreen = screens.settings.Component;

/**
 * The sidebar's Tasks section (task list, templates, schedules), shown with
 * the Tasks list only: a chunk of its own, preloaded with the Tasks screen.
 */
const tasksSection = lazyComponent("TasksSection", () =>
  import("./TasksSection").then((m) => m.TasksSection),
);
export const TasksSection = tasksSection.Component;

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
 * that fails to load is fetched again when the screen renders, and a second
 * failure shows in its boundary. With the Tasks screen, the sidebar's Tasks
 * section; on the Bots screen, the bot's profile panel when it was left open.
 */
export function preloadScreen(route: Route): void {
  if (route.name === "bots") {
    preloadBotsScreen();
    return;
  }
  if (route.name === "tasks") tasksSection.load().catch(() => {});
  screens[route.name].load().catch(() => {});
}
