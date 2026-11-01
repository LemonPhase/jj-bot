/**
 * Imperative Three.js scene for the task Office 3D view (SPEC §5.5, §10).
 *
 * Bots in a task get a desk; each desk monitor shows that bot's real session
 * status and task events are acted out as beats (walking, facing, speech
 * bubbles and beams). The scene never invents state: statuses only come from
 * `sync()`, and beats only from real task events.
 *
 * Look: the C2 · Pixel Lite flat style. Every box has a top, front and side
 * colour (MeshBasicMaterial, no lighting or shadow maps), per theme. Bots are
 * block characters built from `bot.appearance` (see character3d.ts).
 *
 * Time: the loop measures real elapsed time and integrates it in small
 * sub-steps, so playback keeps real-time pace even at a few frames per second
 * (a headless browser). Rendering stops while the page is hidden or the stage
 * is offscreen, and `dispose()` frees every GPU resource and the context.
 */

import type { Bot, TaskView } from "@jj/contracts";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { colourRamp } from "../../lib/colour";
import { type StatusTone, statusTone } from "../../lib/status";
import { type Beat, beatHoldMs, sessionFor } from "./beats";
import {
  type BlockCharacter,
  type Box3,
  blinkScale,
  blockCharacter,
  boxToWorld,
  type Faces,
  gaitPose,
  idleLift,
  PLATE_HEIGHT,
  PLATE_WIDTH,
  type PlateRect,
  PX,
  REST_POSE,
  talkPose,
  tapPose,
} from "./character3d";
import type { OfficeStatus } from "./playback";

export type OfficeTheme = "light" | "dark";

type Place = "desk" | "table" | "board" | "terminal" | "visiting";

interface CanvasTex {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
}

interface Desk {
  screen: CanvasTex;
  top: THREE.Mesh;
  housing: THREE.Mesh;
  spot: THREE.Vector3;
  face: THREE.Vector3;
  fwd: THREE.Vector3;
  botId: string | null;
  tone: StatusTone | null;
}

interface GlowMat {
  mat: THREE.MeshBasicMaterial;
  base: THREE.Color;
}

interface Actor {
  profile: Bot;
  /** Appearance key; a change rebuilds the character. */
  look: string;
  spec: BlockCharacter;
  /** Fill colour from the bot's appearance (beams). */
  color: string;
  group: THREE.Group;
  body: THREE.Group;
  headPivot: THREE.Group;
  eyes: THREE.Object3D[];
  mouth: THREE.Object3D | null;
  arms: [THREE.Group, THREE.Group];
  tip: THREE.Object3D | null;
  dish: THREE.Object3D | null;
  leaves: THREE.Object3D | null;
  rotor: THREE.Object3D | null;
  halo: THREE.Object3D | null;
  glow: GlowMat[];
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  own: { dispose: () => void }[];
  desk: Desk;
  tag: HTMLDivElement;
  ping: HTMLDivElement;
  typing: HTMLDivElement;
  path: THREE.Vector3[];
  finalFace: THREE.Vector3 | null;
  lookAt: THREE.Vector3 | null;
  onArrive: (() => void) | null;
  yaw: number;
  targetYaw: number;
  talking: boolean;
  /** Session running and at the desk: taps away. */
  working: boolean;
  walkT: number;
  spin: number;
  at: Place;
  pingUntil: number;
  phase: number;
}

interface Beam {
  line: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>;
  dots: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[];
  from: () => THREE.Vector3;
  to: () => THREE.Vector3;
  born: number;
  dur: number;
}

interface Bubble {
  el: HTMLDivElement;
  text: HTMLSpanElement;
  from: string;
  full: string;
  born: number;
  typeDur: number;
  kill: number;
  anchor: () => THREE.Vector3;
}

/** Status colours per theme, mirroring `--status-*` in tokens.css. Light monitors use the light tones. */
const STATUS: Readonly<Record<OfficeTheme, Record<StatusTone, string>>> = {
  dark: {
    running: "#60A5FA",
    verifying: "#FBBF24",
    completed: "#4ADE80",
    failed: "#F87171",
    idle: "#4A4A52",
  },
  light: {
    running: "#3B82F6",
    verifying: "#F59E0B",
    completed: "#22C55E",
    failed: "#EF4444",
    idle: "#B4B4BC",
  },
};

/** Lines on a lit screen (`--status-*-deep`; failed and idle are not designed). */
const DEEP: Readonly<Record<OfficeTheme, Record<StatusTone, string>>> = {
  dark: {
    running: "#1E3A5F",
    verifying: "#6B4E0A",
    completed: "#14532D",
    failed: "#5C1F1F",
    idle: "#2A2A32",
  },
  light: {
    running: "#1E3A5F",
    verifying: "#6B4E0A",
    completed: "#14532D",
    failed: "#7F1D1D",
    idle: "#8A8A94",
  },
};

interface RoomPalette {
  bg: string;
  floor: string;
  checker: string;
  slab: Faces;
  wall: string;
  wallSide: string;
  wallEdge: string;
  wallEdgeSide: string;
  desk: Faces;
  deskFree: Faces;
  housingOn: Faces;
  housingOff: Faces;
  chair: Faces;
  table: Faces;
  leg: string;
  rug: string;
  sky: string;
  frame: string;
  star: string;
  plantA: Faces;
  plantB: Faces;
  pot: Faces;
  kiosk: Faces;
  termScreen: string;
  termCursor: string;
  accessory: string;
  boardFace: string;
  boardLabel: string;
  screenOff: string;
  ping: string;
  shadow: string;
  shadowOpacity: number;
}

/** Room colours per theme (SPEC §10.1: top · front · side). */
const THEMES: Readonly<Record<OfficeTheme, RoomPalette>> = {
  dark: {
    bg: "#0B0B0D",
    floor: "#0E0E12",
    checker: "#131318",
    slab: { t: "#0E0E12", f: "#0A0A0D", s: "#08080A" },
    wall: "#17171C",
    wallSide: "#131317",
    wallEdge: "#24242C",
    wallEdgeSide: "#1F1F26",
    desk: { t: "#2C2C34", f: "#212128", s: "#1A1A20" },
    deskFree: { t: "#24242B", f: "#1C1C22", s: "#16161B" },
    housingOn: { t: "#3A3A44", f: "#3A3A44", s: "#2A2A32" },
    housingOff: { t: "#2E2E36", f: "#2A2A32", s: "#222228" },
    chair: { t: "#202027", f: "#18181E", s: "#141419" },
    table: { t: "#2A2A31", f: "#1F1F25", s: "#18181D" },
    leg: "#3A3A44",
    rug: "#131318",
    sky: "#0F1626",
    frame: "#2A2A32",
    star: "#EDEDF0",
    plantA: { t: "#34D399", f: "#1E8A57", s: "#17704A" },
    plantB: { t: "#4AE3A4", f: "#22A06B", s: "#1B8257" },
    pot: { t: "#94705A", f: "#7A5A44", s: "#654A38" },
    kiosk: { t: "#2A2A31", f: "#1F1F25", s: "#1A1A20" },
    termScreen: "#16161A",
    termCursor: "#EDEDF0",
    accessory: "#3A3A44",
    boardFace: "#DCDCE2",
    boardLabel: "#2A2A32",
    screenOff: "#15151A",
    ping: "#FBBF24",
    shadow: "#000000",
    shadowOpacity: 0.55,
  },
  light: {
    bg: "#F7F7F8",
    floor: "#F2F2F5",
    checker: "#E9E9EE",
    slab: { t: "#F2F2F5", f: "#C9C9D1", s: "#B9B9C2" },
    wall: "#E6E6EC",
    wallSide: "#DCDCE3",
    wallEdge: "#D4D4DC",
    wallEdgeSide: "#CDCDD5",
    desk: { t: "#E2E2E8", f: "#CFCFD7", s: "#BDBDC6" },
    deskFree: { t: "#DDDDE3", f: "#CACAD2", s: "#B8B8C1" },
    housingOn: { t: "#8A8A94", f: "#8A8A94", s: "#B4B4BE" },
    housingOff: { t: "#B4B4BE", f: "#B4B4BE", s: "#9E9EA8" },
    chair: { t: "#D2D2DA", f: "#BEBEC7", s: "#ABABB5" },
    table: { t: "#DADAE0", f: "#C6C6CE", s: "#B2B2BB" },
    leg: "#8A8A94",
    rug: "#E9E9EE",
    sky: "#CFE3FF",
    frame: "#B4B4BE",
    star: "#FFFFFF",
    plantA: { t: "#34D399", f: "#1E8A57", s: "#17704A" },
    plantB: { t: "#4AE3A4", f: "#22A06B", s: "#1B8257" },
    pot: { t: "#94705A", f: "#7A5A44", s: "#654A38" },
    kiosk: { t: "#DADAE0", f: "#C6C6CE", s: "#BDBDC6" },
    termScreen: "#2A2A32",
    termCursor: "#FFFFFF",
    accessory: "#8A8A94",
    boardFace: "#FFFFFF",
    // SPEC §15: the design's #B4B4BE on white is unreadable.
    boardLabel: "#6B6B74",
    screenOff: "#3A3A44",
    ping: "#F59E0B",
    shadow: "#14141E",
    shadowOpacity: 0.16,
  },
};

type Role =
  | "slab"
  | "wall"
  | "wallSide"
  | "edge"
  | "edgeSide"
  | "desk"
  | "deskFree"
  | "housingOn"
  | "housingOff"
  | "chair"
  | "table"
  | "leg"
  | "rug"
  | "plantA"
  | "plantB"
  | "pot"
  | "kiosk"
  | "accessory";

const roleFaces = (p: RoomPalette, role: Role): Faces => {
  const flat = (c: string): Faces => ({ t: c, f: c, s: c });
  switch (role) {
    case "slab":
      return p.slab;
    case "wall":
      return { t: p.wallEdge, f: p.wall, s: p.wallSide };
    case "wallSide":
      return { t: p.wallEdgeSide, f: p.wallSide, s: p.wallSide };
    case "edge":
      return flat(p.wallEdge);
    case "edgeSide":
      return flat(p.wallEdgeSide);
    case "leg":
      return flat(p.leg);
    case "rug":
      return flat(p.rug);
    case "accessory":
      return flat(p.accessory);
    default:
      return p[role];
  }
};

const MONO = `"Geist Mono", ui-monospace, monospace`;
const TABLE = new THREE.Vector3(0, 0, 0.6);
const OBSTACLE_R = 1.95;
const RING_R = 2.2;
const HOME_TARGET = new THREE.Vector3(0, 0.5, 0.3);
const HOME_CAM = HOME_TARGET.clone().add(new THREE.Vector3(14.1, 13.6, 15.8));
const DESK_SLOTS = [
  { x: -6.4, z: -5.6, rot: 0 },
  { x: -2.15, z: -5.6, rot: 0 },
  { x: 2.15, z: -5.6, rot: 0 },
  { x: 6.4, z: -5.6, rot: 0 },
  { x: -3.2, z: 5.9, rot: Math.PI },
  { x: 1.4, z: 5.9, rot: Math.PI },
];
export const MAX_DESKS = DESK_SLOTS.length;
const BOARD_SPOT = new THREE.Vector3(-7.4, 0, 0.6);
const BOARD_FACE = new THREE.Vector3(-9, 0, 0.6);
const TERM_POS = new THREE.Vector3(7.7, 0, 3.4);
/** The kiosk's screen faces the front of the room, toward the default camera. */
const TERM_YAW = 0;
/** Where a bot reports back: in front of the kiosk, to its left so the screen stays visible. */
const TERM_SPOT = new THREE.Vector3(6.5, 0, 4.4);
const TERM_ANCHOR = new THREE.Vector3(7.7, 2.1, 3.4);
const WALK_SPEED = 2.6;
/** Longest sub-step of the simulation, s. */
const MAX_STEP = 1 / 30;
/** Longest gap one frame may cover (after a stall); longer gaps are dropped. */
const MAX_FRAME = 1;
const DRIFT = (4 * Math.PI) / 180;
const TAU = Math.PI * 2;

function canvasTex(w: number, h: number): CanvasTex {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { canvas, ctx, tex };
}

function angleLerp(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return a + d * t;
}

/**
 * Facing at the desk: toward the monitor while the bot's session is really
 * running (it taps away), otherwise toward the room, so its face shows.
 */
const homeYaw = (desk: Pick<Desk, "face" | "spot">, working: boolean) =>
  Math.atan2(desk.face.x - desk.spot.x, desk.face.z - desk.spot.z) +
  (working ? 0 : Math.PI);

const wave = (t: number, period: number) =>
  (1 - Math.cos((TAU * t) / period)) / 2;

const lookKey = (bot: Bot) => JSON.stringify(bot.appearance);

/** A design-px point in Three coordinates (x, z up, y front). */
const pxPoint = (x: number, y: number, z: number) =>
  new THREE.Vector3(x * PX, z * PX, y * PX);

export class OfficeScene {
  private readonly host: HTMLElement;
  private readonly overlay: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private readonly youEl: HTMLDivElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
  private readonly controls: OrbitControls;
  private readonly roleMats = new Map<
    Role,
    Record<keyof Faces, THREE.MeshBasicMaterial>
  >();
  private readonly paints = new Map<string, THREE.MeshBasicMaterial>();
  private readonly geos = new Map<string, THREE.BufferGeometry>();
  private readonly floorTex = canvasTex(256, 256);
  private readonly windowTex = canvasTex(168, 60);
  private readonly shadowMat = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
  });
  private readonly desks: Desk[];
  private readonly board = canvasTex(992, 320);
  private readonly term = canvasTex(160, 112);
  private readonly actors = new Map<string, Actor>();
  private readonly pickables: THREE.Object3D[] = [];
  private readonly beams: Beam[] = [];
  private readonly bubbles: Bubble[] = [];
  private readonly waiters: { t: number; res: () => void }[] = [];
  private readonly resizeObs: ResizeObserver;
  private readonly onStatus: (s: OfficeStatus) => void;

  private theme: OfficeTheme;
  private task: TaskView | null = null;
  private queue: Beat[] = [];
  private current: Beat | null = null;
  private played = 0;
  private total = 0;
  private running = false;
  private runToken = 0;
  private paused = false;
  private replaying = false;
  private speed = 1;
  private follow = true;
  private dragged = false;
  private reduced = false;
  private focus: string | null = null;
  private camReset = false;
  /** Home camera position, pulled back for narrow panes so the whole room fits. */
  private readonly homeCam = HOME_CAM.clone();
  private framed = false;
  private simT = 0;
  private wallT = 0;
  private drift = 0;
  private lastScan = -1;
  private lastCursor = -1;
  private lastFlash = -1;
  private boardFlashUntil = 0;
  private raf = 0;
  private active = true;
  private lastFrame = performance.now();
  private disposed = false;

  constructor(
    host: HTMLElement,
    opts: {
      onStatus: (s: OfficeStatus) => void;
      theme: OfficeTheme;
      reducedMotion?: boolean;
    },
  ) {
    this.host = host;
    this.onStatus = opts.onStatus;
    this.theme = opts.theme;
    this.reduced = opts.reducedMotion ?? false;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "office-canvas";
    host.appendChild(this.renderer.domElement);

    this.overlay = document.createElement("div");
    this.overlay.className = "office-overlays";
    this.overlay.setAttribute("aria-hidden", "true");
    host.appendChild(this.overlay);
    this.toastEl = document.createElement("div");
    this.toastEl.className = "office-toast office-toast--3d";
    this.toastEl.hidden = true;
    this.overlay.appendChild(this.toastEl);
    this.youEl = document.createElement("div");
    this.youEl.className = "office-you office-you--3d";
    this.youEl.textContent = "You";
    this.overlay.appendChild(this.youEl);

    this.camera.position.copy(HOME_CAM);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(HOME_TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.44;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 60;
    this.controls.addEventListener("start", () => {
      this.follow = false;
      this.dragged = true;
      this.camReset = false;
      this.emit();
    });

    for (const tex of [this.floorTex.tex, this.windowTex.tex]) {
      tex.magFilter = THREE.NearestFilter;
    }
    this.floorTex.tex.wrapS = this.floorTex.tex.wrapT = THREE.RepeatWrapping;
    this.floorTex.tex.repeat.set(18 / 3.6, 14 / 3.6);

    this.buildRoom();
    this.desks = DESK_SLOTS.map((slot) => this.buildDesk(slot));
    this.buildTerminal();
    this.buildBoard();
    this.setTheme(opts.theme);
    // Canvas text uses Geist Mono; redraw once the font is ready.
    void document.fonts?.load(`500 88px ${MONO}`).then(() => {
      if (!this.disposed) this.drawBoard();
    });

    this.renderer.domElement.addEventListener(
      "pointerdown",
      this.onPointerDown,
    );
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  /* ───────────── public API ───────────── */

  /** Reconcile with the latest task view + bots (in desk order). Safe to call on every update. */
  sync(task: TaskView, participants: Bot[]) {
    this.task = task;
    const wanted = participants.slice(0, MAX_DESKS);
    for (const [id, actor] of this.actors) {
      const bot = wanted.find((b) => b.id === id);
      if (!bot || lookKey(bot) !== actor.look) this.removeActor(actor);
    }
    for (const bot of wanted) {
      const existing = this.actors.get(bot.id);
      if (existing) {
        existing.profile = bot;
        existing.tag.textContent = bot.name;
      } else {
        const desk = this.desks.find((d) => d.botId === null);
        if (desk) this.addActor(bot, desk);
      }
    }
    for (const actor of this.actors.values()) {
      const session = sessionFor(task, actor.profile.id);
      const tone = session ? statusTone(session) : "idle";
      actor.desk.tone = tone;
      actor.working = session?.status === "running";
      actor.ring.material.color.set(STATUS[this.theme][tone]);
    }
    for (const desk of this.desks) if (!desk.botId) desk.tone = null;
    this.paintDesks();
    this.drawBoard();
    this.drawMonitors();
  }

  /** Act out beats after anything already queued (live updates). */
  enqueue(beats: Beat[]) {
    if (!beats.length) return;
    this.queue.push(...beats);
    this.total += beats.length;
    this.emit();
    void this.pump();
  }

  /** Replay from the desks. Statuses stay at their current, real values. */
  replay(beats: Beat[]) {
    this.reset();
    this.played = 0;
    this.total = 0;
    this.replaying = beats.length > 0;
    this.enqueue(beats);
    this.emit();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.overlay.classList.toggle("is-frozen", paused);
  }

  setSpeed(speed: number) {
    this.speed = speed > 0 ? speed : 1;
  }

  setFollow(on: boolean) {
    this.follow = on;
    this.emit();
  }

  resetView() {
    this.camReset = true;
    this.dragged = false;
    this.follow = true;
    this.emit();
  }

  /** Static poses: no idle float, gait, gestures, topper motion, blinking or drift. */
  setReducedMotion(on: boolean) {
    this.reduced = on;
    if (on) {
      for (const a of this.actors.values()) {
        const end = a.path.at(-1);
        if (end) a.group.position.set(end.x, 0, end.z);
        a.path = [];
        a.onArrive?.();
      }
    }
    this.overlay.classList.toggle("is-reduced", on);
  }

  /** Stops the render loop while the page is hidden or the stage is offscreen. */
  setActive(active: boolean) {
    if (this.disposed || active === this.active) return;
    this.active = active;
    cancelAnimationFrame(this.raf);
    if (active) {
      this.lastFrame = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  setTheme(theme: OfficeTheme) {
    this.theme = theme;
    const p = THEMES[theme];
    this.scene.background = new THREE.Color(p.bg);
    for (const [role, mats] of this.roleMats) {
      const faces = roleFaces(p, role);
      mats.t.color.set(faces.t);
      mats.f.color.set(faces.f);
      mats.s.color.set(faces.s);
    }
    this.shadowMat.color.set(p.shadow);
    this.shadowMat.opacity = p.shadowOpacity;
    this.drawFloor();
    this.drawWindow();
    for (const a of this.actors.values())
      a.ring.material.color.set(STATUS[theme][a.desk.tone ?? "idle"]);
    this.paintDesks();
    this.drawBoard();
    this.drawTerminal();
    this.drawMonitors();
  }

  dispose() {
    this.disposed = true;
    this.runToken++;
    this.flushWaiters();
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener(
      "pointerdown",
      this.onPointerDown,
    );
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    for (const a of [...this.actors.values()]) this.removeActor(a);
    for (const b of this.beams.splice(0)) this.disposeBeam(b);
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as
        | THREE.Material
        | THREE.Material[]
        | undefined;
      for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        (m as THREE.MeshBasicMaterial).map?.dispose();
        m.dispose();
      }
    });
    for (const geo of this.geos.values()) geo.dispose();
    for (const mat of this.paints.values()) mat.dispose();
    for (const mats of this.roleMats.values())
      for (const m of Object.values(mats)) m.dispose();
    this.shadowMat.dispose();
    for (const t of [this.floorTex, this.windowTex, this.board, this.term])
      t.tex.dispose();
    for (const desk of this.desks) desk.screen.tex.dispose();
    this.scene.clear();
    this.renderer.dispose();
    // Free the WebGL context now rather than when the canvas is collected.
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }

  /* ───────────── materials and geometry ───────────── */

  private role(role: Role): THREE.Material[] {
    let mats = this.roleMats.get(role);
    if (!mats) {
      const faces = roleFaces(THEMES[this.theme], role);
      mats = {
        t: new THREE.MeshBasicMaterial({ color: faces.t }),
        f: new THREE.MeshBasicMaterial({ color: faces.f }),
        s: new THREE.MeshBasicMaterial({ color: faces.s }),
      };
      this.roleMats.set(role, mats);
    }
    // BoxGeometry groups: +x, -x, +y (top), -y, +z (front), -z.
    return [mats.s, mats.s, mats.t, mats.s, mats.f, mats.s];
  }

  /** A shared flat material for a bot colour (bots look the same in both themes). */
  private paint(hex: string): THREE.MeshBasicMaterial {
    let mat = this.paints.get(hex);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({ color: hex });
      this.paints.set(hex, mat);
    }
    return mat;
  }

  private faceMats(faces: Faces): THREE.Material[] {
    const t = this.paint(faces.t);
    const f = this.paint(faces.f);
    const s = this.paint(faces.s);
    return [s, s, t, s, f, s];
  }

  private boxGeo(w: number, h: number, d: number): THREE.BufferGeometry {
    const key = `box|${w.toFixed(4)}|${h.toFixed(4)}|${d.toFixed(4)}`;
    let geo = this.geos.get(key);
    if (!geo) {
      geo = new THREE.BoxGeometry(w, h, d);
      this.geos.set(key, geo);
    }
    return geo;
  }

  private add(
    geo: THREE.BufferGeometry,
    mat: THREE.Material | THREE.Material[],
    x = 0,
    y = 0,
    z = 0,
    parent: THREE.Object3D = this.scene,
  ) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  private box(
    w: number,
    h: number,
    d: number,
    role: Role,
    x: number,
    y: number,
    z: number,
    parent: THREE.Object3D = this.scene,
  ) {
    return this.add(this.boxGeo(w, h, d), this.role(role), x, y, z, parent);
  }

  /* ───────────── building ───────────── */

  private buildRoom() {
    const floorTop = new THREE.MeshBasicMaterial({ map: this.floorTex.tex });
    const slab = this.role("slab");
    this.add(
      new THREE.BoxGeometry(18, 0.3, 14),
      [slab[0]!, slab[1]!, floorTop, slab[3]!, slab[4]!, slab[5]!],
      0,
      -0.15,
      0,
    );
    // Back wall (faces the room with +z) and side wall (faces it with +x).
    this.box(18.4, 3.4, 0.25, "wall", 0, 1.7, -7.12);
    const side = this.role("wallSide");
    this.add(
      this.boxGeo(0.25, 3.4, 14),
      [side[4]!, side[1]!, side[2]!, side[3]!, side[1]!, side[5]!],
      -9.12,
      1.7,
      0,
    );
    // Baseboards (4px).
    this.box(18.4, 0.12, 0.08, "edge", 0, 0.06, -6.96);
    this.box(0.08, 0.12, 14, "edgeSide", -8.96, 0.06, 0);
    const win = new THREE.MeshBasicMaterial({ map: this.windowTex.tex });
    for (const x of [-4.2, 0, 4.2])
      this.add(new THREE.PlaneGeometry(2.52, 0.9), win, x, 2.45, -6.99);
    const rug = new THREE.CylinderGeometry(3.1, 3.1, 0.02, 64);
    this.add(rug, this.role("rug")[2]!, TABLE.x, 0.01, TABLE.z);
    // Cylinder groups: side, top, bottom.
    const t = this.role("table");
    this.add(
      new THREE.CylinderGeometry(1.15, 1.15, 0.1, 48),
      [t[4]!, t[2]!, t[3]!],
      TABLE.x,
      0.77,
      TABLE.z,
    );
    this.box(0.22, 0.72, 0.22, "leg", TABLE.x, 0.36, TABLE.z);
    const c = this.role("chair");
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + Math.PI / 6;
      this.add(
        new THREE.CylinderGeometry(0.22, 0.22, 0.42, 20),
        [c[4]!, c[2]!, c[3]!],
        TABLE.x + Math.cos(a) * 1.6,
        0.21,
        TABLE.z + Math.sin(a) * 1.6,
      );
    }
    const plant = (x: number, z: number, s: number) => {
      this.box(0.5 * s, 0.45 * s, 0.5 * s, "pot", x, 0.225 * s, z);
      this.box(
        0.2 * s,
        0.75 * s,
        0.2 * s,
        "plantA",
        x - 0.1 * s,
        (0.45 + 0.375) * s,
        z,
      );
      this.box(
        0.2 * s,
        0.55 * s,
        0.2 * s,
        "plantB",
        x + 0.12 * s,
        (0.45 + 0.275) * s,
        z + 0.05 * s,
      );
      this.box(
        0.16 * s,
        0.4 * s,
        0.16 * s,
        "plantB",
        x - 0.02 * s,
        (0.45 + 0.2) * s,
        z - 0.14 * s,
      );
    };
    plant(-8.3, -6.3, 1.4);
    plant(8.3, -6.3, 1.2);
    plant(-8.3, 6.2, 1.1);
    this.box(0.9, 0.9, 0.7, "deskFree", -8.4, 0.45, 4.6);
    this.box(0.45, 0.5, 0.4, "housingOff", -8.45, 1.15, 4.6);
  }

  private buildDesk(slot: { x: number; z: number; rot: number }): Desk {
    const g = new THREE.Group();
    g.position.set(slot.x, 0, slot.z);
    g.rotation.y = slot.rot;
    this.scene.add(g);
    // A solid block, 26px (0.78u) high, as the design draws desks.
    const top = this.box(2.5, 0.78, 1.15, "deskFree", 0, 0.39, 0, g);
    this.box(0.08, 0.3, 0.08, "leg", 0, 0.93, -0.32, g);
    this.box(0.4, 0.03, 0.25, "leg", 0, 0.795, -0.32, g);
    const housing = this.box(1.25, 0.76, 0.06, "housingOff", 0, 1.42, -0.34, g);
    this.box(0.7, 0.03, 0.22, "accessory", 0, 0.795, 0.12, g);
    this.box(0.12, 0.14, 0.12, "accessory", 0.85, 0.85, 0.1, g);
    const screen = canvasTex(150, 90);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 0.67),
      new THREE.MeshBasicMaterial({ map: screen.tex }),
    );
    plane.position.set(0, 1.42, -0.305);
    g.add(plane);
    const fwd = new THREE.Vector3(Math.sin(slot.rot), 0, Math.cos(slot.rot));
    return {
      screen,
      top,
      housing,
      spot: new THREE.Vector3(slot.x, 0, slot.z).addScaledVector(fwd, 1.05),
      face: new THREE.Vector3(slot.x, 0, slot.z),
      fwd,
      botId: null,
      tone: null,
    };
  }

  private buildBoard() {
    const g = new THREE.Group();
    g.position.set(-8.97, 1.9, 0.6);
    g.rotation.y = Math.PI / 2;
    this.scene.add(g);
    // 124×40 px face with a 3px frame (SPEC §10.1).
    this.box(3.9, 1.38, 0.06, "leg", 0, 0, -0.02, g);
    const p = new THREE.Mesh(
      new THREE.PlaneGeometry(3.72, 1.2),
      new THREE.MeshBasicMaterial({ map: this.board.tex }),
    );
    p.position.z = 0.015;
    g.add(p);
  }

  private buildTerminal() {
    const g = new THREE.Group();
    g.position.copy(TERM_POS);
    g.rotation.y = TERM_YAW;
    this.scene.add(g);
    // Kiosk 24×40×58 px; its front (+z) faces the room.
    this.box(0.72, 1.74, 1.2, "kiosk", 0, 0.87, 0, g);
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.56, 0.4),
      new THREE.MeshBasicMaterial({ map: this.term.tex }),
    );
    screen.position.set(0, 1.36, 0.601);
    g.add(screen);
  }

  /** Builds the block character for a bot (SPEC §10.2). */
  private addActor(bot: Bot, desk: Desk) {
    desk.botId = bot.id;
    const spec = blockCharacter(bot.appearance);
    const own: { dispose: () => void }[] = [];
    const g = new THREE.Group();
    this.scene.add(g);
    const body = new THREE.Group();
    g.add(body);

    const part = (
      b: Box3,
      faces: Faces,
      parent: THREE.Object3D,
      origin = new THREE.Vector3(),
      mats?: THREE.Material[],
    ) => {
      const { size, centre } = boxToWorld(b);
      const m = this.add(
        this.boxGeo(...size),
        mats ?? this.faceMats(faces),
        centre[0] - origin.x,
        centre[1] - origin.y,
        centre[2] - origin.z,
        parent,
      );
      return m;
    };

    part(spec.body.box, spec.body.faces, body);
    part(spec.belt.box, spec.belt.faces, body);
    part(spec.neck.box, spec.neck.faces, body);

    const arms = spec.arms.map((arm, i) => {
      const [sx, sy, sz] = spec.shoulders[i] ?? [0, 0, 0];
      const pivot = new THREE.Group();
      const origin = pxPoint(sx, sy, sz);
      pivot.position.copy(origin);
      body.add(pivot);
      part(arm.box, arm.faces, pivot, origin);
      return pivot;
    }) as [THREE.Group, THREE.Group];

    const headPivot = new THREE.Group();
    const headOrigin = pxPoint(0, 0, spec.headPivotZ);
    headPivot.position.copy(headOrigin);
    body.add(headPivot);
    for (const b of spec.head.boxes)
      part(b.box, b.faces, headPivot, headOrigin);

    // Face plate: 24×14 px, centred, bottom edge at fz, 0.6px in front of the head.
    const plateZ = (spec.head.front + 0.6) * PX;
    const rectMesh = (r: PlateRect, layer: number) => {
      const w = r.w * PX;
      const h = r.h * PX;
      let geo: THREE.BufferGeometry;
      if (r.r) {
        const shape = new THREE.Shape();
        const rad = Math.min(r.r * PX, w / 2, h / 2);
        shape.moveTo(-w / 2 + rad, -h / 2);
        shape.lineTo(w / 2 - rad, -h / 2);
        shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + rad);
        shape.lineTo(w / 2, h / 2 - rad);
        shape.quadraticCurveTo(w / 2, h / 2, w / 2 - rad, h / 2);
        shape.lineTo(-w / 2 + rad, h / 2);
        shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - rad);
        shape.lineTo(-w / 2, -h / 2 + rad);
        shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + rad, -h / 2);
        geo = new THREE.ShapeGeometry(shape, 4);
        own.push(geo);
      } else {
        geo = this.planeGeo(w, h);
      }
      const mesh = new THREE.Mesh(geo, this.paint(r.colour));
      mesh.position.set(
        (-PLATE_WIDTH / 2 + r.x + r.w / 2) * PX,
        (spec.head.fz + PLATE_HEIGHT - r.y - r.h / 2 - spec.headPivotZ) * PX,
        plateZ + layer * 0.15 * PX,
      );
      return mesh;
    };
    const face = spec.face;
    if (face.plate) headPivot.add(rectMesh(face.plate, 0));
    const eyes = face.eyes.map((eye) => {
      const mesh = rectMesh(eye, 1);
      const group = new THREE.Group();
      group.position.copy(mesh.position);
      mesh.position.set(0, 0, 0);
      group.add(mesh);
      for (const d of face.eyeDetails) {
        if (d.x < eye.x || d.x >= eye.x + eye.w) continue;
        const detail = rectMesh(d, 2);
        detail.position.sub(group.position);
        group.add(detail);
      }
      headPivot.add(group);
      return group;
    });
    const mouth = face.mouth ? rectMesh(face.mouth, 1) : null;
    if (mouth) headPivot.add(mouth);

    // Topper at z = top, inside the head pivot so it nods with the head.
    const topper = new THREE.Group();
    topper.position.copy(pxPoint(0, 0, spec.head.top).sub(headOrigin));
    headPivot.add(topper);
    const glow: GlowMat[] = [];
    const glowMats = (faces: Faces): THREE.Material[] => {
      const make = (hex: string) => {
        const mat = new THREE.MeshBasicMaterial({ color: hex });
        own.push(mat);
        glow.push({ mat, base: new THREE.Color(hex) });
        return mat;
      };
      const t = make(faces.t);
      const f = make(faces.f);
      const s = make(faces.s);
      return [s, s, t, s, f, s];
    };
    const groupFor = (pivotZ = 0) => {
      const grp = new THREE.Group();
      grp.position.y = pivotZ * PX;
      topper.add(grp);
      return grp;
    };
    let tip: THREE.Object3D | null = null;
    let dish: THREE.Object3D | null = null;
    let leaves: THREE.Object3D | null = null;
    let rotor: THREE.Object3D | null = null;
    for (const p of spec.topper.parts) {
      const mats = p.glow ? glowMats(p.faces) : undefined;
      if (p.role === "static") part(p.box, p.faces, topper, undefined, mats);
      else if (p.role === "tip") {
        const { centre } = boxToWorld(p.box);
        const grp = groupFor();
        grp.position.set(centre[0], centre[1], centre[2]);
        part(p.box, p.faces, grp, new THREE.Vector3(...centre), mats);
        tip = grp;
      } else if (p.role === "dish") {
        dish ??= groupFor();
        part(p.box, p.faces, dish, undefined, mats);
      } else if (p.role === "leaves") {
        leaves ??= groupFor(spec.topper.leafPivot);
        part(
          p.box,
          p.faces,
          leaves,
          pxPoint(0, 0, spec.topper.leafPivot),
          mats,
        );
      } else if (p.role === "rotor") {
        rotor ??= groupFor();
        part(p.box, p.faces, rotor, undefined, mats);
      }
    }
    let halo: THREE.Object3D | null = null;
    if (spec.topper.halo) {
      const h = spec.topper.halo;
      const ring = new THREE.TorusGeometry(
        ((h.diameter - h.tube) / 2) * PX,
        (h.tube / 2) * PX,
        8,
        32,
      );
      own.push(ring);
      const mat = new THREE.MeshBasicMaterial({ color: h.colour });
      own.push(mat);
      glow.push({ mat, base: new THREE.Color(h.colour) });
      const mesh = new THREE.Mesh(ring, mat);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.y = h.z * PX;
      halo = groupFor();
      halo.add(mesh);
    }

    // Ground shadow (38×30 px ellipse) and status ring (44 px, 2 px stroke).
    const shadow = new THREE.Mesh(this.circleGeo(), this.shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(0.57, 0.45, 1);
    shadow.position.y = 0.012;
    g.add(shadow);
    const ringGeo = new THREE.RingGeometry(0.6, 0.66, 48);
    const ringMat = new THREE.MeshBasicMaterial({
      color: STATUS[this.theme].idle,
    });
    own.push(ringGeo, ringMat);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;
    g.add(ring);

    const tag = document.createElement("div");
    tag.className = "office-tag office-tag--3d";
    tag.textContent = bot.name;
    const ping = document.createElement("div");
    ping.className = "office-ping office-ping--3d";
    ping.textContent = "!";
    ping.hidden = true;
    const typing = document.createElement("div");
    typing.className = "office-typing office-typing--3d";
    typing.append(
      document.createElement("span"),
      document.createElement("span"),
      document.createElement("span"),
    );
    typing.hidden = true;
    this.overlay.append(tag, ping, typing);

    const yaw = homeYaw(desk, false);
    g.position.copy(desk.spot);
    g.rotation.y = yaw;
    const actor: Actor = {
      profile: bot,
      look: lookKey(bot),
      spec,
      color: colourRamp(bot.appearance.colour).f,
      group: g,
      body,
      headPivot,
      eyes,
      mouth,
      arms,
      tip,
      dish,
      leaves,
      rotor,
      halo,
      glow,
      ring,
      own,
      desk,
      tag,
      ping,
      typing,
      path: [],
      finalFace: null,
      lookAt: null,
      onArrive: null,
      yaw,
      targetYaw: yaw,
      talking: false,
      working: false,
      walkT: 0,
      spin: 0,
      at: "desk",
      pingUntil: 0,
      phase: this.actors.size * 1.37,
    };
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.userData.botId = bot.id;
        this.pickables.push(o);
      }
    });
    this.actors.set(bot.id, actor);
  }

  private planeGeo(w: number, h: number) {
    const key = `plane|${w.toFixed(4)}|${h.toFixed(4)}`;
    let geo = this.geos.get(key);
    if (!geo) {
      geo = new THREE.PlaneGeometry(w, h);
      this.geos.set(key, geo);
    }
    return geo;
  }

  private circleGeo() {
    let geo = this.geos.get("circle");
    if (!geo) {
      geo = new THREE.CircleGeometry(1, 32);
      this.geos.set("circle", geo);
    }
    return geo;
  }

  private removeActor(actor: Actor) {
    this.scene.remove(actor.group);
    actor.tag.remove();
    actor.ping.remove();
    actor.typing.remove();
    actor.desk.botId = null;
    actor.desk.tone = null;
    actor.onArrive?.();
    for (const r of actor.own) r.dispose();
    for (let i = this.pickables.length - 1; i >= 0; i--) {
      if (this.pickables[i]?.userData.botId === actor.profile.id)
        this.pickables.splice(i, 1);
    }
    this.actors.delete(actor.profile.id);
  }

  /* ───────────── drawing ───────────── */

  private paintDesks() {
    for (const desk of this.desks) {
      const on = desk.botId !== null;
      desk.top.material = this.role(on ? "desk" : "deskFree");
      desk.housing.material = this.role(on ? "housingOn" : "housingOff");
    }
  }

  private drawFloor() {
    const { ctx, canvas, tex } = this.floorTex;
    const p = THEMES[this.theme];
    const half = canvas.width / 2;
    ctx.fillStyle = p.floor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = p.checker;
    ctx.fillRect(0, 0, half, half);
    ctx.fillRect(half, half, half, half);
    tex.needsUpdate = true;
  }

  private drawWindow() {
    const { ctx, canvas, tex } = this.windowTex;
    const p = THEMES[this.theme];
    ctx.fillStyle = p.frame;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = p.sky;
    ctx.fillRect(6, 6, canvas.width - 12, canvas.height - 12);
    ctx.fillStyle = p.star;
    for (const [x, y] of [
      [20, 12],
      [56, 32],
      [92, 16],
      [128, 38],
      [146, 14],
    ] as const)
      ctx.fillRect(x, y, 4, 4);
    tex.needsUpdate = true;
  }

  /** Whiteboard (SPEC §10.1): two text lines and the goal version. No checks in 1.0. */
  private drawBoard() {
    const { ctx, canvas, tex } = this.board;
    const p = THEMES[this.theme];
    const u = canvas.width / 124;
    ctx.fillStyle = p.boardFace;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#8E8E98";
    ctx.fillRect(8 * u, 8 * u, 56 * u, 3 * u);
    ctx.fillStyle = "#B4B4BC";
    ctx.fillRect(8 * u, 15 * u, 38 * u, 3 * u);
    const task = this.task?.task;
    if (task) {
      ctx.fillStyle = p.boardLabel;
      ctx.font = `400 ${11 * u}px ${MONO}`;
      ctx.textAlign = "right";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(`v${task.goalVersion}`, canvas.width - 8 * u, 30 * u);
    }
    if (this.flashOn()) {
      ctx.strokeStyle = p.ping;
      ctx.lineWidth = 6 * u;
      ctx.strokeRect(0, 0, canvas.width, canvas.height);
    }
    tex.needsUpdate = true;
  }

  private flashOn() {
    if (this.simT >= this.boardFlashUntil) return false;
    // `flash`: .5s steps(2) — on for the first half of every half second.
    return this.reduced || Math.floor(this.wallT / 0.25) % 2 === 0;
  }

  private drawTerminal() {
    const { ctx, canvas, tex } = this.term;
    const p = THEMES[this.theme];
    const u = canvas.width / 32;
    ctx.fillStyle = p.termScreen;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#8E8E98";
    ctx.fillRect(4 * u, 5 * u, 14 * u, 2 * u);
    ctx.fillRect(4 * u, 10 * u, 10 * u, 2 * u);
    const cursorOn = this.reduced || Math.floor(this.wallT / 0.5) % 2 === 0;
    if (cursorOn) {
      ctx.fillStyle = p.termCursor;
      ctx.fillRect(4 * u, 15 * u, 5 * u, 2 * u);
    }
    tex.needsUpdate = true;
  }

  /** Monitors show the bot's real session status, in the theme's status colours. */
  private drawMonitors(onlyRunning = false) {
    const scanDim =
      !this.reduced && Math.floor(this.wallT / (1.4 / 3)) % 3 === 1;
    for (const desk of this.desks) {
      if (onlyRunning && desk.tone !== "running") continue;
      const { ctx, canvas, tex } = desk.screen;
      const w = canvas.width;
      const h = canvas.height;
      if (desk.tone === null) {
        ctx.fillStyle = THEMES[this.theme].screenOff;
        ctx.fillRect(0, 0, w, h);
      } else {
        ctx.fillStyle = STATUS[this.theme][desk.tone];
        ctx.fillRect(0, 0, w, h);
        const deep = DEEP[this.theme][desk.tone];
        ctx.fillStyle = deep;
        ctx.fillRect(w * 0.12, h * 0.26, w * 0.47, h * 0.11);
        ctx.globalAlpha = desk.tone === "running" && scanDim ? 0.35 : 1;
        ctx.fillRect(w * 0.12, h * 0.52, w * 0.67, h * 0.11);
        ctx.globalAlpha = 1;
      }
      tex.needsUpdate = true;
    }
  }

  /* ───────────── choreography ───────────── */

  private emit() {
    this.onStatus({
      step: this.played,
      total: this.total,
      currentId: this.current?.id ?? null,
      replaying: this.replaying,
      pending: this.queue.length,
      following: this.follow,
    });
  }

  private wait(ms: number) {
    return new Promise<void>((res) =>
      this.waiters.push({ t: this.simT + ms / 1000, res }),
    );
  }

  private flushWaiters() {
    for (const w of this.waiters.splice(0)) w.res();
  }

  private reset() {
    this.runToken++;
    this.running = false;
    this.queue = [];
    this.current = null;
    this.flushWaiters();
    for (const b of this.bubbles.splice(0)) b.el.remove();
    for (const b of this.beams.splice(0)) this.disposeBeam(b);
    this.toastEl.hidden = true;
    this.boardFlashUntil = 0;
    for (const a of this.actors.values()) {
      a.path = [];
      a.onArrive?.();
      a.group.position.copy(a.desk.spot);
      a.yaw = a.targetYaw = homeYaw(a.desk, a.working);
      a.at = "desk";
      a.talking = false;
      a.lookAt = null;
      a.pingUntil = 0;
    }
    this.focus = null;
    this.replaying = false;
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    const token = this.runToken;
    while (this.queue.length && token === this.runToken && !this.disposed) {
      const beat = this.queue.shift()!;
      this.current = beat;
      this.played += 1;
      this.emit();
      await this.perform(beat, token);
      if (token !== this.runToken) return;
      this.current = null;
      this.emit();
      await this.wait(450);
    }
    if (token !== this.runToken) return;
    this.running = false;
    await this.wait(1500);
    if (token === this.runToken && !this.queue.length) {
      if (this.replaying) {
        this.replaying = false;
        this.emit();
      }
      for (const a of this.actors.values()) {
        if (a.at !== "desk") void this.goHome(a);
        else a.lookAt = null;
      }
      this.focus = null;
    }
  }

  private walkTo(
    a: Actor,
    pos: THREE.Vector3,
    face: THREE.Vector3 | null,
    at: Place,
  ) {
    a.at = at;
    a.onArrive?.();
    a.path = this.planPath(a.group.position, pos);
    a.finalFace = face;
    a.lookAt = null;
    if (this.reduced) {
      a.group.position.set(pos.x, 0, pos.z);
      a.path = [];
      if (face)
        a.yaw = a.targetYaw = Math.atan2(face.x - pos.x, face.z - pos.z);
      return Promise.resolve();
    }
    return new Promise<void>((res) => {
      a.onArrive = () => {
        a.onArrive = null;
        res();
      };
    });
  }

  private goHome(a: Actor) {
    return this.walkTo(a, a.desk.spot, a.desk.face, "desk");
  }

  private planPath(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
    const abx = to.x - from.x;
    const abz = to.z - from.z;
    const t = THREE.MathUtils.clamp(
      ((TABLE.x - from.x) * abx + (TABLE.z - from.z) * abz) /
        Math.max(abx * abx + abz * abz, 1e-6),
      0,
      1,
    );
    const hit =
      Math.hypot(from.x + abx * t - TABLE.x, from.z + abz * t - TABLE.z) <
      OBSTACLE_R;
    if (!hit) return [to.clone()];
    const ang = (p: THREE.Vector3) => Math.atan2(p.z - TABLE.z, p.x - TABLE.x);
    const a0 = ang(from);
    let d = ang(to) - a0;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    const n = Math.max(2, Math.ceil(Math.abs(d) / 0.35));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (d * i) / n;
      pts.push(
        new THREE.Vector3(
          TABLE.x + Math.cos(a) * RING_R,
          0,
          TABLE.z + Math.sin(a) * RING_R,
        ),
      );
    }
    pts.push(to.clone());
    return pts;
  }

  private seatFor(a: Actor) {
    const ids = [...this.actors.keys()];
    const i = Math.max(0, ids.indexOf(a.profile.id));
    const n = Math.max(ids.length, 3);
    const ang = -Math.PI / 2 - Math.PI / 5 + (i / n) * TAU;
    return new THREE.Vector3(
      TABLE.x + Math.cos(ang) * 2.05,
      0,
      TABLE.z + Math.sin(ang) * 2.05,
    );
  }

  private approachSpot(target: Actor, from: Actor) {
    if (target.at === "desk" && !target.path.length) {
      const side = new THREE.Vector3(target.desk.fwd.z, 0, -target.desk.fwd.x);
      const rel = new THREE.Vector3().subVectors(
        from.group.position,
        target.group.position,
      );
      const sgn = Math.sign(side.dot(rel)) || 1;
      return target.desk.spot
        .clone()
        .addScaledVector(target.desk.fwd, 0.55)
        .addScaledVector(side, sgn * 1.05);
    }
    const dir = new THREE.Vector3()
      .subVectors(from.group.position, target.group.position)
      .setY(0);
    if (dir.lengthSq() < 0.01) dir.set(1, 0, 0);
    return target.group.position.clone().addScaledVector(dir.normalize(), 1.15);
  }

  private async perform(beat: Beat, token: number) {
    const alive = () => token === this.runToken;
    const dur = beatHoldMs(beat);
    const S = this.actors.get(beat.from);
    const T = beat.to
      .map((id) => this.actors.get(id))
      .filter((a): a is Actor => !!a);
    const involved = new Set([beat.from, ...beat.to]);
    if (beat.mode !== "huddle") {
      for (const a of this.actors.values())
        if (!involved.has(a.profile.id) && a.at !== "desk") void this.goHome(a);
    }

    if (beat.mode === "announce" || (!S && beat.from !== "user")) {
      this.toast(beat.text, dur);
      this.boardFlashUntil = this.simT + dur / 1000;
      for (const a of this.actors.values())
        a.pingUntil = this.simT + dur / 1000;
      this.focus = "board";
      await this.wait(dur);
      return;
    }

    if (beat.mode === "user" || !S) {
      this.focus = "user";
      for (const a of T) {
        a.lookAt = TERM_POS.clone();
        a.pingUntil = this.simT + dur / 1000;
        this.addBeam(
          () => TERM_ANCHOR.clone(),
          () => this.headPos(a),
          0x8e8e98,
          dur,
        );
      }
      this.showBubble("user", beat, dur, () => TERM_ANCHOR.clone().setY(2.3));
      await this.wait(dur);
      return;
    }

    this.focus = S.profile.id;
    if (beat.mode === "huddle") {
      await Promise.all([
        this.walkTo(S, this.seatFor(S), TABLE, "table"),
        ...T.map((a) => this.walkTo(a, this.seatFor(a), TABLE, "table")),
      ]);
    } else if (beat.mode === "board") {
      await this.walkTo(S, BOARD_SPOT, BOARD_FACE, "board");
    } else if (beat.mode === "terminal") {
      await this.walkTo(S, TERM_SPOT, TERM_POS, "terminal");
    } else if (beat.mode === "visit" && T[0]) {
      await this.walkTo(S, this.approachSpot(T[0], S), null, "visiting");
      S.lookAt = T[0].group.position.clone();
    }
    if (!alive()) return;

    S.talking = true;
    if (beat.mode === "huddle") S.lookAt = TABLE.clone();
    const colour = new THREE.Color(S.color).getHex();
    for (const a of T) {
      a.lookAt = S.group.position.clone();
      this.addBeam(
        () => this.headPos(S),
        () => this.headPos(a),
        colour,
        dur,
      );
    }
    if (beat.mode === "terminal")
      this.addBeam(
        () => this.headPos(S),
        () => TERM_ANCHOR.clone(),
        colour,
        dur,
      );
    if (beat.mode === "board") this.boardFlashUntil = this.simT + dur / 1000;
    this.showBubble(S.profile.id, beat, dur, () =>
      this.headPos(S).add(new THREE.Vector3(0, 0.3, 0)),
    );
    await this.wait(dur);
    S.talking = false;
  }

  /* ───────────── fx ───────────── */

  /** The top of a bot (its topper included). */
  private headPos(a: Actor) {
    return a.group.position
      .clone()
      .add(new THREE.Vector3(0, a.spec.height * PX + 0.1, 0));
  }

  private addBeam(
    from: () => THREE.Vector3,
    to: () => THREE.Vector3,
    color: number,
    durMs: number,
  ) {
    const geo = new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(40 * 3), 3),
    );
    const line = new THREE.Line(
      geo,
      new THREE.LineDashedMaterial({
        color,
        dashSize: 0.18,
        gapSize: 0.12,
        transparent: true,
        opacity: 0,
      }),
    );
    this.scene.add(line);
    const dots = [0, 1, 2].map(() => {
      const d = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 8, 6),
        new THREE.MeshBasicMaterial({ color, transparent: true }),
      );
      this.scene.add(d);
      return d;
    });
    this.beams.push({
      line,
      dots,
      from,
      to,
      born: this.simT,
      dur: durMs / 1000,
    });
  }

  private disposeBeam(b: Beam) {
    this.scene.remove(b.line);
    b.line.geometry.dispose();
    b.line.material.dispose();
    for (const d of b.dots) {
      this.scene.remove(d);
      d.geometry.dispose();
      d.material.dispose();
    }
  }

  private updateBeams() {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i]!;
      const age = this.simT - b.born;
      const life = age / b.dur;
      const a = b.from();
      const c = b.to();
      const mid = a.clone().lerp(c, 0.5);
      mid.y += 0.6 + a.distanceTo(c) * 0.12;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, c);
      const pos = b.line.geometry.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < 40; k++) {
        const p = curve.getPoint(k / 39);
        pos.setXYZ(k, p.x, p.y, p.z);
      }
      pos.needsUpdate = true;
      b.line.computeLineDistances();
      const op =
        Math.min(1, age * 4) *
        (life > 0.85 ? Math.max(0, (1 - life) / 0.15) : 1);
      b.line.material.opacity = op * 0.8;
      b.dots.forEach((d, k) => {
        d.visible = !this.reduced;
        d.position.copy(curve.getPoint((age * 0.9 + k / 3) % 1));
        d.material.opacity = op;
      });
      if (life >= 1) {
        this.disposeBeam(b);
        this.beams.splice(i, 1);
      }
    }
  }

  private showBubble(
    from: string,
    beat: Beat,
    durMs: number,
    anchor: () => THREE.Vector3,
  ) {
    for (const b of this.bubbles) if (b.from === from) b.kill = this.simT;
    const el = document.createElement("div");
    el.className = "office-bubble office-bubble--3d";
    const who = document.createElement("span");
    who.className = "office-bubble__who";
    const name =
      from === "user"
        ? "You"
        : (this.actors.get(from)?.profile.name ?? "A bot");
    who.textContent =
      beat.intent === "discussion" ? name : `${name} · ${beat.intent}`;
    const body = document.createElement("span");
    body.className = "office-bubble__text";
    el.append(who, body);
    this.overlay.appendChild(el);
    const dur = durMs / 1000;
    this.bubbles.push({
      el,
      text: body,
      from,
      full: beat.text,
      born: this.simT,
      typeDur: this.reduced ? 0 : Math.min(dur * 0.45, 2.2),
      kill: this.simT + dur + 1.4,
      anchor,
    });
  }

  private toast(text: string, durMs: number) {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    const token = this.runToken;
    void this.wait(durMs).then(() => {
      if (token === this.runToken) this.toastEl.hidden = true;
    });
  }

  private project(v: THREE.Vector3, w: number, h: number, el: HTMLElement) {
    const p = v.project(this.camera);
    el.style.left = `${((p.x + 1) / 2) * w}px`;
    el.style.top = `${((1 - p.y) / 2) * h}px`;
    el.style.visibility = p.z > 1 ? "hidden" : "";
  }

  /* ───────────── loop ───────────── */

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pullBack = THREE.MathUtils.clamp(1.5 / this.camera.aspect, 1, 1.9);
    this.homeCam
      .copy(HOME_CAM)
      .sub(HOME_TARGET)
      .multiplyScalar(pullBack)
      .add(HOME_TARGET);
    if (!this.framed) {
      this.camera.position.copy(this.homeCam);
      this.framed = true;
    }
  }

  /** Advances the simulation by `dt` seconds of wall-clock time. */
  private step(dt: number) {
    this.wallT += dt;
    const sdt = this.paused ? 0 : dt * this.speed;
    this.simT += sdt;
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (this.simT >= w.t) {
        this.waiters.splice(i, 1);
        w.res();
      }
    }
    for (const a of this.actors.values()) {
      const g = a.group;
      const target = a.path[0];
      if (target && sdt > 0) {
        const d = new THREE.Vector3().subVectors(target, g.position).setY(0);
        const dist = d.length();
        const stepLen = WALK_SPEED * sdt;
        if (dist <= stepLen) {
          g.position.set(target.x, 0, target.z);
          a.path.shift();
        } else {
          g.position.addScaledVector(d.normalize(), stepLen);
          a.targetYaw = Math.atan2(d.x, d.z);
        }
        a.walkT += sdt;
        if (!a.path.length) {
          if (a.finalFace)
            a.targetYaw = Math.atan2(
              a.finalFace.x - g.position.x,
              a.finalFace.z - g.position.z,
            );
          a.onArrive?.();
        }
      } else if (a.lookAt && !a.path.length) {
        a.targetYaw = Math.atan2(
          a.lookAt.x - g.position.x,
          a.lookAt.z - g.position.z,
        );
      } else if (!a.path.length && a.at === "desk") {
        a.targetYaw = homeYaw(a.desk, a.working && !a.talking);
      }
      a.yaw = angleLerp(a.yaw, a.targetYaw, Math.min(1, dt * 9));
    }
  }

  /** Poses every bot for the current time (SPEC §8 motion). */
  private pose(dt: number) {
    const t = this.wallT;
    for (const a of this.actors.values()) {
      a.group.rotation.y = a.yaw;
      const walking = a.path.length > 0 && !this.paused;
      const atDesk = a.at === "desk" && !walking;
      const still = this.reduced;
      const pose =
        !still && walking ? gaitPose(a.spec.gait, a.walkT) : REST_POSE;
      const lift = still ? 0 : walking ? pose.lift : idleLift(t, a.phase);
      a.body.position.y = lift * PX;
      a.body.rotation.set(pose.pitch, 0, pose.roll);
      let armL = pose.armL;
      let armR = pose.armR;
      let yawL = 0;
      let yawR = 0;
      let headPitch = 0;
      let headYaw = 0;
      let mouth = 1;
      let ring = 1;
      if (!still && a.talking && !walking) {
        const tp = talkPose(t);
        armL = tp.armL;
        armR = tp.armR;
        yawL = tp.armYawL;
        yawR = tp.armYawR;
        headPitch = -tp.headPitch;
        headYaw = tp.headYaw;
        mouth = tp.mouth;
        ring = tp.ring;
      } else if (!still && a.working && atDesk) {
        const tap = tapPose(t + a.phase);
        armL = tap.armL;
        armR = tap.armR;
      }
      a.arms[0].rotation.set(armL, yawL, 0);
      a.arms[1].rotation.set(armR, yawR, 0);
      a.headPivot.rotation.set(headPitch, headYaw, 0);
      if (a.mouth) a.mouth.scale.y = mouth;
      a.ring.scale.setScalar(ring);
      const blink = still ? 1 : blinkScale(t, a.phase);
      for (const eye of a.eyes) eye.scale.y = blink;

      // Topper motion (SPEC §8).
      if (still) {
        a.tip?.scale.setScalar(1);
        if (a.dish) a.dish.rotation.y = 0;
        if (a.leaves) a.leaves.rotation.z = 0;
        if (a.halo) a.halo.position.y = 0;
        for (const gm of a.glow) gm.mat.color.copy(gm.base);
        continue;
      }
      const talk = a.talking;
      let glow = 0;
      switch (a.spec.topper.kind) {
        case "antenna": {
          const k = wave(t + a.phase, talk ? 0.3 : 2);
          a.tip?.scale.setScalar(1 + 0.25 * k);
          glow = 0.35 * k;
          break;
        }
        case "dish":
          if (a.working && atDesk) {
            a.spin += (dt * TAU) / 2.2;
            if (a.dish) a.dish.rotation.y = a.spin;
          } else if (a.dish)
            a.dish.rotation.y =
              ((22 * Math.PI) / 180) * Math.sin((TAU * t) / 4);
          glow = talk ? 0.3 * wave(t, 0.4) : 0;
          break;
        case "sprout":
          if (a.leaves)
            a.leaves.rotation.z =
              ((6 * Math.PI) / 180) *
              Math.sin((TAU * t) / (walking ? 0.4 : 2.8));
          break;
        case "crest":
          glow = 0.45 * wave(t + a.phase, talk ? 0.35 : 2.4);
          break;
        case "propeller": {
          const period = walking ? 0.22 : talk || a.working ? 0.7 : 1.8;
          a.spin += (dt * TAU) / period;
          if (a.rotor) a.rotor.rotation.y = a.spin;
          break;
        }
        case "halo":
          if (a.halo)
            a.halo.position.y = 4 * PX * wave(t + a.phase, talk ? 0.6 : 2.4);
          glow = talk ? 0.3 * wave(t, 0.6) : 0;
          break;
        case "none":
          break;
      }
      for (const gm of a.glow) gm.mat.color.copy(gm.base).lerp(WHITE, glow);
    }
  }

  private readonly frame = (now: number) => {
    if (this.disposed || !this.active) return;
    this.raf = requestAnimationFrame(this.frame);
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, MAX_FRAME);
    const frameDt = dt;
    while (dt > 1e-6) {
      const h = Math.min(dt, MAX_STEP);
      this.step(h);
      dt -= h;
    }
    this.pose(frameDt);
    this.updateBeams();

    // Canvas animations, redrawn only when their step changes.
    const scan = Math.floor(this.wallT / (1.4 / 3));
    if (scan !== this.lastScan && !this.reduced) {
      this.lastScan = scan;
      this.drawMonitors(true);
    }
    const cursor = Math.floor(this.wallT / 0.5);
    if (cursor !== this.lastCursor && !this.reduced) {
      this.lastCursor = cursor;
      this.drawTerminal();
    }
    const flash = this.flashOn() ? 1 : 0;
    if (flash !== this.lastFlash) {
      this.lastFlash = flash;
      this.drawBoard();
    }

    if (this.camReset) {
      this.camera.position.lerp(this.homeCam, 0.08);
      this.controls.target.lerp(HOME_TARGET, 0.08);
      if (this.camera.position.distanceTo(this.homeCam) < 0.05)
        this.camReset = false;
    } else if (this.follow && this.focus) {
      const f = new THREE.Vector3();
      if (this.focus === "user") f.copy(TERM_POS);
      else if (this.focus === "board") f.copy(BOARD_SPOT);
      else f.copy(this.actors.get(this.focus)?.group.position ?? HOME_TARGET);
      f.lerp(HOME_TARGET, 0.55).setY(0.6);
      this.controls.target.lerp(f, Math.min(1, frameDt * 1.6));
    }
    // Camera drift: ±4° of azimuth over 16 s, off once the user drags or with reduced motion.
    const drift =
      this.dragged || this.reduced
        ? 0
        : DRIFT * Math.sin((TAU * this.wallT) / 32);
    if (drift !== this.drift) {
      const offset = new THREE.Vector3().subVectors(
        this.camera.position,
        this.controls.target,
      );
      offset.applyAxisAngle(UP, drift - this.drift);
      this.camera.position.copy(this.controls.target).add(offset);
      this.drift = drift;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.layoutOverlays();
  };

  private layoutOverlays() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const idle = !this.running && !this.queue.length && !this.current;
    for (const a of this.actors.values()) {
      const top = this.headPos(a);
      this.project(top.clone(), w, h, a.tag);
      const speaking = this.bubbles.some(
        (b) => b.from === a.profile.id && this.simT < b.kill,
      );
      a.tag.style.opacity = speaking ? "0" : "";
      const pinged = this.simT < a.pingUntil;
      a.ping.hidden = !pinged;
      a.typing.hidden = pinged || speaking || !(idle && a.working);
      if (!a.ping.hidden) this.project(top.clone(), w, h, a.ping);
      if (!a.typing.hidden) this.project(top.clone(), w, h, a.typing);
    }
    this.project(TERM_ANCHOR.clone().setY(1.95), w, h, this.youEl);
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i]!;
      const n =
        b.typeDur > 0
          ? Math.ceil(
              b.full.length * Math.min(1, (this.simT - b.born) / b.typeDur),
            )
          : b.full.length;
      if (b.text.textContent?.length !== n)
        b.text.textContent = b.full.slice(0, n);
      this.project(b.anchor(), w, h, b.el);
      if (this.simT > b.kill) {
        b.el.classList.add("is-leaving");
        if (this.simT > b.kill + 0.4) {
          b.el.remove();
          this.bubbles.splice(i, 1);
        }
      }
    }
  }

  /* ───────────── picking ───────────── */

  private downAt: [number, number] | null = null;
  onBotClick: ((botId: string) => void) | null = null;

  private readonly onPointerDown = (e: PointerEvent) => {
    this.downAt = [e.clientX, e.clientY];
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (
      !this.downAt ||
      Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > 5
    )
      return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      (-(e.clientY - r.top) / r.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(mouse, this.camera);
    const hit = ray.intersectObjects(this.pickables, false)[0];
    const id = hit?.object.userData.botId as string | undefined;
    if (id) {
      this.focus = id;
      this.onBotClick?.(id);
    }
  };
}

const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color("#FFFFFF");
