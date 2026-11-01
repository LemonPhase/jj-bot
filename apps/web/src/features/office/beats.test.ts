import type { TaskMessage } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import {
  BeatFeed,
  beatHoldMs,
  beatLabel,
  beatPhrase,
  bubbleWho,
  delegationBeat,
  deskOrder,
  mentionedBotIds,
  messageToBeat,
  nowLabel,
  sessionFor,
  taskBeats,
  workingBotIds,
} from "./beats";
import { at, bots, event, message, session, taskView } from "./testFixtures";

const task = {
  coordinatorBotId: "bot-juno",
  participantBotIds: ["bot-juno", "bot-moss", "bot-vesper"],
};
const msg = (over: Partial<TaskMessage>): TaskMessage =>
  message({ id: "m", ...over });
const nameOf = (id: string) => bots.find((b) => b.id === id)?.name ?? "?";

describe("office beats", () => {
  it("only resolves mentions of bots in the task", () => {
    expect(
      mentionedBotIds("@moss and @Kite, @nobody", bots.slice(0, 3)),
    ).toEqual(["bot-moss"]);
  });

  it("routes user messages to mentions, else the coordinator", () => {
    expect(
      messageToBeat(msg({ authorKind: "user", authorBotId: null }), task, bots),
    ).toMatchObject({ from: "user", to: ["bot-juno"], mode: "user" });
    expect(
      messageToBeat(
        msg({ authorKind: "user", authorBotId: null, text: "@Vesper check" }),
        task,
        bots,
      ),
    ).toMatchObject({ to: ["bot-vesper"] });
  });

  it("turns coordinator assignments into a huddle with the team", () => {
    expect(
      messageToBeat(msg({ intent: "assignment", text: "Go team" }), task, bots),
    ).toMatchObject({ mode: "huddle", to: ["bot-moss", "bot-vesper"] });
  });

  it("sends one-to-one discussion as a desk visit and ignores self-mentions", () => {
    expect(
      messageToBeat(
        msg({ authorBotId: "bot-moss", text: "@Moss @Juno done" }),
        task,
        bots,
      ),
    ).toMatchObject({ mode: "visit", from: "bot-moss", to: ["bot-juno"] });
  });

  it("posts results at the board, coordinator results to the user", () => {
    expect(
      messageToBeat(
        msg({ authorBotId: "bot-vesper", intent: "result" }),
        task,
        bots,
      ).mode,
    ).toBe("board");
    expect(messageToBeat(msg({ intent: "result" }), task, bots).mode).toBe(
      "terminal",
    );
  });

  it("prefers the message's recipients over its @mentions", () => {
    expect(
      messageToBeat(
        msg({
          intent: "assignment",
          text: "@Vesper take a look",
          recipientBotIds: ["bot-moss"],
        }),
        task,
        bots,
      ),
    ).toMatchObject({ mode: "huddle", to: ["bot-moss"] });
  });

  it("announces system notifications", () => {
    expect(
      messageToBeat(
        msg({
          authorKind: "system",
          authorBotId: null,
          intent: "notification",
        }),
        task,
        bots,
      ),
    ).toMatchObject({ from: "system", mode: "announce", to: [] });
  });

  it("stamps a message beat with the event time, else the message time", () => {
    const m = msg({ createdAt: at(1) });
    expect(messageToBeat(m, task, bots).occurredAt).toBe(at(1));
    expect(messageToBeat(m, task, bots, at(2)).occurredAt).toBe(at(2));
  });
});

describe("taskBeats: beats come from task events", () => {
  const coordinator = session({
    id: "s1",
    botId: "bot-juno",
    createdAt: at(0),
  });
  const worker = session({
    id: "s2",
    botId: "bot-moss",
    parentSessionId: "s1",
    role: "worker",
    brief: "Run the checks",
    createdAt: at(1),
  });

  it("uses message.posted events and their occurredAt", () => {
    const m = msg({
      id: "m1",
      authorKind: "user",
      authorBotId: null,
      createdAt: at(1),
    });
    const view = taskView({
      messages: [m],
      events: [event(1, "message.posted", { message: m }, at(5))],
    });
    const beats = taskBeats(view, bots);
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({
      id: "m1",
      kind: "message",
      occurredAt: at(5),
    });
  });

  it("turns a child session.created into a delegation visit with the brief", () => {
    const view = taskView({
      sessions: [coordinator, worker],
      events: [
        event(1, "session.created", { session: coordinator }, at(0)),
        event(2, "session.created", { session: worker }, at(1)),
      ],
    });
    expect(taskBeats(view, bots)).toEqual([
      {
        id: "delegation:s2",
        kind: "delegation",
        from: "bot-juno",
        to: ["bot-moss"],
        intent: "delegation",
        text: "Run the checks",
        mode: "visit",
        occurredAt: at(1),
      },
    ]);
  });

  it("plays a delegation once when the engine also posted the assignment", () => {
    const assignment = msg({
      id: "m2",
      intent: "assignment",
      text: "@Moss Run the checks",
      recipientBotIds: ["bot-moss"],
      createdAt: at(1),
    });
    const view = taskView({
      sessions: [coordinator, worker],
      messages: [assignment],
      events: [
        event(1, "session.created", { session: coordinator }, at(0)),
        event(2, "session.created", { session: worker }, at(1)),
        event(3, "message.posted", { message: assignment }, at(1)),
      ],
    });
    expect(taskBeats(view, bots).map((b) => b.id)).toEqual(["m2"]);
  });

  it("announces a goal change", () => {
    const view = taskView({
      events: [
        event(4, "task.goal_changed", { goal: "New", goalVersion: 2 }, at(3)),
      ],
    });
    expect(taskBeats(view, bots)).toEqual([
      expect.objectContaining({
        kind: "goal",
        mode: "announce",
        text: "Goal updated to v2",
        occurredAt: at(3),
      }),
    ]);
  });

  it("still plays records older than the event window, first and in time order", () => {
    const old = msg({ id: "old", createdAt: at(0) });
    const fresh = msg({ id: "new", createdAt: at(9) });
    const view = taskView({
      sessions: [coordinator, worker],
      messages: [old, fresh],
      hasEarlier: true,
      events: [event(40, "message.posted", { message: fresh }, at(9))],
    });
    expect(taskBeats(view, bots).map((b) => b.id)).toEqual([
      "old",
      "delegation:s2",
      "new",
    ]);
  });

  it("ignores events that are not conversation (tools, runs, status changes)", () => {
    const view = taskView({
      sessions: [coordinator],
      events: [
        event(1, "session.created", { session: coordinator }, at(0)),
        event(2, "run.started", { reason: "start" }, at(0)),
        event(3, "model.started", {}, at(0)),
      ],
    });
    expect(taskBeats(view, bots)).toEqual([]);
  });
});

describe("labels and copy", () => {
  const visit = delegationBeat(
    { id: "s2", botId: "bot-moss", brief: "Check" },
    "bot-juno",
    at(1),
  );

  it("formats the step label as time · from → to · phrase", () => {
    const now = new Date(at(2));
    const label = beatLabel(visit, nameOf, now);
    expect(label).toMatch(
      /^\d{2}:\d{2}.* · Juno → Moss · delegates at Moss's desk$/,
    );
    const user = messageToBeat(
      msg({ authorKind: "user", authorBotId: null, intent: "steering" }),
      task,
      bots,
    );
    expect(beatLabel(user, nameOf, now)).toContain(
      "You → Juno · steering on the terminal",
    );
  });

  it("uses neutral, non-gendered phrases for every mode", () => {
    const modes = [
      "user",
      "announce",
      "huddle",
      "visit",
      "board",
      "terminal",
      "broadcast",
    ] as const;
    for (const mode of modes) {
      const phrase = beatPhrase({ ...visit, kind: "message", mode }, nameOf);
      expect(phrase).not.toMatch(/\b(he|she|his|her|him|hers)\b/i);
    }
    expect(beatPhrase({ ...visit, mode: "broadcast" }, nameOf)).toBe(
      "speaks where they stand",
    );
    expect(beatPhrase({ ...visit, mode: "board" }, nameOf)).toBe(
      "posts the result at the board",
    );
  });

  it("names the speaker and intent in the bubble", () => {
    expect(bubbleWho(visit, nameOf)).toBe("Juno · delegation");
    expect(bubbleWho({ ...visit, intent: "discussion" }, nameOf)).toBe("Juno");
    expect(
      bubbleWho({ ...visit, from: "user", intent: "steering" }, nameOf),
    ).toBe("You · steering");
  });

  it("only says someone is working when a session really runs", () => {
    expect(
      nowLabel({ status: "running", cancelRequestedAt: null }, ["Juno"]),
    ).toBe("Now · Juno is working…");
    expect(
      nowLabel({ status: "running", cancelRequestedAt: null }, [
        "Moss",
        "Vesper",
      ]),
    ).toBe("Now · Moss and Vesper are working…");
    expect(nowLabel({ status: "waiting", cancelRequestedAt: null }, [])).toBe(
      "Now · waiting for you",
    );
    expect(nowLabel({ status: "completed", cancelRequestedAt: null }, [])).toBe(
      "Now · task done",
    );
  });

  it("holds longer for longer text, within bounds", () => {
    expect(beatHoldMs({ mode: "visit", text: "" })).toBe(2200);
    expect(beatHoldMs({ mode: "visit", text: "x".repeat(1000) })).toBe(6500);
    expect(beatHoldMs({ mode: "announce", text: "x" })).toBe(3200);
  });
});

describe("helpers", () => {
  it("seats the coordinator first", () => {
    expect(
      deskOrder({ coordinatorBotId: "bot-vesper" }, bots.slice(0, 3)).map(
        (b) => b.id,
      ),
    ).toEqual(["bot-vesper", "bot-juno", "bot-moss"]);
  });

  it("picks a bot's latest active session and lists running bots", () => {
    const view = taskView({
      sessions: [
        session({
          id: "a",
          botId: "bot-moss",
          status: "completed",
          createdAt: at(0),
        }),
        session({
          id: "b",
          botId: "bot-moss",
          status: "running",
          createdAt: at(1),
        }),
        session({
          id: "c",
          botId: "bot-moss",
          status: "completed",
          createdAt: at(2),
        }),
        session({
          id: "d",
          botId: "bot-juno",
          status: "waiting",
          createdAt: at(3),
        }),
      ],
    });
    expect(sessionFor(view, "bot-moss")?.id).toBe("b");
    expect(workingBotIds(view)).toEqual(["bot-moss"]);
  });

  it("replays the latest beats once, then queues only new ones", () => {
    const feed = new BeatFeed(2);
    const beat = (id: string) => ({ ...visit(id) });
    function visit(id: string) {
      return delegationBeat(
        { id, botId: "bot-moss", brief: "b" },
        "bot-juno",
        at(0),
      );
    }
    const first = feed.next([beat("1"), beat("2"), beat("3")]);
    expect(first.kind).toBe("replay");
    expect(first.beats.map((b) => b.id)).toEqual([
      "delegation:2",
      "delegation:3",
    ]);
    const second = feed.next([beat("1"), beat("2"), beat("3"), beat("4")]);
    expect(second).toEqual({ kind: "enqueue", beats: [beat("4")] });
    expect(feed.next([beat("4")]).beats).toEqual([]);
  });
});
