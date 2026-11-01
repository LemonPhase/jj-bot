import type { Bot, TaskView } from "@jj/contracts";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import { type Beat, BeatFeed } from "./beats";
import { usePageActive } from "./motion";
import { OfficeScene, type OfficeTheme } from "./OfficeScene";
import type { OfficeStatus, OfficeViewHandle } from "./playback";

export interface Office3DProps {
  view: TaskView;
  /** Participants in desk order; the first `MAX_DESKS` get a desk. */
  bots: Bot[];
  beats: Beat[];
  paused: boolean;
  speed: number;
  theme: OfficeTheme;
  reducedMotion: boolean;
  onStatus: (status: OfficeStatus) => void;
  onPick: (botId: string) => void;
  ref?: Ref<OfficeViewHandle>;
}

/**
 * Office 3D (SPEC §5.5): the Three.js `OfficeScene` on a 3:2 stage. This
 * module is loaded lazily so Three.js only downloads when someone opens 3D.
 */
export default function Office3D({
  view,
  bots,
  beats,
  paused,
  speed,
  theme,
  reducedMotion,
  onStatus,
  onPick,
  ref,
}: Office3DProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const feedRef = useRef<BeatFeed | null>(null);
  const active = usePageActive(stageRef);
  const latest = useRef({
    onStatus,
    onPick,
    theme,
    reducedMotion,
    paused,
    speed,
  });
  latest.current = { onStatus, onPick, theme, reducedMotion, paused, speed };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const initial = latest.current;
    const scene = new OfficeScene(host, {
      onStatus: (s) => latest.current.onStatus(s),
      theme: initial.theme,
      reducedMotion: initial.reducedMotion,
    });
    scene.setPaused(initial.paused);
    scene.setSpeed(initial.speed);
    scene.onBotClick = (id) => latest.current.onPick(id);
    sceneRef.current = scene;
    feedRef.current = new BeatFeed();
    return () => {
      scene.dispose();
      sceneRef.current = null;
      feedRef.current = null;
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      replay: (all) => sceneRef.current?.replay(all),
      setFollow: (on) => sceneRef.current?.setFollow(on),
      resetView: () => sceneRef.current?.resetView(),
    }),
    [],
  );

  useEffect(() => sceneRef.current?.setTheme(theme), [theme]);
  useEffect(() => sceneRef.current?.setPaused(paused), [paused]);
  useEffect(() => sceneRef.current?.setSpeed(speed), [speed]);
  useEffect(
    () => sceneRef.current?.setReducedMotion(reducedMotion),
    [reducedMotion],
  );
  useEffect(() => sceneRef.current?.setActive(active), [active]);

  useEffect(() => {
    const scene = sceneRef.current;
    const feed = feedRef.current;
    if (!scene || !feed) return;
    scene.sync(view, bots);
    const next = feed.next(beats);
    if (next.kind === "replay") scene.replay(next.beats);
    else scene.enqueue(next.beats);
  }, [view, bots, beats]);

  return (
    <div
      ref={stageRef}
      className="office-stage office-stage--3d"
      role="img"
      aria-label="3D office acting out the task conversation"
    >
      <div ref={hostRef} className="office-host" />
    </div>
  );
}
