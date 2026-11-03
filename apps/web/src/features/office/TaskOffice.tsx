import type { Bot, TaskView } from "@jj/contracts";
import {
  Component,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApi } from "../../api/ApiContext";
import { PixelIcon } from "../../components/sprite";
import {
  Badge,
  Button,
  buttonClass,
  Icon,
  IconButton,
  Segmented,
  StatusTag,
} from "../../components/ui";
import { NARROW_QUERY, useMediaQuery } from "../../lib/media";
import { describeStatus } from "../../lib/status";
import { sessionLine, sessionOrdinal } from "../../lib/tasks";
import { useTheme } from "../../lib/theme";
import { supportsWebGL } from "../../lib/webgl";
import { useWorkspace } from "../../state/WorkspaceContext";
import {
  beatLabel,
  deskOrder,
  type NameOf,
  nowLabel,
  sessionFor,
  taskBeats,
  workingBotIds,
} from "./beats";
import { useReducedMotion } from "./motion";
import { Office2D } from "./Office2D";
import {
  IDLE_STATUS,
  nextSpeed,
  type OfficeMode,
  type OfficeStatus,
  type OfficeViewHandle,
  readOfficeMode,
  type Speed,
  writeOfficeMode,
} from "./playback";
import "./office.css";

// Three.js is large: the 3D view downloads only when someone switches to it.
// React keeps a failed lazy load, so a failed chunk makes a new one: the
// next switch to 3D asks the network again instead of failing until reload.
const load3d = () =>
  import("./Office3D").catch((error: unknown) => {
    Office3D = lazy(load3d);
    throw error;
  });
let Office3D = lazy(load3d);

/** Desks the 3D room has (OfficeScene `MAX_DESKS`); kept here so 2D never loads Three.js. */
const DESKS_3D = 6;

/**
 * Why 3D is not offered here, shown under the switch; null when it is. A
 * phone-width screen gets 2D (the 3D room needs the width, and Three.js is a
 * large download), and so does a browser without WebGL, which is asked only
 * on a wider screen. A remembered 3D choice is kept for a screen that can
 * show it.
 */
export function no3dReason(
  narrow: boolean,
  webgl: () => boolean,
): string | null {
  if (narrow)
    return "3D needs a wider screen. The 2D office shows the same task.";
  if (!webgl())
    return "3D needs WebGL, which this browser does not offer. The 2D office shows the same task.";
  return null;
}

/**
 * Keeps a 3D office that fails to start (WebGL lost or refused, or its chunk
 * not arriving) from taking the Tasks screen down: it says so in the stage
 * and offers the 2D office.
 */
class Office3DBoundary extends Component<
  { onShow2d: () => void; children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        className="office-stage office-stage--3d office-stage--loading office-stage--failed"
        role="status"
      >
        <span>The 3D office could not start: {error.message}</span>
        <Button onClick={this.props.onShow2d}>Show the 2D office</Button>
      </div>
    );
  }
}

export interface TaskOfficeProps {
  view: TaskView;
  getBot: (id: string) => Bot | undefined;
  /**
   * Optional: content for the start of the header row, such as the panel's
   * Progress | Graph | Office tabs, so they share a row with the 2D/3D switch
   * as in the design.
   */
  headerStart?: ReactNode;
  /** Optional: the view to open when no choice is remembered. Default "2d". */
  defaultMode?: OfficeMode;
}

/**
 * The task "office" (SPEC §5.4, §5.5): the task's events acted out in a pixel
 * room (2D) or a Three.js room (3D). Desk monitors and moods always show real
 * session statuses; movement and speech come only from real task events. Mount
 * with `key={task.id}` so each task gets a fresh scene.
 */
export function TaskOffice({
  view,
  getBot,
  headerStart,
  defaultMode = "2d",
}: TaskOfficeProps) {
  const api = useApi();
  const { taskStreamState } = useWorkspace();
  const { resolved: theme } = useTheme();
  const reducedMotion = useReducedMotion();
  const { task } = view;
  const [chosen, setModeState] = useState<OfficeMode>(() =>
    readOfficeMode(defaultMode),
  );
  const narrow = useMediaQuery(NARROW_QUERY);
  const no3d = no3dReason(narrow, supportsWebGL);
  const mode: OfficeMode = no3d ? "2d" : chosen;
  const noteId = useId();
  const [status, setStatus] = useState<OfficeStatus>(IDLE_STATUS);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [pickedBotId, setPickedBotId] = useState<string | null>(null);
  const inspectId = useId();
  const viewRef = useRef<OfficeViewHandle | null>(null);

  // Another view on screen, chosen or because the screen narrowed: it starts
  // from a clean status and nobody picked, before it renders.
  const [shown, setShown] = useState(mode);
  if (shown !== mode) {
    setShown(mode);
    setStatus(IDLE_STATUS);
    setPickedBotId(null);
  }

  const setMode = (next: OfficeMode) => {
    setModeState(next);
    writeOfficeMode(next);
  };

  const bots = useMemo(
    () =>
      deskOrder(
        task,
        task.participantBotIds
          .map((id) => getBot(id))
          .filter((b): b is Bot => !!b),
      ),
    [task, getBot],
  );
  const beats = useMemo(() => taskBeats(view, bots), [view, bots]);
  const nameOf: NameOf = useCallback(
    (id) => bots.find((b) => b.id === id)?.name ?? getBot(id)?.name ?? "A bot",
    [bots, getBot],
  );

  // "live" only for a real, connected event stream; never for demo data.
  const demo = api.mode === "demo";
  const live =
    api.mode === "live" &&
    api.capabilities.streaming &&
    taskStreamState === "open";
  const chip = demo
    ? {
        text: status.replaying ? "Demo data · replaying" : "Demo data",
        tone: undefined,
        title: "Demo data: the task and its events are simulated",
      }
    : status.replaying
      ? {
          text: "replaying",
          tone: "idle" as const,
          title:
            "Replaying the transcript; desks and monitors show current statuses",
        }
      : live
        ? {
            text: "live",
            tone: "completed" as const,
            title: "Connected to the task's event stream",
          }
        : {
            text: "not live",
            tone: "idle" as const,
            title: "Not connected to the task's event stream",
          };

  const current = status.currentId
    ? beats.find((b) => b.id === status.currentId)
    : undefined;
  const working = workingBotIds(view).map(nameOf);
  const label = current
    ? beatLabel(current, nameOf)
    : beats.length || working.length
      ? nowLabel(task, working)
      : "No messages yet";
  const hidden = mode === "3d" ? Math.max(0, bots.length - DESKS_3D) : 0;

  const picked = pickedBotId
    ? bots.find((b) => b.id === pickedBotId)
    : undefined;
  const pickedSession = picked ? sessionFor(view, picked.id) : undefined;

  const viewProps = {
    view,
    bots,
    beats,
    paused,
    speed,
    reducedMotion,
    onStatus: setStatus,
    ref: viewRef,
  };

  return (
    <section className="office" aria-label="Office">
      <div className="office__head">
        {headerStart}
        <div className="office__head-end">
          {hidden > 0 && (
            <Badge title="The 3D room has six desks; the 2D view shows everyone">
              +{hidden} not shown
            </Badge>
          )}
          <Segmented
            variant="mono"
            label="Office view"
            value={mode}
            onChange={setMode}
            describedBy={no3d ? noteId : undefined}
            options={[
              { value: "2d", label: "2D" },
              { value: "3d", label: "3D", disabled: no3d !== null },
            ]}
          />
          <Badge tone={chip.tone} title={chip.title}>
            {chip.text}
          </Badge>
        </div>
      </div>
      {no3d && (
        <p id={noteId} className="office__note">
          {no3d}
        </p>
      )}

      <div className="office__stage-wrap">
        {mode === "2d" ? (
          <Office2D {...viewProps} />
        ) : (
          <Office3DBoundary onShow2d={() => setMode("2d")}>
            <Suspense
              fallback={
                <div className="office-stage office-stage--3d office-stage--loading">
                  <span>Loading 3D office…</span>
                </div>
              }
            >
              <Office3D
                {...viewProps}
                theme={theme}
                onPick={(id) => setPickedBotId(id)}
              />
            </Suspense>
          </Office3DBoundary>
        )}
        {mode === "3d" && (
          <div className="office__camera">
            <Button
              size="sm"
              mono
              pressed={status.following}
              title="Camera follows whoever is speaking"
              onClick={() => viewRef.current?.setFollow?.(!status.following)}
            >
              follow
            </Button>
            <Button
              size="sm"
              mono
              onClick={() => viewRef.current?.resetView?.()}
            >
              reset view
            </Button>
            {/* The keyboard path to the inspect card, which a click on a bot opens. */}
            <label className="visually-hidden" htmlFor={inspectId}>
              Inspect a bot
            </label>
            <select
              id={inspectId}
              className={buttonClass({ size: "sm", mono: true })}
              value={pickedBotId ?? ""}
              onChange={(event) => setPickedBotId(event.target.value || null)}
            >
              <option value="">inspect…</option>
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {mode === "3d" && picked && (
          <section
            className="office-card"
            aria-label={`${picked.name} details`}
          >
            <div className="office-card__head">
              <span className="office-card__name">
                {picked.name}
                {picked.role && (
                  <span className="office-card__role"> · {picked.role}</span>
                )}
              </span>
              <IconButton
                label="Close details"
                icon={<Icon name="close" />}
                onClick={() => setPickedBotId(null)}
              />
            </div>
            {pickedSession ? (
              <>
                <StatusTag
                  status={pickedSession}
                  detail={sessionOrdinal(view, pickedSession.id)}
                />
                <p className="office-card__brief">{pickedSession.brief}</p>
                <p className="office-card__now">{sessionLine(pickedSession)}</p>
              </>
            ) : (
              <p className="office-card__now">No session in this task yet.</p>
            )}
          </section>
        )}
      </div>

      <div className="office__controls">
        <div className="office__step">
          {status.total > 0 && (
            <Badge variant="step">
              {status.step} / {status.total}
            </Badge>
          )}
          <span className="office__label">{label}</span>
        </div>
        <div className="office__buttons">
          <Button
            title="Replay the whole transcript from the desks"
            disabled={!beats.length}
            onClick={() => {
              setPaused(false);
              viewRef.current?.replay(beats);
            }}
          >
            Replay
          </Button>
          <IconButton
            variant="primary"
            label={paused ? "Play" : "Pause"}
            icon={<PixelIcon name={paused ? "play" : "pause"} size={12} />}
            onClick={() => setPaused((p) => !p)}
          />
          <Button
            mono
            className="office__speed"
            aria-label={`Playback speed ${speed}×`}
            onClick={() => setSpeed((s) => nextSpeed(s))}
          >
            {speed}×
          </Button>
        </div>
      </div>

      <div className="office__legend">
        <span>monitors</span>
        <span className="office__swatch" data-tone="running">
          working
        </span>
        <span className="office__swatch" data-tone="completed">
          done
        </span>
        <span className="office__swatch" data-tone="failed">
          failed
        </span>
        <span className="office__swatch" data-tone="idle">
          idle
        </span>
        <span className="office__swatch" data-tone="free">
          free desk
        </span>
      </div>

      <ul className="visually-hidden" aria-label="Desks">
        {bots.map((bot) => {
          const session = sessionFor(view, bot.id);
          return (
            <li key={bot.id}>
              {bot.name}:{" "}
              {session ? describeStatus(session).word : "no session"}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
