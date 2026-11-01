import { describe, expect, it } from "vitest";
import {
  canonicalRoute,
  parseRoute,
  type Route,
  routeHref,
  sameRoute,
  sectionOf,
} from "./router";

describe("parseRoute", () => {
  it("reads every route", () => {
    expect(parseRoute("#/bots/bot-1")).toEqual({
      name: "bots",
      botId: "bot-1",
    });
    expect(parseRoute("#/bots")).toEqual({ name: "bots", botId: null });
    expect(parseRoute("#/tasks/task-7")).toEqual({
      name: "tasks",
      taskId: "task-7",
    });
    expect(parseRoute("#/tasks/")).toEqual({ name: "tasks", taskId: null });
    expect(parseRoute("#/studio/bot-2")).toEqual({
      name: "studio",
      botId: "bot-2",
    });
    expect(parseRoute("#/settings")).toEqual({ name: "settings" });
  });

  it("opens Studio on a new bot without an id or with `new`", () => {
    expect(parseRoute("#/studio")).toEqual({ name: "studio", botId: null });
    expect(parseRoute("#/studio/new")).toEqual({ name: "studio", botId: null });
  });

  it("reads a missing or unknown hash as the Bots screen", () => {
    for (const hash of ["", "#", "#/", "#/nowhere/x", "bots"])
      expect(parseRoute(hash).name).toBe("bots");
    expect(parseRoute("#/nowhere/x")).toEqual({ name: "bots", botId: null });
  });

  it("tolerates a missing slash and extra segments", () => {
    expect(parseRoute("#bots/bot-1/extra")).toEqual({
      name: "bots",
      botId: "bot-1",
    });
  });

  it("decodes ids and ignores malformed escapes", () => {
    expect(parseRoute("#/tasks/a%2Fb%20c")).toEqual({
      name: "tasks",
      taskId: "a/b c",
    });
    expect(parseRoute("#/tasks/%E0%A4%A")).toEqual({
      name: "tasks",
      taskId: null,
    });
  });
});

describe("routeHref", () => {
  const routes: Route[] = [
    { name: "bots", botId: null },
    { name: "bots", botId: "bot-1" },
    { name: "tasks", taskId: null },
    { name: "tasks", taskId: "a/b c?#" },
    { name: "studio", botId: null },
    { name: "studio", botId: "bot-9" },
    { name: "settings" },
  ];

  it("round-trips through parseRoute", () => {
    for (const route of routes)
      expect(parseRoute(routeHref(route))).toEqual(route);
  });

  it("writes canonical hashes", () => {
    expect(routeHref({ name: "bots", botId: "bot-1" })).toBe("#/bots/bot-1");
    expect(routeHref({ name: "tasks", taskId: "a/b" })).toBe("#/tasks/a%2Fb");
    expect(routeHref({ name: "studio", botId: null })).toBe("#/studio/new");
    expect(routeHref({ name: "settings" })).toBe("#/settings");
  });

  it("compares routes by their href", () => {
    expect(sameRoute(parseRoute("#bots/x"), { name: "bots", botId: "x" })).toBe(
      true,
    );
    expect(sameRoute({ name: "settings" }, { name: "bots", botId: null })).toBe(
      false,
    );
  });
});

describe("sectionOf", () => {
  it("shows the bot list on Bots and Studio, tasks on Tasks, and keeps the last on Settings", () => {
    expect(sectionOf({ name: "bots", botId: null })).toBe("bots");
    expect(sectionOf({ name: "studio", botId: null })).toBe("bots");
    expect(sectionOf({ name: "tasks", taskId: "t" })).toBe("tasks");
    expect(sectionOf({ name: "settings" })).toBeNull();
  });
});

describe("canonicalRoute", () => {
  const listed = { bots: ["bot-1", "bot-2"], tasks: ["task-9"] };

  it("opens the first listed item when the route names none", () => {
    expect(canonicalRoute({ name: "bots", botId: null }, listed)).toEqual({
      name: "bots",
      botId: "bot-1",
    });
    expect(canonicalRoute({ name: "tasks", taskId: null }, listed)).toEqual({
      name: "tasks",
      taskId: "task-9",
    });
  });

  it("leaves canonical, unknown-id and non-list routes alone", () => {
    expect(canonicalRoute({ name: "bots", botId: "bot-2" }, listed)).toBeNull();
    expect(
      canonicalRoute({ name: "bots", botId: "archived" }, listed),
    ).toBeNull();
    expect(canonicalRoute({ name: "studio", botId: null }, listed)).toBeNull();
    expect(canonicalRoute({ name: "settings" }, listed)).toBeNull();
  });

  it("waits while a list is empty", () => {
    expect(
      canonicalRoute(
        { name: "tasks", taskId: null },
        { bots: listed.bots, tasks: [] },
      ),
    ).toBeNull();
  });
});
