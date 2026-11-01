import type { TaskView } from "@jj/contracts";
import { useState } from "react";
import { useApi } from "../../api/ApiContext";
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  ErrorBanner,
  StatusTag,
} from "../../components/ui";
import { isStoppable } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import { ScreenHeader } from "../shell/ScreenHeader";
import { usageDetail, usageLine } from "./format";
import {
  botName,
  headingFor,
  participantMood,
  participantsLabel,
} from "./taskModel";

/**
 * The task header (SPEC §5.2): title, status · goal version and the current
 * goal on the left; participants, usage and Stop on the right.
 */
export function TaskHeader({ view }: { view: TaskView }) {
  const api = useApi();
  const { getBot, taskStreamState } = useWorkspace();
  const { task, usage } = view;
  const { heading, goal } = headingFor(task);
  // Say so while the live event stream is down, instead of looking current.
  const reconnecting =
    api.mode === "live" && taskStreamState === "reconnecting";

  return (
    <ScreenHeader
      lead={
        <div className="task-head">
          <h1 className="screen-title task-head__title clamp2" title={heading}>
            {heading}
          </h1>
          <span className="task-head__meta">
            <StatusTag
              size="lg"
              status={task}
              detail={`v${task.goalVersion}`}
            />
            {reconnecting && (
              <span
                className="task-head__stream"
                role="status"
                title="The live event stream dropped; reconnecting and catching up from the last event."
              >
                reconnecting…
              </span>
            )}
          </span>
          {goal && (
            <p className="task-head__goal clamp2" title={goal}>
              <span className="task-head__goal-label">
                goal v{task.goalVersion}
              </span>{" "}
              {goal}
            </p>
          )}
        </div>
      }
      actions={
        <>
          <span
            className="task-head__bots"
            role="img"
            aria-label={participantsLabel(task, getBot)}
          >
            {task.participantBotIds.map((botId) => {
              const bot = getBot(botId);
              return (
                <span key={botId} title={botName(bot)}>
                  <Avatar
                    appearance={bot?.appearance}
                    name={botName(bot)}
                    mood={participantMood(view, botId)}
                    size={24}
                    decorative
                  />
                </span>
              );
            })}
          </span>
          <Badge title={usageDetail(usage.total)}>
            <span className="visually-hidden">Usage: </span>
            {usageLine(usage.total)}
          </Badge>
          <StopControl view={view} />
        </>
      }
    />
  );
}

/** The Stop pill and its confirmation. Disabled once stopping or finished. */
function StopControl({ view }: { view: TaskView }) {
  const { stopTask } = useWorkspace();
  const { task } = view;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const stoppable = isStoppable(task);
  const stopping =
    Boolean(task.cancelRequestedAt) && task.status !== "cancelled";

  const close = () => {
    if (busy) return;
    setConfirming(false);
    setFailure(null);
  };
  const stop = async () => {
    setBusy(true);
    setFailure(null);
    const result = await stopTask(task.id);
    setBusy(false);
    if (result.ok) setConfirming(false);
    else setFailure(result.error.message);
  };

  return (
    <>
      <Button
        variant="danger"
        disabled={!stoppable}
        title={
          stoppable
            ? "Stop every session in this task"
            : stopping
              ? "The task is stopping"
              : "The task has finished"
        }
        onClick={() => setConfirming(true)}
      >
        {stopping ? "Stopping…" : "Stop"}
      </Button>
      <Dialog
        open={confirming}
        onClose={close}
        title="Stop this task?"
        description="Running sessions are interrupted and queued ones never start. A stopped task can't be continued."
        width={440}
        footer={
          <>
            <Button onClick={close} disabled={busy}>
              Keep running
            </Button>
            <Button
              variant="danger"
              onClick={() => void stop()}
              disabled={busy}
            >
              {busy ? "Stopping…" : "Stop task"}
            </Button>
          </>
        }
      >
        {failure && <ErrorBanner word="Not stopped">{failure}</ErrorBanner>}
      </Dialog>
    </>
  );
}
