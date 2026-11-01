import type { Bot, TaskView } from "@jj/contracts";
import {
  type CSSProperties,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { spritePathsFor } from "../../components/sprite";
import {
  moodAnimates,
  moodForStatus,
  type StatusTone,
  statusTone,
} from "../../lib/status";
import {
  type Beat,
  BeatFeed,
  bubbleWho,
  type NameOf,
  sessionFor,
  workingBotIds,
} from "./beats";
import { Office2DEngine } from "./engine2d";
import {
  bubblePlacement,
  DESK_WIDTH,
  type Desk2D,
  type Layout2D,
  officeLayout2D,
  SCENE_WIDTH,
} from "./layout2d";
import { usePageActive } from "./motion";
import type { OfficeStatus, OfficeViewHandle } from "./playback";

export interface Office2DProps {
  view: TaskView;
  /** Participants in desk order. */
  bots: Bot[];
  beats: Beat[];
  paused: boolean;
  speed: number;
  reducedMotion: boolean;
  onStatus: (status: OfficeStatus) => void;
  ref?: Ref<OfficeViewHandle>;
}

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

/** Screen line colour per status tone (SPEC `--status-*-deep`). */
const DEEP: Readonly<Record<StatusTone, string>> = {
  running: "var(--status-running-deep)",
  verifying: "var(--status-verifying-deep)",
  completed: "var(--status-completed-deep)",
  failed: "var(--office-failed-deep)",
  idle: "var(--office-idle-deep)",
};

/**
 * Office 2D (SPEC §5.4, §9): the task acted out by pixel sprites in a 160-unit
 * SVG room. Desk monitors and sprite moods show real session statuses; bots
 * walk and speak only for beats that come from real task events.
 */
export function Office2D({
  view,
  bots,
  beats,
  paused,
  speed,
  reducedMotion,
  onStatus,
  ref,
}: Office2DProps) {
  const layout = useMemo(() => officeLayout2D(bots.length), [bots.length]);
  const botIds = useMemo(() => bots.map((b) => b.id), [bots]);
  const engineRef = useRef<Office2DEngine | null>(null);
  if (!engineRef.current)
    engineRef.current = new Office2DEngine(layout, botIds, { reducedMotion });
  const engine = engineRef.current;
  const [, setVersion] = useState(engine.version);
  const stageRef = useRef<HTMLDivElement>(null);
  const active = usePageActive(stageRef);
  const statusKey = useRef("");
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  // Reports playback progress to the controls, only when it changed.
  const report = useRef(() => {
    const s = engine.status();
    const next: OfficeStatus = { ...s, following: false };
    const key = JSON.stringify(next);
    if (key !== statusKey.current) {
      statusKey.current = key;
      onStatusRef.current(next);
    }
  }).current;

  useImperativeHandle(
    ref,
    () => ({
      replay: (all) => {
        engine.replay(all);
        setVersion(engine.version);
        report();
      },
    }),
    [engine, report],
  );

  useEffect(() => {
    engine.setBots(layout, botIds);
    setVersion(engine.version);
  }, [engine, layout, botIds]);

  useEffect(() => engine.setPaused(paused), [engine, paused]);
  useEffect(() => engine.setSpeed(speed), [engine, speed]);
  useEffect(() => {
    engine.setReducedMotion(reducedMotion);
    setVersion(engine.version);
  }, [engine, reducedMotion]);

  // New beats: replay the latest few on open, then act out live ones as they arrive.
  const feed = useRef(new BeatFeed()).current;
  useEffect(() => {
    const next = feed.next(beats);
    if (next.kind === "replay") engine.replay(next.beats);
    else engine.enqueue(next.beats);
    setVersion(engine.version);
    report();
  }, [engine, feed, beats, report]);

  // The clock: real elapsed time, paused while the tab is hidden or the stage offscreen.
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    let shown = engine.version;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      engine.advance(Math.min(now - last, 1000));
      last = now;
      if (engine.version !== shown) {
        shown = engine.version;
        setVersion(shown);
        report();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, active, report]);

  const frame = engine.frame();
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const nameOf: NameOf = (id) => byId.get(id)?.name ?? "A bot";
  const H = layout.height;
  const working = frame.idle ? workingBotIds(view) : [];
  const positions = new Map(frame.actors.map((a) => [a.id, a]));
  const beat = frame.holding ? frame.beat : null;

  let bubble: { left: number; top: number } | null = null;
  if (beat && beat.mode !== "announce") {
    const speaker = positions.get(beat.from);
    bubble =
      beat.from === "user"
        ? bubblePlacement("user", H)
        : speaker
          ? bubblePlacement(speaker, H)
          : { left: 0.02, top: 0.02 };
  }

  const at = (x: number, y: number): CSSProperties => ({
    left: pct(x / SCENE_WIDTH),
    top: pct(y / H),
  });

  return (
    <div
      ref={stageRef}
      className={`office-stage office-stage--2d${paused ? " is-frozen" : ""}`}
      style={{ aspectRatio: `${SCENE_WIDTH} / ${H}` }}
    >
      <svg
        className="office-2d"
        viewBox={`0 0 ${SCENE_WIDTH} ${H}`}
        shapeRendering="crispEdges"
        role="img"
        aria-label="Pixel office acting out the task conversation"
      >
        <Room layout={layout} />
        {layout.desks.map((desk) => {
          const bot = bots[desk.index];
          const session = bot ? sessionFor(view, bot.id) : undefined;
          return (
            <Desk
              key={desk.index}
              desk={desk}
              tone={bot ? (session ? statusTone(session) : "idle") : null}
            />
          );
        })}
        <Furniture />
        {[...frame.actors]
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((actor) => {
            const bot = byId.get(actor.id);
            if (!bot) return null;
            const session = sessionFor(view, bot.id);
            const mood = session ? moodForStatus(session) : "idle";
            const bob = moodAnimates(mood) && !reducedMotion;
            return (
              <g
                key={actor.id}
                transform={`translate(${actor.x} ${actor.y})`}
                data-bot={bot.name}
              >
                <rect
                  x={2}
                  y={11}
                  width={8}
                  height={1}
                  className="o2d-shadow"
                />
                <g className={bob ? "o2d-bob" : undefined}>
                  {spritePathsFor(bot.appearance, mood).map((p) => (
                    <path key={p.fill} fill={p.fill} d={p.d} />
                  ))}
                </g>
              </g>
            );
          })}
      </svg>

      <div className="office-overlays" aria-hidden="true">
        {frame.flash && (
          <span
            className="office-flash"
            style={{
              left: pct(6 / SCENE_WIDTH),
              top: pct(2 / H),
              width: pct(42 / SCENE_WIDTH),
              height: pct(12 / H),
            }}
          />
        )}
        <span className="office-board-label" style={at(30, 4.6)}>
          v{view.task.goalVersion}
        </span>
        <span className="office-you" style={at(151, 69.2)}>
          You
        </span>
        {frame.actors.map((actor) => {
          const bot = byId.get(actor.id);
          if (!bot) return null;
          const anchorX = actor.x + 6;
          const anchorY = Math.max(actor.y - 8, 0);
          return (
            <span key={actor.id}>
              <span
                className="office-tag office-tag--2d"
                style={at(anchorX, actor.y + 13)}
              >
                {bot.name}
              </span>
              {frame.pings.includes(actor.id) ? (
                <span className="office-ping" style={at(anchorX, anchorY)}>
                  !
                </span>
              ) : working.includes(actor.id) ? (
                <span className="office-typing" style={at(anchorX, anchorY)}>
                  <span />
                  <span />
                  <span />
                </span>
              ) : null}
            </span>
          );
        })}
        {frame.toast && <div className="office-toast">{frame.toast}</div>}
        {beat && bubble && (
          <div
            className="office-bubble office-bubble--2d"
            style={{ left: pct(bubble.left), top: pct(bubble.top) }}
          >
            <span className="office-bubble__who">
              {bubbleWho(beat, nameOf)}
            </span>
            <span className="office-bubble__text">{beat.text}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Wall, floor, whiteboard and plant (SPEC §9.1), drawn first. */
function Room({ layout }: { layout: Layout2D }) {
  const checkerId = useId();
  const H = layout.height;
  return (
    <g>
      <rect x={0} y={0} width={160} height={16} className="o2d-wall" />
      <rect x={0} y={15} width={160} height={1} className="o2d-wall-line" />
      <rect x={0} y={16} width={160} height={H - 16} className="o2d-floor" />
      <defs>
        <pattern
          id={checkerId}
          x={0}
          y={16}
          width={16}
          height={16}
          patternUnits="userSpaceOnUse"
        >
          <rect x={0} y={0} width={8} height={8} className="o2d-checker" />
          <rect x={8} y={8} width={8} height={8} className="o2d-checker" />
        </pattern>
      </defs>
      <rect
        x={0}
        y={16}
        width={160}
        height={H - 16}
        fill={`url(#${checkerId})`}
      />
      <rect x={6} y={2} width={42} height={12} className="o2d-board-frame" />
      <rect x={7} y={3} width={40} height={10} className="o2d-board-face" />
      <rect x={6} y={14} width={42} height={1} className="o2d-board-frame" />
      <rect x={9} y={5} width={18} height={1} fill="#8E8E98" />
      <rect x={9} y={7} width={12} height={1} fill="#B4B4BC" />
      <rect x={147} y={5} width={3} height={6} fill="#1E8A57" />
      <rect x={150} y={3} width={3} height={8} fill="#34D399" />
      <rect x={153} y={6} width={3} height={5} fill="#1E8A57" />
      <rect x={148} y={10} width={7} height={5} fill="#7A5A44" />
      <rect x={148} y={10} width={7} height={1} fill="#94705A" />
    </g>
  );
}

/**
 * One desk. `tone` is the occupant's status tone, or null for a free desk.
 * Back desks face the room with the monitor on top; front desks face the
 * wall, so the bot stands behind the desk and the monitor sits on it.
 */
function Desk({ desk, tone }: { desk: Desk2D; tone: StatusTone | null }) {
  const { x0, deskY: y } = desk;
  const w = DESK_WIDTH;
  const occupied = tone !== null;
  const screen = occupied ? `var(--status-${tone})` : undefined;
  const deep = occupied ? DEEP[tone] : undefined;
  if (desk.kind === "back") {
    return (
      <g data-desk={occupied ? "occupied" : "free"}>
        <rect
          x={x0 + 5}
          y={y - 8}
          width={12}
          height={7}
          className="o2d-bezel"
        />
        <rect
          x={x0 + 6}
          y={y - 7}
          width={10}
          height={5}
          className={occupied ? undefined : "o2d-screen-off"}
          style={screen ? { fill: screen } : undefined}
        />
        {occupied && (
          <>
            <rect
              x={x0 + 7}
              y={y - 6}
              width={5}
              height={1}
              style={{ fill: deep }}
            />
            <rect
              x={x0 + 7}
              y={y - 4}
              width={7}
              height={1}
              style={{ fill: deep }}
            />
          </>
        )}
        <rect
          x={x0 + 10}
          y={y - 1}
          width={2}
          height={1}
          className="o2d-bezel"
        />
        <rect
          x={x0}
          y={y}
          width={w}
          height={6}
          className={occupied ? "o2d-desk" : "o2d-desk-free"}
        />
        <rect
          x={x0}
          y={y}
          width={w}
          height={1}
          className={occupied ? "o2d-desk-hi" : "o2d-desk-free-hi"}
        />
        <rect x={x0} y={y + 6} width={w} height={1} className="o2d-desk-edge" />
        <rect
          x={x0 + 1}
          y={y + 7}
          width={1}
          height={3}
          className="o2d-desk-edge"
        />
        <rect
          x={x0 + 20}
          y={y + 7}
          width={1}
          height={3}
          className="o2d-desk-edge"
        />
      </g>
    );
  }
  return (
    <g data-desk={occupied ? "occupied" : "free"}>
      <rect x={x0 + 8} y={y - 5} width={6} height={3} className="o2d-chair" />
      <rect
        x={x0}
        y={y}
        width={w}
        height={6}
        className={occupied ? "o2d-desk" : "o2d-desk-free"}
      />
      <rect
        x={x0}
        y={y}
        width={w}
        height={1}
        className={occupied ? "o2d-desk-hi" : "o2d-desk-free-hi"}
      />
      {occupied ? (
        <>
          <rect
            x={x0 + 5}
            y={y + 1}
            width={12}
            height={4}
            className="o2d-bezel"
          />
          <rect
            x={x0 + 6}
            y={y + 2}
            width={10}
            height={2}
            style={{ fill: screen }}
          />
          <rect
            x={x0}
            y={y + 6}
            width={w}
            height={1}
            className="o2d-desk-edge"
          />
          <rect
            x={x0 + 1}
            y={y + 7}
            width={1}
            height={3}
            className="o2d-desk-edge"
          />
          <rect
            x={x0 + 20}
            y={y + 7}
            width={1}
            height={3}
            className="o2d-desk-edge"
          />
        </>
      ) : (
        <rect
          x={x0 + 5}
          y={y + 2}
          width={12}
          height={3}
          className="o2d-monitor-off"
        />
      )}
    </g>
  );
}

/** Table with stools and the user's terminal (SPEC §9.1). */
function Furniture() {
  return (
    <g>
      <rect x={60} y={54} width={4} height={4} className="o2d-stool" />
      <rect x={104} y={54} width={4} height={4} className="o2d-stool" />
      <rect x={76} y={45} width={4} height={3} className="o2d-stool" />
      <rect x={88} y={45} width={4} height={3} className="o2d-stool" />
      <rect x={76} y={64} width={4} height={3} className="o2d-stool" />
      <rect x={88} y={64} width={4} height={3} className="o2d-stool" />
      <rect x={66} y={49} width={36} height={13} className="o2d-table" />
      <rect x={66} y={49} width={36} height={1} className="o2d-table-hi" />
      <rect x={67} y={62} width={34} height={1} className="o2d-table-edge" />
      <rect x={146} y={44} width={10} height={22} className="o2d-term" />
      <rect x={147} y={46} width={8} height={7} className="o2d-term-screen" />
      <rect x={148} y={48} width={5} height={1} fill="#8E8E98" />
      <rect x={148} y={50} width={4} height={1} fill="#8E8E98" />
      <rect x={148} y={52} width={2} height={1} className="o2d-term-cursor" />
      <rect x={144} y={66} width={14} height={2} className="o2d-term-base" />
    </g>
  );
}
