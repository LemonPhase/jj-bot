import { describe, expect, it } from "vitest";
import type { TaskMessageView } from "../../../api/types";
import { mentionedBotIds, messageToBeat } from "./beats";

const bots = [
  { id: "bot-juno", name: "Juno" },
  { id: "bot-moss", name: "Moss" },
  { id: "bot-vesper", name: "Vesper" },
  { id: "bot-kite", name: "Kite" },
];
const task = {
  coordinatorBotId: "bot-juno",
  participantBotIds: ["bot-juno", "bot-moss", "bot-vesper"],
};
const msg = (over: Partial<TaskMessageView>): TaskMessageView => ({
  id: "m",
  authorId: "bot-juno",
  authorKind: "bot",
  intent: "discussion",
  text: "hello",
  createdAt: "2026-10-31T15:00:00.000Z",
  ...over,
});

describe("office beats", () => {
  it("only resolves mentions of bots in the task", () => {
    expect(
      mentionedBotIds("@moss and @Kite, @nobody", bots.slice(0, 3)),
    ).toEqual(["bot-moss"]);
  });

  it("routes user messages to mentions, else the coordinator", () => {
    expect(
      messageToBeat(msg({ authorKind: "user", authorId: "user" }), task, bots),
    ).toMatchObject({ from: "user", to: ["bot-juno"], mode: "user" });
    expect(
      messageToBeat(
        msg({ authorKind: "user", authorId: "user", text: "@Vesper check" }),
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
        msg({ authorId: "bot-moss", text: "@Moss @Juno done" }),
        task,
        bots,
      ),
    ).toMatchObject({ mode: "visit", from: "bot-moss", to: ["bot-juno"] });
  });

  it("posts results at the board, coordinator results to the user", () => {
    expect(
      messageToBeat(
        msg({ authorId: "bot-vesper", intent: "result" }),
        task,
        bots,
      ).mode,
    ).toBe("board");
    expect(messageToBeat(msg({ intent: "result" }), task, bots).mode).toBe(
      "terminal",
    );
  });

  it("announces system notifications", () => {
    expect(
      messageToBeat(
        msg({ authorKind: "system", authorId: "sys", intent: "notification" }),
        task,
        bots,
      ),
    ).toMatchObject({ from: "system", mode: "announce", to: [] });
  });
});
