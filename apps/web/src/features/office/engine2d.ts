/**
 * The Office 2D director: acts out beats on the pixel room. Pure and
 * deterministic (no DOM, no timers): the view calls `advance(ms)` with the
 * real elapsed time and renders `frame()`.
 *
 * Time progression is robust to low frame rates: one `advance` call may cover
 * any amount of time, and the director steps from event to event (arrivals,
 * the end of a hold, the gap between beats) inside it, so a 5 fps headless
 * browser plays as fast as a 60 fps one.
 *
 * It never invents state: statuses and moods come from the task view and are
 * drawn by the component; the director only moves bots and shows the speech
 * of beats that come from real task events.
 */

import { type Beat, beatHoldMs } from "./beats";
import {
  BOARD_SPOT,
  huddleSpot,
  type Layout2D,
  type Pt,
  route2D,
  TERMINAL_SPOT,
  visitSpot,
} from "./layout2d";

/** Walking speed at 1× (SPEC §9.3: 2 units per 80 ms tick). */
export const WALK_UNITS_PER_MS = 2 / 80;
/** Pause between beats at 1×. */
export const BEAT_GAP_MS = 450;
/** Idle time after the last beat before everyone walks back to their desk. */
export const HOME_AFTER_MS = 1500;

interface Actor {
  id: string;
  home: Pt;
  pos: Pt;
  path: Pt[];
}

type Phase =
  | { kind: "idle"; since: number; sentHome: boolean }
  | { kind: "walk" }
  | { kind: "hold"; until: number }
  | { kind: "gap"; until: number };

export interface Frame2DActor {
  id: string;
  /** Whole scene units, so sprites stay on the pixel grid. */
  x: number;
  y: number;
  walking: boolean;
}

export interface Frame2D {
  actors: Frame2DActor[];
  /** The beat being acted out, during its walk and hold. */
  beat: Beat | null;
  /** True while the beat's speech is up (after any walking). */
  holding: boolean;
  /** Bots showing the "!" ping. */
  pings: string[];
  flash: boolean;
  toast: string | null;
  /** 1-based number of the beat on stage, or the last one played. */
  step: number;
  total: number;
  idle: boolean;
}

export interface PlaybackStatus {
  step: number;
  total: number;
  currentId: string | null;
  replaying: boolean;
  pending: number;
}

export class Office2DEngine {
  private actors = new Map<string, Actor>();
  private queue: Beat[] = [];
  private current: Beat | null = null;
  private phase: Phase = { kind: "idle", since: 0, sentHome: true };
  private now = 0;
  private played = 0;
  private total = 0;
  private replaying = false;
  private paused = false;
  private speed = 1;
  private reducedMotion: boolean;
  private cached: Frame2D | null = null;
  /** Bumped whenever `frame()` would change; the view re-renders on a new version. */
  version = 0;

  constructor(
    layout: Layout2D,
    botIds: readonly string[],
    opts: { reducedMotion?: boolean } = {},
  ) {
    this.reducedMotion = opts.reducedMotion ?? false;
    this.setBots(layout, botIds);
  }

  /** Seat the bots at their desks: new bots appear at home, removed bots leave. */
  setBots(layout: Layout2D, botIds: readonly string[]): void {
    const next = new Map<string, Actor>();
    botIds.forEach((id, index) => {
      const desk = layout.desks[index];
      if (!desk) return;
      const existing = this.actors.get(id);
      if (existing) {
        const moved =
          existing.home.x !== desk.home.x || existing.home.y !== desk.home.y;
        existing.home = { ...desk.home };
        if (moved && !existing.path.length && this.phase.kind === "idle") {
          existing.pos = { ...desk.home };
        }
        next.set(id, existing);
      } else {
        next.set(id, {
          id,
          home: { ...desk.home },
          pos: { ...desk.home },
          path: [],
        });
      }
    });
    this.actors = next;
    this.touch();
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    if (on) for (const actor of this.actors.values()) this.snap(actor);
    this.touch();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  setSpeed(speed: number): void {
    this.speed = speed > 0 ? speed : 1;
  }

  /** Replay from the start: everyone back at their desk, then these beats in order. */
  replay(beats: readonly Beat[]): void {
    this.queue = [...beats];
    this.current = null;
    this.played = 0;
    this.total = beats.length;
    this.replaying = beats.length > 0;
    for (const actor of this.actors.values()) {
      actor.path = [];
      actor.pos = { ...actor.home };
    }
    this.phase = { kind: "idle", since: this.now, sentHome: true };
    this.startNext();
    this.touch();
  }

  /** Act out beats after anything already queued (live updates). */
  enqueue(beats: readonly Beat[]): void {
    if (!beats.length) return;
    this.queue.push(...beats);
    this.total += beats.length;
    if (this.phase.kind === "idle") this.startNext();
    this.touch();
  }

  status(): PlaybackStatus {
    return {
      step: this.played,
      total: this.total,
      currentId: this.current?.id ?? null,
      replaying: this.replaying,
      pending: this.queue.length + (this.current ? 1 : 0),
    };
  }

  /** Moves time forward by `ms` of wall-clock time (scaled by speed; nothing while paused). */
  advance(ms: number): void {
    if (this.paused || !(ms > 0)) return;
    let remaining = ms * this.speed;
    // Each pass reaches the next event (an arrival or a deadline) or uses up the time.
    for (let guard = 0; remaining > 1e-6 && guard < 10_000; guard += 1) {
      const step = Math.min(remaining, this.timeToNextEvent());
      this.move(step);
      this.now += step;
      remaining -= step;
      this.resolve();
    }
  }

  frame(): Frame2D {
    if (this.cached) return this.cached;
    const holding = this.phase.kind === "hold";
    const beat = this.current;
    const mode = beat?.mode;
    const pings =
      holding && beat
        ? mode === "announce"
          ? [...this.actors.keys()]
          : mode === "user"
            ? beat.to.filter((id) => this.actors.has(id))
            : []
        : [];
    this.cached = {
      actors: [...this.actors.values()].map((a) => ({
        id: a.id,
        x: Math.round(a.pos.x),
        y: Math.round(a.pos.y),
        walking: a.path.length > 0,
      })),
      beat,
      holding,
      pings,
      flash: holding && (mode === "announce" || mode === "board"),
      toast: holding && mode === "announce" && beat ? beat.text : null,
      step: this.played,
      total: this.total,
      idle: this.phase.kind === "idle",
    };
    return this.cached;
  }

  /** Where a bot stands right now (unrounded), for tests and overlays. */
  positionOf(id: string): Pt | undefined {
    const actor = this.actors.get(id);
    return actor ? { ...actor.pos } : undefined;
  }

  /* ───────────── internals ───────────── */

  private touch() {
    this.cached = null;
    this.version += 1;
  }

  private snap(actor: Actor) {
    const end = actor.path.at(-1);
    if (end) actor.pos = { ...end };
    actor.path = [];
  }

  private walk(actor: Actor, to: Pt) {
    actor.path = route2D(actor.pos, to);
    if (this.reducedMotion) this.snap(actor);
  }

  private timeToNextEvent(): number {
    let next = Number.POSITIVE_INFINITY;
    for (const actor of this.actors.values()) {
      const target = actor.path[0];
      if (!target) continue;
      const dist =
        Math.abs(target.x - actor.pos.x) + Math.abs(target.y - actor.pos.y);
      next = Math.min(next, dist / WALK_UNITS_PER_MS);
    }
    const phase = this.phase;
    if (phase.kind === "hold" || phase.kind === "gap")
      next = Math.min(next, phase.until - this.now);
    else if (phase.kind === "idle" && !phase.sentHome)
      next = Math.min(next, phase.since + HOME_AFTER_MS - this.now);
    return Math.max(next, 0);
  }

  private move(ms: number) {
    for (const actor of this.actors.values()) {
      if (!actor.path.length) continue;
      let budget = Math.max(0, ms) * WALK_UNITS_PER_MS;
      const before = `${Math.round(actor.pos.x)},${Math.round(actor.pos.y)}`;
      while (actor.path.length) {
        const target = actor.path[0] as Pt;
        const dx = target.x - actor.pos.x;
        const dy = target.y - actor.pos.y;
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist <= budget + 1e-6) {
          actor.pos = { ...target };
          actor.path.shift();
          budget = Math.max(0, budget - dist);
          if (!actor.path.length) this.touch();
          continue;
        }
        // Segments are axis-aligned: move along whichever axis differs.
        actor.pos =
          dx !== 0
            ? { x: actor.pos.x + Math.sign(dx) * budget, y: actor.pos.y }
            : { x: actor.pos.x, y: actor.pos.y + Math.sign(dy) * budget };
        break;
      }
      const after = `${Math.round(actor.pos.x)},${Math.round(actor.pos.y)}`;
      if (before !== after) this.touch();
    }
  }

  private walking(): boolean {
    for (const actor of this.actors.values())
      if (actor.path.length) return true;
    return false;
  }

  private resolve() {
    const phase = this.phase;
    const eps = 1e-6;
    if (phase.kind === "walk" && !this.walking()) {
      const beat = this.current;
      this.phase = {
        kind: "hold",
        until: this.now + (beat ? beatHoldMs(beat) : 0),
      };
      this.touch();
    } else if (phase.kind === "hold" && this.now >= phase.until - eps) {
      this.phase = { kind: "gap", until: this.now + BEAT_GAP_MS };
      this.touch();
    } else if (phase.kind === "gap" && this.now >= phase.until - eps) {
      this.current = null;
      this.phase = { kind: "idle", since: this.now, sentHome: false };
      this.startNext();
      this.touch();
    } else if (
      phase.kind === "idle" &&
      !phase.sentHome &&
      this.now >= phase.since + HOME_AFTER_MS - eps
    ) {
      phase.sentHome = true;
      if (this.replaying) this.replaying = false;
      for (const actor of this.actors.values()) this.walk(actor, actor.home);
      this.touch();
    }
  }

  private startNext() {
    const beat = this.queue.shift();
    if (!beat) {
      if (this.phase.kind === "idle" && this.phase.sentHome && this.replaying)
        this.replaying = false;
      return;
    }
    this.current = beat;
    this.played += 1;
    this.stage(beat);
    this.phase = { kind: "walk" };
    this.resolve();
  }

  /** Sends everyone where the beat needs them (SPEC §9.4 choreography). */
  private stage(beat: Beat) {
    const speaker = this.actors.get(beat.from);
    const involved = new Set([beat.from, ...beat.to]);
    for (const actor of this.actors.values()) {
      if (involved.has(actor.id)) continue;
      const atHome =
        actor.pos.x === actor.home.x && actor.pos.y === actor.home.y;
      const headingHome = actor.path.at(-1);
      const homeBound =
        headingHome?.x === actor.home.x && headingHome?.y === actor.home.y;
      if (!atHome && !homeBound) this.walk(actor, actor.home);
    }
    if (!speaker) return;
    switch (beat.mode) {
      case "huddle": {
        const group = [
          speaker,
          ...beat.to.map((id) => this.actors.get(id)),
        ].filter((a): a is Actor => !!a);
        group.forEach((actor, index) => this.walk(actor, huddleSpot(index)));
        return;
      }
      case "board":
        this.walk(speaker, BOARD_SPOT);
        return;
      case "terminal":
        this.walk(speaker, TERMINAL_SPOT);
        return;
      case "visit": {
        const target = this.actors.get(beat.to[0] ?? "");
        if (target) this.walk(speaker, visitSpot(target.pos, speaker.pos));
        return;
      }
      default:
        return;
    }
  }
}
