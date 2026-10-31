/**
 * Imperative Three.js scene for the task "office" view.
 *
 * Bots in a task get a desk; each desk monitor shows that bot's real session
 * status, the whiteboard shows the task's goal, version and sessions, and
 * task messages are acted out as "beats" (walking, facing, speech bubbles and
 * beams). The scene never invents state: statuses only come from `sync()`.
 */

import type { Bot, ExecutionSession, TaskView } from "@jj/contracts";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { faceGlyph } from "../../../lib/appearance";
import { colourRamp } from "../../../lib/colour";
import { statusWord } from "../../../lib/status";
import { orderedSessions, sessionOrdinal } from "../../../lib/tasks";
import type { Beat } from "./beats";

export interface OfficeStatus {
  /** Beats waiting to be acted out (including the one in progress). */
  pending: number;
  paused: boolean;
  replaying: boolean;
  /** Camera is following the speaker (dragging the view turns this off). */
  following: boolean;
}

type Place = "desk" | "table" | "board" | "terminal" | "visiting";

interface CanvasTex {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
}

interface Desk {
  screen: CanvasTex;
  spot: THREE.Vector3;
  face: THREE.Vector3;
  fwd: THREE.Vector3;
  phase: number;
  botId: string | null;
}

interface Actor {
  profile: Bot;
  /** Fill colour from the bot's appearance. */
  color: string;
  group: THREE.Group;
  headPivot: THREE.Group;
  face: THREE.Mesh;
  arms: THREE.Mesh[];
  glow: THREE.MeshStandardMaterial;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  desk: Desk;
  tag: HTMLDivElement;
  path: THREE.Vector3[];
  finalFace: THREE.Vector3 | null;
  lookAt: THREE.Vector3 | null;
  onArrive: (() => void) | null;
  yaw: number;
  targetYaw: number;
  talking: boolean;
  walkPhase: number;
  at: Place;
  pingUntil: number;
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
  text: HTMLDivElement;
  from: string;
  full: string;
  born: number;
  typeDur: number;
  kill: number;
  anchor: () => THREE.Vector3;
}

export const STATUS_COLORS: Record<string, string> = {
  queued: "#8c8c85",
  running: "#2563eb",
  waiting: "#d97706",
  completed: "#10b981",
  failed: "#e11d48",
  cancelled: "#71716b",
  idle: "#b5b5ad",
};

export const statusColor = (status: string | undefined): string =>
  STATUS_COLORS[status ?? "idle"] ?? "#b5b5ad";

const THEMES = {
  light: {
    bg: 0xf7f7f5,
    floor: 0xecebe5,
    wall: 0xf4f3ef,
    wallEdge: 0xdedcd3,
    desk: 0xd8cfbd,
    leg: 0x575753,
    rug: 0xe2e0d7,
    table: 0xfbfbf9,
    white: 0xf6f6f2,
    window: 0xcfe0ee,
    hemi: 1.15,
    sun: 1.9,
  },
  dark: {
    bg: 0x0f0f0e,
    floor: 0x1c1c1a,
    wall: 0x242422,
    wallEdge: 0x30302c,
    desk: 0x3a352d,
    leg: 0x8c8c85,
    rug: 0x262623,
    table: 0x2f2f2b,
    white: 0xd8d8d2,
    window: 0x1d2b3a,
    hemi: 0.55,
    sun: 0.9,
  },
} as const;

const FONT = `-apple-system, "Inter", "Segoe UI", Roboto, sans-serif`;
const MONO = `"SF Mono", "JetBrains Mono", Menlo, monospace`;
const TABLE = new THREE.Vector3(0, 0, 0.6);
const OBSTACLE_R = 1.95;
const RING_R = 2.2;
const HOME_CAM = new THREE.Vector3(15, 15.5, 17);
const HOME_TARGET = new THREE.Vector3(-0.5, 0.6, -0.4);
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
const TERM_SPOT = new THREE.Vector3(6.2, 0, 3.4);
const TERM_ANCHOR = new THREE.Vector3(7.7, 2.75, 3.4);

export function glyphSvg(glyph: string, c: string): string {
  switch (glyph) {
    case "visor":
      return `<rect x="7" y="11" width="18" height="8" rx="4" fill="${c}"/><circle cx="12.5" cy="15" r="1.6" fill="#fff"/><circle cx="19.5" cy="15" r="1.6" fill="#fff"/>`;
    case "radar":
      return `<circle cx="12" cy="16" r="4" stroke="${c}" stroke-width="2" fill="none"/><circle cx="20" cy="16" r="4" stroke="${c}" stroke-width="2" fill="none"/><circle cx="12" cy="16" r="1.4" fill="${c}"/><circle cx="20" cy="16" r="1.4" fill="${c}"/><path d="M13 9 Q16 6 19 9" stroke="${c}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`;
    case "pixel":
      return `<rect x="8" y="10" width="16" height="12" rx="2.5" stroke="${c}" stroke-width="2" fill="none"/><rect x="11.5" y="14" width="2.8" height="2.8" fill="${c}"/><rect x="17.7" y="14" width="2.8" height="2.8" fill="${c}"/>`;
    case "prism":
      return `<polygon points="16,7 25,16 16,25 7,16" stroke="${c}" stroke-width="2" fill="none" stroke-linejoin="round"/><circle cx="13.5" cy="15.5" r="1.5" fill="${c}"/><circle cx="18.5" cy="15.5" r="1.5" fill="${c}"/>`;
    default:
      return `<path d="M8 16 Q12 10 16 16 T24 16" stroke="${c}" stroke-width="2.2" fill="none" stroke-linecap="round"/><circle cx="12" cy="12" r="1.5" fill="${c}"/><circle cx="20" cy="12" r="1.5" fill="${c}"/>`;
  }
}

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

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/)) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

function rrect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function angleLerp(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** The session that best represents a bot right now: the latest active one, else the latest. */
function sessionFor(
  view: TaskView,
  botId: string,
): ExecutionSession | undefined {
  const mine = orderedSessions(view).filter((s) => s.botId === botId);
  const active = mine.filter((s) =>
    ["queued", "running", "waiting"].includes(s.status),
  );
  return active.at(-1) ?? mine.at(-1);
}

export class OfficeScene {
  private readonly host: HTMLElement;
  private readonly overlay: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);
  private readonly controls: OrbitControls;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly mats: Record<string, THREE.MeshStandardMaterial>;
  private readonly desks: Desk[];
  private readonly board = canvasTex(1024, 576);
  private readonly term = canvasTex(512, 320);
  private readonly termScreen: THREE.Mesh;
  private readonly actors = new Map<string, Actor>();
  private readonly pickables: THREE.Object3D[] = [];
  private readonly beams: Beam[] = [];
  private readonly bubbles: Bubble[] = [];
  private readonly waiters: { t: number; res: () => void }[] = [];
  private readonly resizeObs: ResizeObserver;
  private readonly onStatus: (s: OfficeStatus) => void;

  private task: TaskView | null = null;
  private queue: Beat[] = [];
  private running = false;
  private runToken = 0;
  private paused = false;
  private replaying = false;
  private speed = 1;
  private follow = true;
  private focus: string | null = null;
  private camReset = false;
  /** Home camera position, pulled back for narrow panes so the whole room fits. */
  private readonly homeCam = HOME_CAM.clone();
  private framed = false;
  private simT = 0;
  private wallT = 0;
  private lastMonitor = 0;
  private boardFlash = 0;
  private termPulse = 0;
  private termText = "Waiting for you…";
  private raf = 0;
  private lastFrame = performance.now();
  private disposed = false;

  constructor(
    host: HTMLElement,
    opts: { onStatus: (s: OfficeStatus) => void; theme: "light" | "dark" },
  ) {
    this.host = host;
    this.onStatus = opts.onStatus;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "office-canvas";
    host.appendChild(this.renderer.domElement);

    this.overlay = document.createElement("div");
    this.overlay.className = "office-overlay";
    host.appendChild(this.overlay);
    this.toastEl = document.createElement("div");
    this.toastEl.className = "office-toast";
    host.appendChild(this.toastEl);

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
      this.camReset = false;
      this.emit();
    });

    this.hemi = new THREE.HemisphereLight(0xffffff, 0xd8d4c8, 1.15);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.9);
    this.sun.position.set(8, 16, 9);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, {
      left: -14,
      right: 14,
      top: 14,
      bottom: -14,
      near: 1,
      far: 50,
    });
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun);

    const std = (p: THREE.MeshStandardMaterialParameters) =>
      new THREE.MeshStandardMaterial(p);
    this.mats = {
      floor: std({ roughness: 0.95 }),
      wall: std({ roughness: 0.9 }),
      wallEdge: std({ roughness: 0.8 }),
      desk: std({ roughness: 0.7 }),
      leg: std({ roughness: 0.5, metalness: 0.3 }),
      rug: std({ roughness: 1 }),
      table: std({ roughness: 0.5 }),
      white: std({ roughness: 0.45 }),
      window: std({
        roughness: 0.2,
        emissive: 0x9fc3e0,
        emissiveIntensity: 0.25,
      }),
      dark: std({ color: 0x1b1b1a, roughness: 0.4 }),
      plant: std({ color: 0x5e9e6e, roughness: 0.8 }),
      pot: std({ color: 0xc9b9a3, roughness: 0.8 }),
    };

    this.buildRoom();
    this.desks = DESK_SLOTS.map((slot) => this.buildDesk(slot));
    this.termScreen = this.buildTerminal();
    this.buildBoard();
    this.setTheme(opts.theme);

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

  /** Reconcile with the latest task view + bots. Safe to call on every update. */
  sync(task: TaskView, participants: Bot[]) {
    this.task = task;
    const wanted = participants.slice(0, MAX_DESKS);
    for (const [id, actor] of this.actors) {
      if (!wanted.some((b) => b.id === id)) this.removeActor(actor);
    }
    for (const bot of wanted) {
      const existing = this.actors.get(bot.id);
      if (existing) {
        existing.profile = bot;
        existing.color = colourRamp(bot.appearance.colour).f;
      } else {
        const desk = this.desks.find((d) => d.botId === null);
        if (desk) this.addActor(bot, desk);
      }
    }
    const lastUser = [...task.messages]
      .reverse()
      .find((m) => m.authorKind === "user");
    if (lastUser && !this.termPulse) this.termText = lastUser.text;
    for (const actor of this.actors.values()) {
      const s = sessionFor(task, actor.profile.id);
      actor.ring.material.color.set(statusColor(s?.status));
      actor.tag.querySelector(".office-tag-status")!.textContent = s
        ? `${sessionOrdinal(task, s.id)} ${statusWord(s.status)}`
        : "no session";
      (
        actor.tag.querySelector(".office-tag-status") as HTMLElement
      ).style.background = statusColor(s?.status);
    }
    this.drawBoard();
    this.drawTerminal();
    this.drawMonitors();
  }

  /** Act out beats after anything already queued (live updates). */
  enqueue(beats: Beat[]) {
    if (!beats.length) return;
    this.queue.push(...beats);
    this.emit();
    void this.pump();
  }

  /** Replay a transcript from the start. Statuses stay at their current, real values. */
  replay(beats: Beat[]) {
    this.reset();
    this.replaying = beats.length > 0;
    this.enqueue(beats);
    this.emit();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.emit();
  }

  setSpeed(speed: number) {
    this.speed = speed;
  }

  setFollow(on: boolean) {
    this.follow = on;
    this.emit();
  }

  resetView() {
    this.camReset = true;
  }

  setTheme(theme: "light" | "dark") {
    const p = THEMES[theme];
    this.scene.background = new THREE.Color(p.bg);
    const m = this.mats;
    m.floor!.color.set(p.floor);
    m.wall!.color.set(p.wall);
    m.wallEdge!.color.set(p.wallEdge);
    m.desk!.color.set(p.desk);
    m.leg!.color.set(p.leg);
    m.rug!.color.set(p.rug);
    m.table!.color.set(p.table);
    m.white!.color.set(p.white);
    m.window!.color.set(p.window);
    this.hemi.intensity = p.hemi;
    this.sun.intensity = p.sun;
  }

  dispose() {
    this.disposed = true;
    this.runToken++;
    this.flushWaiters();
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as
        | THREE.Material
        | THREE.Material[]
        | undefined;
      for (const mm of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        const map = (mm as THREE.MeshBasicMaterial).map;
        if (map) map.dispose();
        mm.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
    this.toastEl.remove();
  }

  /* ───────────── building ───────────── */

  private mesh(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
    parent: THREE.Object3D = this.scene,
    cast = true,
  ) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = cast;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  private buildRoom() {
    const m = this.mats as Record<string, THREE.MeshStandardMaterial>;
    const B = (w: number, h: number, d: number) =>
      new THREE.BoxGeometry(w, h, d);
    this.mesh(B(18, 0.3, 14), m.floor!, 0, -0.15, 0, this.scene, false);
    this.mesh(B(18.4, 3.4, 0.25), m.wall!, 0, 1.7, -7.12);
    this.mesh(B(0.25, 3.4, 14), m.wall!, -9.12, 1.7, 0);
    this.mesh(B(18.4, 0.12, 0.3), m.wallEdge!, 0, 3.4, -7.12);
    this.mesh(B(0.3, 0.12, 14), m.wallEdge!, -9.12, 3.4, 0);
    for (const x of [-4.2, 0, 4.2])
      this.mesh(
        B(2.6, 1.1, 0.05),
        m.window!,
        x,
        2.55,
        -6.98,
        this.scene,
        false,
      );
    this.mesh(
      new THREE.CylinderGeometry(3.1, 3.1, 0.02, 64),
      m.rug!,
      TABLE.x,
      0.01,
      TABLE.z,
      this.scene,
      false,
    );
    this.mesh(
      new THREE.CylinderGeometry(1.15, 1.15, 0.08, 48),
      m.table!,
      TABLE.x,
      0.78,
      TABLE.z,
    );
    this.mesh(
      new THREE.CylinderGeometry(0.12, 0.35, 0.74, 20),
      m.leg!,
      TABLE.x,
      0.37,
      TABLE.z,
    );
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
      this.mesh(
        new THREE.CylinderGeometry(0.22, 0.2, 0.42, 20),
        m.desk!,
        TABLE.x + Math.cos(a) * 1.6,
        0.21,
        TABLE.z + Math.sin(a) * 1.6,
      );
    }
    const plant = (x: number, z: number, s: number) => {
      this.mesh(
        new THREE.CylinderGeometry(0.3 * s, 0.24 * s, 0.5 * s, 16),
        m.pot!,
        x,
        0.25 * s,
        z,
      );
      for (let k = 0; k < 5; k++) {
        const leaf = this.mesh(
          new THREE.SphereGeometry(0.32 * s, 10, 8),
          m.plant!,
          x + Math.cos(k * 1.3) * 0.18 * s,
          (0.75 + k * 0.12) * s,
          z + Math.sin(k * 1.3) * 0.18 * s,
        );
        leaf.scale.y = 1.3;
      }
    };
    plant(-8.3, -6.3, 1.2);
    plant(8.3, -6.3, 1);
    plant(-8.3, 6.2, 0.9);
    this.mesh(B(0.9, 0.9, 0.7), m.desk!, -8.4, 0.45, 4.6);
    this.mesh(B(0.45, 0.5, 0.4), m.dark!, -8.45, 1.15, 4.6);
  }

  private buildDesk(slot: { x: number; z: number; rot: number }): Desk {
    const m = this.mats as Record<string, THREE.MeshStandardMaterial>;
    const g = new THREE.Group();
    g.position.set(slot.x, 0, slot.z);
    g.rotation.y = slot.rot;
    this.scene.add(g);
    this.mesh(new THREE.BoxGeometry(2.5, 0.08, 1.15), m.desk!, 0, 0.76, 0, g);
    for (const [lx, lz] of [
      [-1.15, -0.48],
      [1.15, -0.48],
      [-1.15, 0.48],
      [1.15, 0.48],
    ] as const) {
      this.mesh(
        new THREE.BoxGeometry(0.06, 0.74, 0.06),
        m.leg!,
        lx,
        0.37,
        lz,
        g,
      );
    }
    this.mesh(
      new THREE.BoxGeometry(0.08, 0.35, 0.08),
      m.leg!,
      0,
      0.97,
      -0.32,
      g,
    );
    this.mesh(
      new THREE.BoxGeometry(0.4, 0.03, 0.25),
      m.leg!,
      0,
      0.81,
      -0.32,
      g,
    );
    this.mesh(
      new THREE.BoxGeometry(1.25, 0.76, 0.06),
      m.dark!,
      0,
      1.42,
      -0.34,
      g,
    );
    this.mesh(
      new THREE.BoxGeometry(0.7, 0.03, 0.22),
      m.white!,
      0,
      0.815,
      0.12,
      g,
    );
    this.mesh(
      new THREE.CylinderGeometry(0.07, 0.06, 0.14, 14),
      m.white!,
      0.85,
      0.87,
      0.1,
      g,
    );
    const screen = canvasTex(384, 224);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 0.67),
      new THREE.MeshBasicMaterial({ map: screen.tex }),
    );
    plane.position.set(0, 1.42, -0.305);
    g.add(plane);
    const fwd = new THREE.Vector3(Math.sin(slot.rot), 0, Math.cos(slot.rot));
    return {
      screen,
      spot: new THREE.Vector3(slot.x, 0, slot.z).addScaledVector(fwd, 1.05),
      face: new THREE.Vector3(slot.x, 0, slot.z),
      fwd,
      phase: Math.random() * 10,
      botId: null,
    };
  }

  private buildBoard() {
    const g = new THREE.Group();
    g.position.set(-8.97, 1.75, 0.6);
    g.rotation.y = Math.PI / 2;
    this.scene.add(g);
    this.mesh(
      new THREE.BoxGeometry(3.9, 2.25, 0.06),
      this.mats.leg!,
      0,
      0,
      -0.02,
      g,
    );
    const p = new THREE.Mesh(
      new THREE.PlaneGeometry(3.75, 2.1),
      new THREE.MeshBasicMaterial({ map: this.board.tex }),
    );
    p.position.z = 0.015;
    g.add(p);
  }

  private buildTerminal() {
    const g = new THREE.Group();
    g.position.copy(TERM_POS);
    g.rotation.y = -Math.PI / 2;
    this.scene.add(g);
    this.mesh(
      new THREE.CylinderGeometry(0.55, 0.65, 0.25, 32),
      this.mats.leg!,
      0,
      0.12,
      0,
      g,
    );
    this.mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 1.2, 12),
      this.mats.leg!,
      0,
      0.8,
      0,
      g,
    );
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(2.0, 1.25),
      new THREE.MeshBasicMaterial({
        map: this.term.tex,
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    screen.position.set(0, 2.05, 0);
    g.add(screen);
    return screen;
  }

  private addActor(bot: Bot, desk: Desk) {
    desk.botId = bot.id;
    const m = this.mats as Record<string, THREE.MeshStandardMaterial>;
    const g = new THREE.Group();
    this.scene.add(g);
    const color = colourRamp(bot.appearance.colour).f;
    const col = new THREE.Color(color);
    const accent = new THREE.MeshStandardMaterial({
      color: col,
      roughness: 0.45,
    });
    const glow = new THREE.MeshStandardMaterial({
      color: col,
      emissive: col,
      emissiveIntensity: 0.6,
    });
    this.mesh(
      new THREE.CapsuleGeometry(0.32, 0.42, 6, 18),
      m.white!,
      0,
      0.62,
      0,
      g,
    );
    const belt = this.mesh(
      new THREE.TorusGeometry(0.325, 0.045, 8, 32),
      accent,
      0,
      0.6,
      0,
      g,
    );
    belt.rotation.x = Math.PI / 2;
    const headPivot = new THREE.Group();
    headPivot.position.y = 1.36;
    g.add(headPivot);
    this.mesh(
      new RoundedBoxGeometry(0.74, 0.58, 0.62, 4, 0.16),
      m.white!,
      0,
      0,
      0,
      headPivot,
    );

    const fc = canvasTex(256, 192);
    fc.ctx.fillStyle = "#141413";
    rrect(fc.ctx, 0, 0, 256, 192, 46);
    fc.ctx.fill();
    const img = new Image();
    img.onload = () => {
      fc.ctx.drawImage(img, 32, 0, 192, 192);
      fc.tex.needsUpdate = true;
    };
    const bright = `#${col.clone().lerp(new THREE.Color(0xffffff), 0.15).getHexString()}`;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${glyphSvg(faceGlyph(bot.appearance.face), bright)}</svg>`)}`;
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.45),
      new THREE.MeshBasicMaterial({ map: fc.tex, transparent: true }),
    );
    face.position.z = 0.315;
    headPivot.add(face);
    for (const s of [-1, 1]) {
      const ear = this.mesh(
        new THREE.CylinderGeometry(0.09, 0.09, 0.06, 16),
        accent,
        s * 0.39,
        0,
        0,
        headPivot,
      );
      ear.rotation.z = Math.PI / 2;
    }
    this.mesh(
      new THREE.CylinderGeometry(0.018, 0.018, 0.22, 8),
      m.leg!,
      0,
      0.4,
      0,
      headPivot,
    );
    this.mesh(
      new THREE.SphereGeometry(0.065, 16, 12),
      glow,
      0,
      0.53,
      0,
      headPivot,
    );
    const arms = [-1, 1].map((s) => {
      const arm = this.mesh(
        new THREE.CapsuleGeometry(0.07, 0.28, 4, 10),
        accent,
        s * 0.42,
        0.68,
        0,
        g,
      );
      arm.rotation.z = s * 0.18;
      return arm;
    });
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.46, 0.56, 48),
      new THREE.MeshBasicMaterial({
        color: statusColor("idle"),
        transparent: true,
        opacity: 0.9,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;
    g.add(ring);

    const tag = document.createElement("div");
    tag.className = "office-tag";
    const dot = document.createElement("span");
    dot.className = "office-dot";
    dot.style.background = color;
    const name = document.createElement("span");
    name.textContent = bot.name;
    const status = document.createElement("span");
    status.className = "office-tag-status";
    const ping = document.createElement("span");
    ping.className = "office-ping";
    ping.textContent = "!";
    tag.append(dot, name, status, ping);
    this.overlay.appendChild(tag);

    const yaw = Math.atan2(
      desk.face.x - desk.spot.x,
      desk.face.z - desk.spot.z,
    );
    g.position.copy(desk.spot);
    g.rotation.y = yaw;
    const actor: Actor = {
      profile: bot,
      color,
      group: g,
      headPivot,
      face,
      arms,
      glow,
      ring,
      desk,
      tag,
      path: [],
      finalFace: null,
      lookAt: null,
      onArrive: null,
      yaw,
      targetYaw: yaw,
      talking: false,
      walkPhase: 0,
      at: "desk",
      pingUntil: 0,
    };
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.userData.botId = bot.id;
        this.pickables.push(o);
      }
    });
    this.actors.set(bot.id, actor);
  }

  private removeActor(actor: Actor) {
    this.scene.remove(actor.group);
    actor.tag.remove();
    actor.desk.botId = null;
    actor.onArrive?.();
    for (let i = this.pickables.length - 1; i >= 0; i--) {
      if (this.pickables[i]?.userData.botId === actor.profile.id)
        this.pickables.splice(i, 1);
    }
    this.actors.delete(actor.profile.id);
  }

  /* ───────────── drawing ───────────── */

  private drawBoard() {
    const { ctx, canvas, tex } = this.board;
    const view = this.task;
    const task = view?.task;
    ctx.fillStyle = "#fbfbf9";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (this.boardFlash > 0) {
      ctx.fillStyle = `rgba(217,119,6,${0.18 * this.boardFlash})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (!view || !task) {
      tex.needsUpdate = true;
      return;
    }
    ctx.fillStyle = "#8c8c85";
    ctx.font = `600 22px ${FONT}`;
    ctx.fillText("SESSIONS", 44, 58);
    const chip = `goal v${task.goalVersion}`;
    ctx.font = `600 22px ${MONO}`;
    const cw = ctx.measureText(chip).width + 24;
    ctx.fillStyle = task.goalVersion > 1 ? "#d97706" : "#e3e3dc";
    rrect(ctx, canvas.width - 44 - cw, 34, cw, 36, 9);
    ctx.fill();
    ctx.fillStyle = task.goalVersion > 1 ? "#fff" : "#575753";
    ctx.fillText(chip, canvas.width - 32 - cw, 60);
    ctx.fillStyle = "#141413";
    ctx.font = `700 36px ${FONT}`;
    let y = 108;
    for (const l of wrapText(ctx, task.goal, canvas.width - 88).slice(0, 2)) {
      ctx.fillText(l, 44, y);
      y += 44;
    }
    ctx.strokeStyle = "#e4e4de";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(44, y - 10);
    ctx.lineTo(canvas.width - 44, y - 10);
    ctx.stroke();
    y += 22;
    const sessions = orderedSessions(view);
    if (!sessions.length) {
      ctx.font = `400 26px ${FONT}`;
      ctx.fillStyle = "#8c8c85";
      ctx.fillText("No sessions yet", 44, y + 30);
    }
    for (const session of sessions.slice(0, 5)) {
      ctx.fillStyle = STATUS_COLORS[session.status] ?? "#c9c9c0";
      rrect(ctx, 44, y + 12, 34, 34, 8);
      ctx.fill();
      ctx.fillStyle = "#141413";
      ctx.font = `500 26px ${FONT}`;
      const name = this.actors.get(session.botId)?.profile.name ?? "Bot";
      ctx.fillText(
        `${sessionOrdinal(view, session.id)} · ${name} · ${statusWord(session.status)}`,
        94,
        y + 38,
      );
      y += 54;
    }
    ctx.fillStyle = STATUS_COLORS[task.status] ?? "#8c8c85";
    ctx.beginPath();
    ctx.arc(52, canvas.height - 42, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#575753";
    ctx.font = `600 22px ${MONO}`;
    ctx.fillText(
      `TASK ${statusWord(task.status).toUpperCase()}`,
      70,
      canvas.height - 34,
    );
    tex.needsUpdate = true;
  }

  private drawTerminal() {
    const { ctx, canvas, tex } = this.term;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(20,20,19,0.92)";
    rrect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 26);
    ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,${0.18 + this.termPulse * 0.6})`;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `700 34px ${FONT}`;
    ctx.fillText("You", 34, 66);
    ctx.fillStyle = this.termPulse > 0.05 ? "#10b981" : "#6e6e67";
    ctx.beginPath();
    ctx.arc(canvas.width - 44, 54, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#a2a29a";
    ctx.font = `500 25px ${FONT}`;
    let y = 116;
    for (const l of wrapText(ctx, this.termText, canvas.width - 68).slice(
      0,
      6,
    )) {
      ctx.fillText(l, 34, y);
      y += 33;
    }
    tex.needsUpdate = true;
  }

  private drawMonitors() {
    for (const desk of this.desks) {
      const { ctx, canvas, tex } = desk.screen;
      ctx.fillStyle = "#121211";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const actor = desk.botId ? this.actors.get(desk.botId) : undefined;
      if (!actor || !this.task) {
        tex.needsUpdate = true;
        continue;
      }
      const sess = sessionFor(this.task, actor.profile.id);
      const st = sess?.status ?? "idle";
      ctx.fillStyle = actor.color;
      ctx.fillRect(0, 0, canvas.width, 8);
      ctx.fillStyle = "#f2f2ee";
      ctx.font = `700 26px ${FONT}`;
      ctx.fillText(actor.profile.name, 20, 46);
      ctx.fillStyle = "#8c8c85";
      ctx.font = `500 18px ${MONO}`;
      ctx.fillText(
        sess
          ? `${sessionOrdinal(this.task, sess.id)} · ${sess.role}`
          : "no session",
        20,
        74,
      );
      const active = st === "running";
      const off = active ? Math.floor(this.wallT * 3) : 0;
      for (let i = 0; i < 6; i++) {
        const r =
          Math.abs(Math.sin((i + off) * 12.9898 + desk.phase) * 43758.5453) % 1;
        ctx.fillStyle =
          i === 5 && active ? (STATUS_COLORS[st] ?? "#2d2d29") : "#2d2d29";
        rrect(ctx, 20 + (r > 0.7 ? 24 : 0), 92 + i * 14, 60 + r * 230, 7, 3);
        ctx.fill();
      }
      ctx.fillStyle = STATUS_COLORS[st] ?? "#8c8c85";
      rrect(ctx, 20, 182, 14, 14, 7);
      ctx.fill();
      ctx.font = `700 18px ${MONO}`;
      ctx.fillText(
        (sess ? statusWord(sess.status) : st).toUpperCase(),
        42,
        195,
      );
      tex.needsUpdate = true;
    }
  }

  /* ───────────── choreography ───────────── */

  private emit() {
    this.onStatus({
      pending: this.queue.length,
      paused: this.paused,
      replaying: this.replaying,
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
    this.flushWaiters();
    for (const b of this.bubbles.splice(0)) b.el.remove();
    for (const b of this.beams.splice(0)) this.disposeBeam(b);
    for (const a of this.actors.values()) {
      a.path = [];
      a.onArrive?.();
      a.group.position.copy(a.desk.spot);
      a.yaw = a.targetYaw = Math.atan2(
        a.desk.face.x - a.desk.spot.x,
        a.desk.face.z - a.desk.spot.z,
      );
      a.at = "desk";
      a.talking = false;
      a.lookAt = null;
    }
    this.focus = null;
    this.replaying = false;
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    const token = this.runToken;
    while (this.queue.length && token === this.runToken && !this.disposed) {
      const beat = this.queue[0]!;
      await this.perform(beat, token);
      if (token !== this.runToken) return;
      this.queue.shift();
      this.emit();
      await this.wait(450);
    }
    if (token !== this.runToken) return;
    this.running = false;
    if (this.replaying) {
      this.replaying = false;
      this.emit();
    }
    await this.wait(1500);
    if (token === this.runToken && !this.queue.length) {
      for (const a of this.actors.values())
        if (a.at !== "desk") void this.goHome(a);
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
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
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
    const ang = -Math.PI / 2 - Math.PI / 5 + (i / n) * Math.PI * 2;
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
    const dur = THREE.MathUtils.clamp(1600 + beat.text.length * 42, 2200, 6500);
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
      this.toast(beat.text);
      this.boardFlash = 1;
      for (const a of this.actors.values()) a.pingUntil = this.simT + 2.4;
      this.focus = "board";
      await this.wait(2400);
      return;
    }

    if (beat.mode === "user" || !S) {
      this.focus = "user";
      this.termText = beat.text;
      this.termPulse = 1;
      this.drawTerminal();
      for (const a of T) {
        a.lookAt = TERM_POS.clone();
        this.addBeam(
          () => TERM_ANCHOR.clone().setY(2.1),
          () => this.headPos(a),
          0x141413,
          dur,
        );
      }
      this.showBubble(
        "user",
        "You",
        "var(--ink)",
        beat.text,
        beat.intent,
        dur,
        () => TERM_ANCHOR.clone(),
      );
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
    for (const a of T) {
      a.lookAt = S.group.position.clone();
      this.addBeam(
        () => this.headPos(S),
        () => this.headPos(a),
        new THREE.Color(S.color).getHex(),
        dur,
      );
    }
    if (beat.mode === "terminal") {
      this.addBeam(
        () => this.headPos(S),
        () => TERM_ANCHOR.clone().setY(2.1),
        new THREE.Color(S.color).getHex(),
        dur,
      );
      this.termPulse = 1;
    }
    if (beat.mode === "board") this.boardFlash = 0.6;
    this.showBubble(
      S.profile.id,
      S.profile.name,
      S.color,
      beat.text,
      beat.intent,
      dur,
      () => this.headPos(S).add(new THREE.Vector3(0, 0.55, 0)),
    );
    await this.wait(dur);
    S.talking = false;
  }

  /* ───────────── fx ───────────── */

  private headPos(a: Actor) {
    return a.group.position.clone().add(new THREE.Vector3(0, 1.45, 0));
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
        new THREE.SphereGeometry(0.07, 12, 8),
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
    name: string,
    color: string,
    text: string,
    intent: string,
    durMs: number,
    anchor: () => THREE.Vector3,
  ) {
    for (const b of this.bubbles) if (b.from === from) b.kill = this.simT;
    const el = document.createElement("div");
    el.className = "office-bubble";
    el.style.setProperty("--c", color);
    const who = document.createElement("div");
    who.className = "office-bubble-who";
    who.textContent = name;
    const tag = document.createElement("span");
    tag.className = "office-intent";
    tag.textContent = intent;
    who.appendChild(tag);
    const body = document.createElement("div");
    el.append(who, body);
    this.overlay.appendChild(el);
    const dur = durMs / 1000;
    this.bubbles.push({
      el,
      text: body,
      from,
      full: text,
      born: this.simT,
      typeDur: Math.min(dur * 0.45, 2.2),
      kill: this.simT + dur + 1.4,
      anchor,
    });
  }

  private toast(text: string) {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    window.setTimeout(
      () => this.toastEl.classList.remove("show"),
      2600 / this.speed,
    );
  }

  private project(v: THREE.Vector3, w: number, h: number, el: HTMLElement) {
    const p = v.project(this.camera);
    el.style.left = `${((p.x + 1) / 2) * w}px`;
    el.style.top = `${((1 - p.y) / 2) * h}px`;
    el.style.display = p.z > 1 ? "none" : "";
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

  private readonly frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
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
        const step = 2.6 * sdt;
        if (dist <= step) {
          g.position.set(target.x, 0, target.z);
          a.path.shift();
        } else {
          g.position.addScaledVector(d.normalize(), step);
          a.targetYaw = Math.atan2(d.x, d.z);
        }
        a.walkPhase += sdt * 11;
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
      }
      a.yaw = angleLerp(a.yaw, a.targetYaw, Math.min(1, dt * 9));
      g.rotation.y = a.yaw;
      const walking = a.path.length > 0 && !this.paused;
      g.position.y = walking
        ? Math.abs(Math.sin(a.walkPhase)) * 0.08
        : Math.sin(this.wallT * 2 + a.desk.phase) * 0.02;
      g.rotation.z = walking ? Math.sin(a.walkPhase) * 0.05 : 0;
      const swing = walking
        ? Math.sin(a.walkPhase) * 0.6
        : a.talking
          ? Math.sin(this.wallT * 7) * 0.25
          : 0;
      a.arms[0]!.rotation.x = -swing;
      a.arms[1]!.rotation.x = swing;
      a.headPivot.rotation.x = a.talking ? Math.sin(this.wallT * 9) * 0.06 : 0;
      a.headPivot.rotation.y = a.talking
        ? Math.sin(this.wallT * 2.3) * 0.12
        : 0;
      a.face.scale.y = a.talking
        ? 1 + Math.abs(Math.sin(this.wallT * 14)) * 0.08
        : Math.sin(this.wallT * 0.9 + a.desk.phase * 3) > 0.985
          ? 0.25
          : 1;
      a.glow.emissiveIntensity = a.talking
        ? 1.4 + Math.sin(this.wallT * 12)
        : 0.5;
      a.ring.scale.setScalar(
        a.talking ? 1 + Math.sin(this.wallT * 6) * 0.08 : 1,
      );
      a.tag.classList.toggle("ping", this.simT < a.pingUntil);
    }

    if (this.termPulse > 0) {
      this.termPulse = Math.max(0, this.termPulse - dt * 0.5);
      if (Math.floor(this.wallT * 10) % 2 === 0) this.drawTerminal();
    }
    if (this.boardFlash > 0) {
      this.boardFlash = Math.max(0, this.boardFlash - dt * 0.8);
      this.drawBoard();
    }
    this.termScreen.position.y = 2.05 + Math.sin(this.wallT * 1.6) * 0.04;
    if (this.wallT - this.lastMonitor > 0.25) {
      this.lastMonitor = this.wallT;
      this.drawMonitors();
    }
    this.updateBeams();

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
      this.controls.target.lerp(f, dt * 1.6);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    for (const a of this.actors.values()) {
      this.project(
        this.headPos(a).add(new THREE.Vector3(0, 0.62, 0)),
        w,
        h,
        a.tag,
      );
      const speaking = this.bubbles.some(
        (b) => b.from === a.profile.id && this.simT < b.kill,
      );
      a.tag.style.opacity = speaking ? "0" : "";
    }
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i]!;
      const n = Math.ceil(
        b.full.length * Math.min(1, (this.simT - b.born) / b.typeDur),
      );
      if (b.text.textContent?.length !== n)
        b.text.textContent = b.full.slice(0, n);
      this.project(b.anchor(), w, h, b.el);
      if (this.simT > b.kill) {
        b.el.classList.add("fade");
        if (this.simT > b.kill + 0.4) {
          b.el.remove();
          this.bubbles.splice(i, 1);
        }
      }
    }
  };

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
