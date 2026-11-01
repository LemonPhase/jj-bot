/**
 * Client-side routes, kept in the URL hash so every screen is linkable and
 * survives a reload without server rewrites:
 *
 *   #/bots            the Bots screen; the shell fills in the first bot
 *   #/bots/:botId     a bot's direct chat
 *   #/tasks           the Tasks screen; the shell fills in the first task
 *   #/tasks/:taskId   a task
 *   #/studio          Bot Studio for a new bot (also #/studio/new)
 *   #/studio/:botId   Bot Studio editing a bot
 *   #/settings        Settings
 *
 * Anything else reads as `#/bots`. Ids are URI-encoded. This module is pure;
 * `useRoute()` and `navigate()` in ./useRoute.ts bind it to the window.
 */

export type Route =
  | { name: "bots"; botId: string | null }
  | { name: "tasks"; taskId: string | null }
  | { name: "studio"; botId: string | null }
  | { name: "settings" };

/** The two lists the sidebar switches between. */
export type Section = "bots" | "tasks";

/** `#/studio/new` opens Studio on a new bot, so no bot can be edited as "new". */
const NEW_BOT = "new";

const decode = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment) || null;
  } catch {
    return null;
  }
};

/** Reads a route from `location.hash` ("#/bots/abc"); a missing or unknown hash is `#/bots`. */
export function parseRoute(hash: string): Route {
  const [head, rawId] = hash
    .replace(/^#/, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  const id = rawId === undefined ? null : decode(rawId);
  switch (head) {
    case "tasks":
      return { name: "tasks", taskId: id };
    case "studio":
      return { name: "studio", botId: id === NEW_BOT ? null : id };
    case "settings":
      return { name: "settings" };
    default:
      return { name: "bots", botId: head === "bots" ? id : null };
  }
}

const withId = (base: string, id: string | null) =>
  id === null ? base : `${base}/${encodeURIComponent(id)}`;

/** The `href` of a route, for links and `location.hash`: "#/tasks/task-1". */
export function routeHref(route: Route): string {
  switch (route.name) {
    case "bots":
      return withId("#/bots", route.botId);
    case "tasks":
      return withId("#/tasks", route.taskId);
    case "studio":
      return withId("#/studio", route.botId ?? NEW_BOT);
    case "settings":
      return "#/settings";
  }
}

/** Shorthands for links: `href={botHref(bot.id)}`. */
export const botHref = (botId: string | null) =>
  routeHref({ name: "bots", botId });
export const taskHref = (taskId: string | null) =>
  routeHref({ name: "tasks", taskId });
export const studioHref = (botId: string | null) =>
  routeHref({ name: "studio", botId });
export const SETTINGS_HREF = routeHref({ name: "settings" });

/** Which sidebar list a route shows. Studio lists bots; Settings keeps the last list. */
export function sectionOf(route: Route): Section | null {
  switch (route.name) {
    case "bots":
    case "studio":
      return "bots";
    case "tasks":
      return "tasks";
    case "settings":
      return null;
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  return routeHref(a) === routeHref(b);
}

/** Ids currently listed in the sidebar, in display order. */
export interface ListedIds {
  bots: readonly string[];
  tasks: readonly string[];
}

/**
 * The route to switch to in place (history replace) so the URL names what is
 * on screen: a list route without an id opens the first listed item. Returns
 * null when the route is already canonical, or when there is nothing to open
 * yet. An unknown id is kept, so the screen can say it was not found.
 */
export function canonicalRoute(route: Route, listed: ListedIds): Route | null {
  if (route.name === "bots" && route.botId === null && listed.bots[0])
    return { name: "bots", botId: listed.bots[0] };
  if (route.name === "tasks" && route.taskId === null && listed.tasks[0])
    return { name: "tasks", taskId: listed.tasks[0] };
  return null;
}
