import {
  BOT_FACES,
  BOT_SHAPES,
  BOT_TOPPERS,
  type BotAppearance,
} from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { BODY_TONES, colourRamp } from "../../lib/colour";
import {
  blinkScale,
  blockCharacter,
  boxToWorld,
  facePlate,
  GAIT_PERIOD,
  gaitPose,
  idleLift,
  PLATE_HEIGHT,
  PLATE_WIDTH,
  PX,
  talkPose,
  topperParts,
} from "./character3d";

const juno: BotAppearance = {
  shape: "squircle",
  face: "visor",
  topper: "antenna",
  colour: "coral",
  body: "ivory",
  gait: "hop",
};
const deg = (d: number) => (d * Math.PI) / 180;

describe("blockCharacter: appearance → block character", () => {
  it("builds Juno from the design's boxes and colours", () => {
    const c = blockCharacter(juno);
    const coral = colourRamp("coral");
    expect(c.body).toEqual({
      box: { x0: -12, y0: -9, w: 24, d: 18, z0: 0, h: 20 },
      faces: BODY_TONES.ivory,
    });
    expect(c.belt.faces).toEqual({ t: coral.f, f: coral.f, s: coral.f });
    expect(c.belt.box).toMatchObject({ z0: 7, h: 4 });
    expect(c.arms.map((a) => a.box.x0)).toEqual([-17, 12]);
    expect(c.arms[0].faces).toEqual({ t: coral.t, f: coral.f, s: coral.s });
    expect(c.shoulders).toEqual([
      [-14.5, 0, 17],
      [14.5, 0, 17],
    ]);
    expect(c.neck.faces).toEqual({ t: "#9A9AA4", f: "#8A8A94", s: "#76767F" });
    expect(c.head).toMatchObject({ front: 12, fz: 28, top: 47 });
    expect(c.head.boxes).toEqual([
      {
        box: { x0: -16, y0: -12, w: 32, d: 24, z0: 23, h: 24 },
        faces: { t: coral.t, f: coral.f, s: coral.s },
      },
    ]);
    expect(c.face.plate).toEqual({
      x: 1,
      y: 2,
      w: 22,
      h: 8,
      r: 2,
      colour: coral.v,
    });
    expect(c.topper.kind).toBe("antenna");
    expect(c.gait).toBe("hop");
    expect(c.height).toBe(47 + 14);
  });

  it("gives every shape its head stack, face height and topper height", () => {
    const expected = {
      squircle: [1, 12, 28, 47],
      round: [3, 14, 29, 49],
      block: [1, 13, 29, 49],
      gem: [5, 15, 33, 57],
      dome: [3, 13, 23.5, 50],
    } as const;
    for (const shape of BOT_SHAPES) {
      const { head } = blockCharacter({ ...juno, shape });
      const [boxes, front, fz, top] = expected[shape];
      expect([head.boxes.length, head.front, head.fz, head.top]).toEqual([
        boxes,
        front,
        fz,
        top,
      ]);
      // The stack starts on the neck and its front face is where the plate sits.
      const lowest = Math.min(...head.boxes.map((b) => b.box.z0));
      expect(lowest).toBe(23);
      const deepest = Math.max(...head.boxes.map((b) => b.box.y0 + b.box.d));
      expect(deepest).toBe(front);
    }
    // The gem's bottom tip is all side colour.
    const gem = blockCharacter({ ...juno, shape: "gem", colour: "violet" });
    const s = colourRamp("violet").s;
    expect(gem.head.boxes[0]?.faces).toEqual({ t: s, f: s, s });
  });

  it("uses the graphite body tones for a graphite body", () => {
    expect(blockCharacter({ ...juno, body: "graphite" }).body.faces).toEqual({
      t: "#4B4B55",
      f: "#3B3B45",
      s: "#2D2D35",
    });
  });

  it("draws every face inside the 24×14 plate, the mono pupil over the white", () => {
    const ramp = colourRamp("teal");
    for (const face of BOT_FACES) {
      const plate = facePlate(face, ramp);
      for (const r of [
        plate.plate,
        ...plate.eyes,
        ...plate.eyeDetails,
        plate.mouth,
      ]) {
        if (!r) continue;
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(PLATE_WIDTH);
        expect(r.y + r.h).toBeLessThanOrEqual(PLATE_HEIGHT);
      }
    }
    const mono = facePlate("mono", ramp);
    expect(mono.eyes).toEqual([
      { x: 7, y: 1, w: 10, h: 10, colour: "#F4F7FB" },
    ]);
    expect(mono.eyeDetails).toEqual([
      { x: 10, y: 4, w: 4, h: 4, colour: "#0B0E14" },
    ]);
    expect(facePlate("screen", ramp).eyes[0]?.colour).toBe(ramp.l);
    expect(facePlate("visor", ramp).mouth).toBeNull();
  });

  it("gives every topper its parts and motion roles", () => {
    const ramp = colourRamp("blue");
    const roles = Object.fromEntries(
      BOT_TOPPERS.map((t) => [
        t,
        topperParts(t, ramp).parts.map((p) => p.role),
      ]),
    );
    expect(roles).toEqual({
      antenna: ["static", "tip"],
      dish: ["static", "dish"],
      sprout: ["static", "leaves", "leaves"],
      crest: ["static", "static"],
      propeller: ["static", "rotor", "rotor", "rotor"],
      halo: [],
      none: [],
    });
    expect(topperParts("halo", ramp).halo).toEqual({
      diameter: 24,
      tube: 3,
      z: 9,
      colour: "#F5C66B",
    });
    expect(topperParts("antenna", ramp).parts[1]).toMatchObject({
      faces: { t: ramp.l, f: ramp.l, s: ramp.t },
      glow: true,
    });
    expect(topperParts("sprout", ramp).leafPivot).toBe(7);
    expect(topperParts("none", ramp).height).toBe(0);
  });

  it("maps design boxes to Three units (x, z up, y front)", () => {
    expect(boxToWorld({ x0: -12, y0: -9, w: 24, d: 18, z0: 0, h: 20 })).toEqual(
      {
        size: [24 * PX, 20 * PX, 18 * PX],
        centre: [0, 10 * PX, 0],
      },
    );
  });
});

describe("motion", () => {
  it("hops twice per cycle, rolling one way then the other", () => {
    const period = GAIT_PERIOD.hop;
    expect(gaitPose("hop", 0).lift).toBeCloseTo(0);
    expect(gaitPose("hop", period / 4).lift).toBeCloseTo(5);
    expect(gaitPose("hop", period / 4).roll).toBeCloseTo(deg(6));
    expect(gaitPose("hop", (3 * period) / 4).roll).toBeCloseTo(-deg(6));
    expect(gaitPose("hop", 0).armL).toBeCloseTo(deg(34));
    expect(gaitPose("hop", period / 2).armL).toBeCloseTo(-deg(34));
  });

  it("glides above the floor leaning forward, arms fixed", () => {
    const low = gaitPose("glide", 0);
    const high = gaitPose("glide", GAIT_PERIOD.glide / 2);
    expect(low.lift).toBeCloseTo(5);
    expect(high.lift).toBeCloseTo(7);
    expect(low.pitch).toBeCloseTo(-deg(9));
    expect(high.armL).toBeCloseTo(-deg(38));
  });

  it("waddles with a wide sway", () => {
    expect(gaitPose("waddle", 0).roll).toBeCloseTo(-deg(13));
    expect(gaitPose("waddle", GAIT_PERIOD.waddle / 2).roll).toBeCloseTo(
      deg(13),
    );
  });

  it("floats when idle, nods and gestures when talking, blinks now and then", () => {
    expect(idleLift(0, 0)).toBeCloseTo(0);
    expect(idleLift(1.3, 0) * PX).toBeCloseTo(0.06);
    expect(talkPose(0.225).headPitch).toBeCloseTo(deg(7));
    expect(talkPose(0).armL).toBeCloseTo(-deg(10));
    expect(talkPose(0.275).armL).toBeCloseTo(-deg(38));
    expect([1, 2.2]).toContain(talkPose(0.1).mouth);
    expect(blinkScale(0, 0)).toBe(1);
    expect(blinkScale(4.6 * 0.97, 0)).toBe(0.15);
  });
});
