import { useEffect, useMemo, useRef, useState } from "react";
import type { BotProfile, TaskView } from "../../../api/types";
import { StatusDot } from "../../common/StatusDot";
import { messageToBeat } from "./beats";
import "./office.css";
import { MAX_DESKS, OfficeScene, type OfficeStatus } from "./OfficeScene";

/** How many recent messages to act out when the office first opens. */
const INTRO_MESSAGES = 4;
const SPEEDS = [0.5, 1, 1.6, 2.5];

const currentTheme = (): "light" | "dark" =>
  document.documentElement.dataset.theme === "dark" ? "dark" : "light";

/**
 * 3D "office" view of a task. Mount with `key={task.id}` so each task gets a
 * fresh scene. New task messages are acted out live as they stream in.
 */
export function TaskOffice({
  task,
  getBot,
}: {
  task: TaskView;
  getBot: (id: string) => BotProfile | undefined;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const seenRef = useRef<Set<string> | null>(null);
  const [status, setStatus] = useState<OfficeStatus>({
    pending: 0,
    paused: false,
    replaying: false,
    following: true,
  });
  const [speed, setSpeed] = useState(1);
  const [pickedBotId, setPickedBotId] = useState<string | null>(null);

  const participants = useMemo(
    () =>
      task.participantBotIds
        .map((id) => getBot(id))
        .filter((b): b is BotProfile => !!b),
    [task.participantBotIds, getBot],
  );
  const hidden = Math.max(0, participants.length - MAX_DESKS);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new OfficeScene(host, {
      onStatus: setStatus,
      theme: currentTheme(),
    });
    scene.onBotClick = setPickedBotId;
    sceneRef.current = scene;
    const observer = new MutationObserver(() => scene.setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      observer.disconnect();
      scene.dispose();
      sceneRef.current = null;
      seenRef.current = null;
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.sync(task, participants);
    const toBeat = (m: TaskView["messages"][number]) =>
      messageToBeat(m, task, participants);

    if (!seenRef.current) {
      seenRef.current = new Set(task.messages.map((m) => m.id));
      scene.replay(task.messages.slice(-INTRO_MESSAGES).map(toBeat));
      return;
    }
    const seen = seenRef.current;
    const fresh = task.messages.filter((m) => !seen.has(m.id));
    for (const m of fresh) seen.add(m.id);
    scene.enqueue(fresh.map(toBeat));
  }, [task, participants]);

  const replayAll = () =>
    sceneRef.current?.replay(
      task.messages.map((m) => messageToBeat(m, task, participants)),
    );
  const picked = pickedBotId ? getBot(pickedBotId) : undefined;
  const pickedSession = pickedBotId
    ? task.sessions.filter((s) => s.botId === pickedBotId).at(-1)
    : undefined;

  return (
    <div className="office-wrap">
      <div ref={hostRef} className="office-host" />

      <div className="office-status">
        {status.replaying ? (
          <span
            className="office-chip"
            title="Animation only: desks, rings and the board always show current task state"
          >
            Replaying transcript · statuses are live
          </span>
        ) : (
          <span className="office-chip">
            <span className="office-live" /> Live
            {status.pending > 0 ? ` · ${status.pending} queued` : ""}
          </span>
        )}
        {hidden > 0 && (
          <span className="office-chip">+{hidden} bots not shown</span>
        )}
      </div>

      {picked && (
        <div className="office-card">
          <div className="office-card-head">
            <strong>{picked.name}</strong>
            <button
              type="button"
              className="office-card-close"
              aria-label="Close"
              onClick={() => setPickedBotId(null)}
            >
              ×
            </button>
          </div>
          <div className="muted-small">{picked.role}</div>
          {pickedSession ? (
            <>
              <div className="office-card-row">
                <StatusDot status={pickedSession.status} />
                <span className="mono-muted">
                  {pickedSession.label} · {pickedSession.status}
                </span>
              </div>
              <div className="office-card-text">{pickedSession.brief}</div>
              {pickedSession.evidence && (
                <div className="office-card-text">
                  <strong>Evidence:</strong> {pickedSession.evidence}
                </div>
              )}
            </>
          ) : (
            <div className="office-card-text">No session in this task yet.</div>
          )}
        </div>
      )}

      <div className="office-controls">
        <button
          type="button"
          className="office-btn"
          title="Replay the whole transcript"
          disabled={!task.messages.length}
          onClick={replayAll}
        >
          ⟲ Replay
        </button>
        <button
          type="button"
          className="office-btn primary"
          title={status.paused ? "Resume" : "Pause"}
          onClick={() => sceneRef.current?.setPaused(!status.paused)}
        >
          {status.paused ? "▶" : "❚❚"}
        </button>
        <select
          className="office-btn"
          value={speed}
          aria-label="Speed"
          onChange={(e) => {
            const next = Number(e.target.value);
            setSpeed(next);
            sceneRef.current?.setSpeed(next);
          }}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`office-btn ${status.following ? "on" : ""}`}
          title="Camera follows whoever is speaking"
          onClick={() => sceneRef.current?.setFollow(!status.following)}
        >
          Follow
        </button>
        <button
          type="button"
          className="office-btn"
          onClick={() => {
            sceneRef.current?.resetView();
            sceneRef.current?.setFollow(true);
          }}
        >
          Reset view
        </button>
      </div>
    </div>
  );
}
