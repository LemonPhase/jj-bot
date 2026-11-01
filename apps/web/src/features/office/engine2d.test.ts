import { describe, expect, it } from "vitest";
import { type Beat, beatHoldMs, delegationBeat, messageToBeat } from "./beats";
import { BEAT_GAP_MS, HOME_AFTER_MS, Office2DEngine } from "./engine2d";
import {
  BOARD_SPOT,
  huddleSpot,
  officeLayout2D,
  routeLength,
} from "./layout2d";
import { at, bots, message } from "./testFixtures";

const ids = ["bot-juno", "bot-moss", "bot-vesper"];
const layout = officeLayout2D(ids.length);
const home = (i: number) => layout.desks[i]!.home;
const task = { coordinatorBotId: "bot-juno", participantBotIds: ids };

const delegation = delegationBeat(
  { id: "s2", botId: "bot-moss", brief: "Run the checks" },
  "bot-juno",
  at(1),
);
const result: Beat = messageToBeat(
  message({
    id: "r",
    authorBotId: "bot-vesper",
    intent: "result",
    text: "Done",
  }),
  task,
  bots,
);
const userBeat: Beat = messageToBeat(
  message({ id: "u", authorKind: "user", authorBotId: null, text: "Hi" }),
  task,
  bots,
);

/** Runs the engine at a fixed frame interval for `ms`. */
function run(engine: Office2DEngine, ms: number, frame = 16) {
  for (let t = 0; t < ms; t += frame) engine.advance(Math.min(frame, ms - t));
}

describe("Office2DEngine", () => {
  it("walks the delegating bot to the recipient's desk, then shows the speech", () => {
    const engine = new Office2DEngine(layout, ids);
    engine.replay([delegation]);
    let frame = engine.frame();
    expect(frame.step).toBe(1);
    expect(frame.total).toBe(1);
    expect(frame.holding).toBe(false);
    expect(frame.actors.find((a) => a.id === "bot-juno")?.walking).toBe(true);

    // Juno walks from (63,29) to beside Moss at (80,29): 7 + 17 + 7 units at 25 u/s.
    run(engine, 1300);
    frame = engine.frame();
    expect(engine.positionOf("bot-juno")).toEqual({ x: 80, y: 29 });
    expect(frame.holding).toBe(true);
    expect(frame.beat?.id).toBe("delegation:s2");
    expect(frame.flash).toBe(false);
    // Moss, the recipient, stays at its desk.
    expect(engine.positionOf("bot-moss")).toEqual(home(1));
  });

  it("keeps real-time pace at any frame rate", () => {
    const beats = [userBeat, delegation, result];
    const fast = new Office2DEngine(layout, ids);
    const slow = new Office2DEngine(layout, ids);
    const once = new Office2DEngine(layout, ids);
    for (const e of [fast, slow, once]) e.replay(beats);
    run(fast, 7000, 16);
    run(slow, 7000, 250);
    once.advance(7000);
    for (const e of [slow, once]) {
      expect(e.status()).toEqual(fast.status());
      for (const id of ids) {
        const a = e.positionOf(id);
        const b = fast.positionOf(id);
        expect(a?.x).toBeCloseTo(b?.x ?? Number.NaN, 6);
        expect(a?.y).toBeCloseTo(b?.y ?? Number.NaN, 6);
      }
    }
  });

  it("plays the whole transcript, then sends everyone home", () => {
    const engine = new Office2DEngine(layout, ids);
    const beats = [delegation, result];
    engine.replay(beats);
    const walk = (2 * routeLength(home(0), [{ x: 80, y: 29 }])) / 25;
    const total =
      beats.reduce((sum, b) => sum + beatHoldMs(b) + BEAT_GAP_MS, 0) +
      walk * 1000 * 4 +
      HOME_AFTER_MS +
      10_000;
    engine.advance(total);
    expect(engine.status()).toMatchObject({
      step: 2,
      total: 2,
      currentId: null,
      replaying: false,
      pending: 0,
    });
    ids.forEach((id, i) => expect(engine.positionOf(id)).toEqual(home(i)));
  });

  it("posts a result at the board with the board flashing", () => {
    const engine = new Office2DEngine(layout, ids);
    engine.replay([result]);
    // (123,29) → (123,36) → (21,36) → (21,17): 128 units, about 5.1 s at 1×.
    engine.advance(6000);
    expect(engine.positionOf("bot-vesper")).toEqual(BOARD_SPOT);
    expect(engine.frame()).toMatchObject({ holding: true, flash: true });
  });

  it("gathers a huddle at the table and pings recipients of user messages", () => {
    const huddle = messageToBeat(
      message({ id: "h", intent: "assignment", text: "Go team" }),
      task,
      bots,
    );
    const engine = new Office2DEngine(layout, ids);
    engine.replay([huddle]);
    engine.advance(5000);
    expect(engine.positionOf("bot-juno")).toEqual(huddleSpot(0));
    expect(engine.positionOf("bot-moss")).toEqual(huddleSpot(1));
    expect(engine.positionOf("bot-vesper")).toEqual(huddleSpot(2));

    const user = new Office2DEngine(layout, ids);
    user.replay([userBeat]);
    user.advance(10);
    expect(user.frame()).toMatchObject({ holding: true, pings: ["bot-juno"] });
  });

  it("jumps straight to the spot with reduced motion", () => {
    const engine = new Office2DEngine(layout, ids, { reducedMotion: true });
    engine.replay([delegation]);
    expect(engine.positionOf("bot-juno")).toEqual({ x: 80, y: 29 });
    expect(engine.frame().holding).toBe(true);
  });

  it("stands still while paused and plays faster at higher speed", () => {
    const engine = new Office2DEngine(layout, ids);
    engine.replay([delegation]);
    engine.setPaused(true);
    engine.advance(5000);
    expect(engine.positionOf("bot-juno")).toEqual(home(0));
    engine.setPaused(false);
    engine.setSpeed(3);
    engine.advance(450);
    expect(engine.positionOf("bot-juno")).toEqual({ x: 80, y: 29 });
  });

  it("queues live beats after the current one and counts them", () => {
    const engine = new Office2DEngine(layout, ids);
    engine.replay([delegation]);
    engine.enqueue([result]);
    expect(engine.status()).toMatchObject({ step: 1, total: 2, pending: 2 });
  });

  it("seats new bots at their desks and drops removed ones", () => {
    const engine = new Office2DEngine(layout, ids);
    const bigger = officeLayout2D(4);
    engine.setBots(bigger, [...ids, "bot-kite"]);
    expect(engine.positionOf("bot-kite")).toEqual(bigger.desks[3]!.home);
    engine.setBots(bigger, ids.slice(0, 2));
    expect(engine.positionOf("bot-vesper")).toBeUndefined();
  });
});
