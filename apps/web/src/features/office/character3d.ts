/**
 * The Office 3D block character (SPEC §10.2), as pure data: which boxes make
 * a bot with a given appearance, in which colours, and how it moves. The
 * Three.js scene turns this into meshes; tests check the mapping directly.
 *
 * Units are design px. The design frame is CSS: x right, y toward the front,
 * z up; Three maps it to (x, z, y), so the character's front faces +z. A box
 * `{x0, y0, w, d, z0, h}` spans x0..x0+w, y0..y0+d and z0..z0+h.
 */

import type {
  BotAppearance,
  BotFace,
  BotGait,
  BotShape,
  BotTopper,
} from "@jj/contracts";
import { BODY_TONES, type ColourRamp, colourRamp } from "../../lib/colour";

/** World units per design px: a 26px desk height is about 0.78 units. */
export const PX = 0.03;

export interface Box3 {
  x0: number;
  y0: number;
  w: number;
  d: number;
  z0: number;
  h: number;
}

/** Face colours: top, front, and sides (the back and bottom use the side colour). */
export interface Faces {
  t: string;
  f: string;
  s: string;
}

export interface Part {
  box: Box3;
  faces: Faces;
}

/** A rectangle on the 24×14 px face plate, origin top-left. */
export interface PlateRect {
  x: number;
  y: number;
  w: number;
  h: number;
  colour: string;
  /** Corner radius in plate px. */
  r?: number;
}

export interface FacePlate {
  /** The plate behind the features (visor, screen), if any. */
  plate: PlateRect | null;
  /** Blink with the eyes. */
  eyes: PlateRect[];
  /** Drawn on top of the eyes (highlights, pupil); blink with them. */
  eyeDetails: PlateRect[];
  /** Opens while talking. */
  mouth: PlateRect | null;
}

export const PLATE_WIDTH = 24;
export const PLATE_HEIGHT = 14;

/** How a topper part moves (SPEC §8 topper motion). */
export type TopperRole = "static" | "tip" | "dish" | "leaves" | "rotor";

export interface TopperPart extends Part {
  role: TopperRole;
  /** Brightens while talking (the design's emissive glow). */
  glow?: boolean;
}

export interface Halo {
  /** Ring diameter and tube thickness, px. */
  diameter: number;
  tube: number;
  /** Height above the topper origin, px; it floats up to `z + 4`. */
  z: number;
  colour: string;
}

export interface Topper {
  kind: BotTopper;
  parts: TopperPart[];
  halo: Halo | null;
  /** Pivot height of the sprout's leaves (they roll about it), px above the origin. */
  leafPivot: number;
  /** Highest point above the topper origin, px. */
  height: number;
}

export interface HeadShape {
  boxes: Part[];
  /** y of the head's front face, px. */
  front: number;
  /** z of the face plate's bottom edge, px. */
  fz: number;
  /** z of the topper origin, px. */
  top: number;
}

export interface BlockCharacter {
  body: Part;
  /** The coloured band around the body. */
  belt: Part;
  /** Left then right arm, each hanging from its shoulder pivot. */
  arms: readonly [Part, Part];
  /** Shoulder pivots (x, y, z px), left then right. */
  shoulders: readonly [[number, number, number], [number, number, number]];
  neck: Part;
  /** Head pivot height, px: the head stack, face and topper turn about it. */
  headPivotZ: number;
  head: HeadShape;
  face: FacePlate;
  topper: Topper;
  gait: BotGait;
  ramp: Readonly<ColourRamp>;
  /** The top of the character (topper included), px above the floor. */
  height: number;
}

const INK = "#0B0E14";
const WHITE = "#F4F7FB";
const GOLD = "#F5C66B";

const box = (
  x0: number,
  y0: number,
  w: number,
  d: number,
  z0: number,
  h: number,
): Box3 => ({ x0, y0, w, d, z0, h });

const all = (colour: string): Faces => ({ t: colour, f: colour, s: colour });

/** Head stacks per shape (SPEC §10.2 table). */
function headShape(shape: BotShape, c: Faces, side: string): HeadShape {
  const part = (b: Box3, faces: Faces = c): Part => ({ box: b, faces });
  switch (shape) {
    case "squircle":
      return {
        boxes: [part(box(-16, -12, 32, 24, 23, 24))],
        front: 12,
        fz: 28,
        top: 47,
      };
    case "round":
      return {
        boxes: [
          part(box(-12, -12, 24, 24, 23, 4)),
          part(box(-15, -14, 30, 28, 27, 18)),
          part(box(-12, -12, 24, 24, 45, 4)),
        ],
        front: 14,
        fz: 29,
        top: 49,
      };
    case "block":
      return {
        boxes: [part(box(-16, -13, 32, 26, 23, 26))],
        front: 13,
        fz: 29,
        top: 49,
      };
    case "gem":
      return {
        boxes: [
          part(box(-6, -6, 12, 12, 23, 4), all(side)),
          part(box(-11, -11, 22, 22, 27, 6)),
          part(box(-15, -15, 30, 30, 33, 14)),
          part(box(-11, -11, 22, 22, 47, 6)),
          part(box(-6, -6, 12, 12, 53, 4)),
        ],
        front: 15,
        fz: 33,
        top: 57,
      };
    case "dome":
      return {
        boxes: [
          part(box(-16, -13, 32, 26, 23, 14)),
          part(box(-13, -11, 26, 22, 37, 8)),
          part(box(-8, -7, 16, 14, 45, 5)),
        ],
        front: 13,
        fz: 23.5,
        top: 50,
      };
  }
}

/** Face plate contents per face (SPEC §10.2 table), in plate px. */
export function facePlate(
  face: BotFace,
  ramp: Readonly<ColourRamp>,
): FacePlate {
  switch (face) {
    case "dots":
      return {
        plate: null,
        eyes: [
          { x: 3, y: 2, w: 6, h: 6, colour: INK },
          { x: 15, y: 2, w: 6, h: 6, colour: INK },
        ],
        eyeDetails: [
          { x: 6, y: 2, w: 2, h: 2, colour: WHITE },
          { x: 18, y: 2, w: 2, h: 2, colour: WHITE },
        ],
        mouth: { x: 10, y: 10, w: 4, h: 2, colour: INK },
      };
    case "visor":
      return {
        plate: { x: 1, y: 2, w: 22, h: 8, r: 2, colour: ramp.v },
        eyes: [
          { x: 5, y: 5, w: 5, h: 2, colour: WHITE },
          { x: 14, y: 5, w: 5, h: 2, colour: WHITE },
        ],
        eyeDetails: [],
        mouth: null,
      };
    case "screen":
      return {
        plate: { x: 0, y: 0, w: 24, h: 14, r: 3, colour: "#141413" },
        eyes: [
          { x: 5, y: 3, w: 4, h: 5, colour: ramp.l },
          { x: 15, y: 3, w: 4, h: 5, colour: ramp.l },
        ],
        eyeDetails: [],
        mouth: { x: 9, y: 10, w: 6, h: 1.5, colour: ramp.l },
      };
    case "mono":
      // The pupil paints over the white (the design's Studio paint-order defect, SPEC §15).
      return {
        plate: null,
        eyes: [{ x: 7, y: 1, w: 10, h: 10, colour: WHITE }],
        eyeDetails: [{ x: 10, y: 4, w: 4, h: 4, colour: INK }],
        mouth: { x: 10, y: 12, w: 4, h: 2, colour: INK },
      };
  }
}

/** Topper parts per topper (SPEC §10.2), relative to the topper origin. */
export function topperParts(
  topper: BotTopper,
  ramp: Readonly<ColourRamp>,
): Topper {
  const lit: Faces = { t: ramp.l, f: ramp.l, s: ramp.t };
  const none = (kind: BotTopper): Topper => ({
    kind,
    parts: [],
    halo: null,
    leafPivot: 0,
    height: 0,
  });
  switch (topper) {
    case "antenna":
      return {
        ...none(topper),
        parts: [
          { box: box(-1, -1, 2, 2, 0, 9), faces: all(ramp.d), role: "static" },
          {
            box: box(-2.5, -2.5, 5, 5, 9, 5),
            faces: lit,
            role: "tip",
            glow: true,
          },
        ],
        height: 14,
      };
    case "dish":
      return {
        ...none(topper),
        parts: [
          { box: box(-1, -1, 2, 2, 0, 6), faces: all(ramp.d), role: "static" },
          {
            box: box(-7, -7, 14, 14, 6, 2),
            faces: lit,
            role: "dish",
            glow: true,
          },
        ],
        height: 8,
      };
    case "sprout": {
      const leaf: Faces = { t: "#D3FAE8", f: "#A7F3D0", s: "#86DDB7" };
      return {
        ...none(topper),
        parts: [
          {
            box: box(-1, -1, 2, 2, 0, 7),
            faces: { t: "#138A5E", f: "#138A5E", s: "#0F6F4B" },
            role: "static",
          },
          { box: box(-8, -2, 8, 4, 6, 3), faces: leaf, role: "leaves" },
          { box: box(0, -2, 8, 4, 8, 3), faces: leaf, role: "leaves" },
        ],
        leafPivot: 7,
        height: 11,
      };
    }
    case "crest":
      return {
        ...none(topper),
        parts: [
          {
            box: box(-4, -4, 8, 8, 0, 5),
            faces: lit,
            role: "static",
            glow: true,
          },
          {
            box: box(-2, -2, 4, 4, 5, 3),
            faces: lit,
            role: "static",
            glow: true,
          },
        ],
        height: 8,
      };
    case "propeller":
      return {
        ...none(topper),
        parts: [
          {
            box: box(-1, -1, 2, 2, 0, 6),
            faces: { t: "#B4B4BE", f: "#9A9AA4", s: "#80808A" },
            role: "static",
          },
          { box: box(-14, -1.5, 28, 3, 6, 1.5), faces: lit, role: "rotor" },
          { box: box(-1.5, -14, 3, 28, 6, 1.5), faces: lit, role: "rotor" },
          { box: box(-2, -2, 4, 4, 6, 3), faces: all(ramp.d), role: "rotor" },
        ],
        height: 9,
      };
    case "halo":
      return {
        ...none(topper),
        halo: { diameter: 24, tube: 3, z: 9, colour: GOLD },
        height: 13 + 3,
      };
    case "none":
      return none(topper);
  }
}

/** Everything the scene needs to build a bot with this appearance. */
export function blockCharacter(appearance: BotAppearance): BlockCharacter {
  const ramp = colourRamp(appearance.colour);
  const colour: Faces = { t: ramp.t, f: ramp.f, s: ramp.s };
  const body = BODY_TONES[appearance.body];
  const head = headShape(appearance.shape, colour, ramp.s);
  const topper = topperParts(appearance.topper, ramp);
  return {
    body: { box: box(-12, -9, 24, 18, 0, 20), faces: { ...body } },
    // Wraps all four sides, 4px tall, starting 9px below the body top (SPEC proposal).
    belt: { box: box(-12.25, -9.25, 24.5, 18.5, 7, 4), faces: all(ramp.f) },
    arms: [
      { box: box(-17, -3, 5, 6, 4, 13), faces: colour },
      { box: box(12, -3, 5, 6, 4, 13), faces: colour },
    ],
    shoulders: [
      [-14.5, 0, 17],
      [14.5, 0, 17],
    ],
    neck: {
      box: box(-3, -3, 6, 6, 20, 3),
      faces: { t: "#9A9AA4", f: "#8A8A94", s: "#76767F" },
    },
    headPivotZ: 23,
    head,
    face: facePlate(appearance.face, ramp),
    topper,
    gait: appearance.gait,
    ramp,
    height: head.top + topper.height,
  };
}

/** A design-px box as a Three box: size (w, h, d) and centre (x, y, z) in world units. */
export function boxToWorld(b: Box3): {
  size: [number, number, number];
  centre: [number, number, number];
} {
  return {
    size: [b.w * PX, b.h * PX, b.d * PX],
    centre: [
      (b.x0 + b.w / 2) * PX,
      (b.z0 + b.h / 2) * PX,
      (b.y0 + b.d / 2) * PX,
    ],
  };
}

/* ───────────── motion (SPEC §8), all pure functions of time in seconds ───────────── */

const TAU = Math.PI * 2;
const deg = (d: number) => (d * Math.PI) / 180;
/** Smooth 0 → 1 → 0 over one period, peaking at `phase` 0.5. */
const wave = (t: number, period: number) =>
  (1 - Math.cos((TAU * t) / period)) / 2;
const frac = (t: number, period: number) => (((t / period) % 1) + 1) % 1;

export interface Pose {
  /** Body lift, px. */
  lift: number;
  /** Body roll (about the forward axis) and pitch (forward lean), radians. */
  roll: number;
  pitch: number;
  /** Arm pitch about the shoulder, radians; negative swings forward. */
  armL: number;
  armR: number;
}

export const REST_POSE: Pose = { lift: 0, roll: 0, pitch: 0, armL: 0, armR: 0 };

/** One walk cycle per gait, in seconds (SPEC §8). */
export const GAIT_PERIOD: Readonly<Record<BotGait, number>> = {
  hop: 0.4,
  glide: 1.2,
  waddle: 0.62,
};

/** The walking pose at time `t` for a gait (SPEC §8 hop / glide / waddle and arm swing). */
export function gaitPose(gait: BotGait, t: number): Pose {
  const period = GAIT_PERIOD[gait];
  const p = frac(t, period);
  switch (gait) {
    case "hop": {
      // Bounces twice per cycle (peaks at 25% and 75%), rolling +6° then -6°.
      const bounce = Math.abs(Math.sin(TAU * p));
      const swing = deg(34) * Math.cos(TAU * p);
      return {
        lift: 5 * bounce,
        roll: deg(6) * Math.sin(TAU * p),
        pitch: 0,
        armL: swing,
        armR: -swing,
      };
    }
    case "glide":
      // Hovers 5–7px, leaning forward; the arms stay forward at -38°.
      return {
        lift: 5 + 2 * wave(t, period),
        roll: 0,
        pitch: -deg(9) + deg(2) * wave(t, period),
        armL: -deg(38),
        armR: -deg(38),
      };
    case "waddle": {
      const sway = -Math.cos(TAU * p);
      const swing = deg(34) * Math.cos(TAU * p);
      return {
        lift: 2 * wave(t, period),
        roll: deg(13) * sway,
        pitch: 0,
        armL: swing,
        armR: -swing,
      };
    }
  }
}

/** Idle float: the body rises 0.06 units every 2.6 s (SPEC §10.2). */
export function idleLift(t: number, phase: number): number {
  return (0.06 / PX) * wave(t + phase, 2.6);
}

/** Talking: head nod and turn, arm gestures (SPEC §8 nod, gesture). */
export function talkPose(t: number): {
  headPitch: number;
  headYaw: number;
  armL: number;
  armR: number;
  armYawL: number;
  armYawR: number;
  /** Mouth opening scale (steps between 1 and 2.2 every .18 s). */
  mouth: number;
  /** Status-ring pulse scale. */
  ring: number;
} {
  const nod = Math.sin((TAU * t) / 0.9);
  const g = wave(t, 0.55);
  return {
    headPitch: nod >= 0 ? deg(7) * nod : deg(3) * nod,
    headYaw: deg(7) * Math.sin((TAU * t) / 0.9),
    armL: -deg(10) - deg(28) * g,
    armR: -deg(10) - deg(28) * (1 - g),
    armYawL: deg(-8 + 16 * g),
    armYawR: deg(8 - 16 * g),
    mouth: Math.floor(t / 0.09) % 2 === 0 ? 1 : 2.2,
    ring: 1 + 0.14 * wave(t, 0.7),
  };
}

/** Working at the desk: both arms tap, the right one half a beat later (SPEC §8 tap). */
export function tapPose(t: number): { armL: number; armR: number } {
  return {
    armL: -deg(16) * wave(t, 0.34),
    armR: -deg(16) * wave(t + 0.17, 0.34),
  };
}

/** Eye blink scale: closes briefly near the end of every 4.6 s (SPEC §8 eyeblink). */
export function blinkScale(t: number, phase: number): number {
  const p = frac(t + phase, 4.6);
  return p > 0.95 && p < 0.99 ? 0.15 : 1;
}
