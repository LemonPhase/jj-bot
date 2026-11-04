import type { Schedule } from "@jj/contracts";
import { useEffect, useId, useState } from "react";
import { Button, Icon, IconButton, SectionLabel } from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { taskHref } from "../shell/router";
import { useShell } from "../shell/ShellContext";
import {
  formatRun,
  outcomeLine,
  pausedLine,
  schedulerStale,
} from "./scheduleModel";
import "./schedules.css";

/** How often the list refetches the scheduler's last pass while a schedule is enabled. */
const REFRESH_MS = 60_000;

/** `Date.now()`, again every `everyMs`, so time-based lines stay current. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/**
 * The Schedules section of the Tasks sidebar: each schedule with its next
 * run and last outcome, and a warning while the scheduler is not passing.
 * Shown only when the server serves schedules.
 */
export function ScheduleList() {
  const { schedules, templates, refreshSchedules } = useWorkspace();
  const { openScheduleDialog } = useShell();
  const labelId = useId();
  const now = useNow(30_000);
  const anyEnabled =
    schedules?.schedules.some((schedule) => schedule.enabled) ?? false;
  // A stopped worker sends no hint: read its last pass again now and then.
  useEffect(() => {
    if (!anyEnabled) return;
    const timer = setInterval(() => void refreshSchedules(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [anyEnabled, refreshSchedules]);
  if (schedules === null) return null;
  const stale = anyEnabled && schedulerStale(schedules.scheduler, now);
  return (
    <section className="schedule-list" aria-labelledby={labelId}>
      <div className="schedule-list__head">
        <SectionLabel as="h2" id={labelId} className="shell-list__label">
          Schedules
        </SectionLabel>
        {templates !== null && templates.length > 0 && (
          <IconButton
            label="New schedule"
            icon={<Icon name="plus" size={14} />}
            onClick={() => openScheduleDialog({ kind: "new" })}
          />
        )}
      </div>
      {stale && (
        <p className="schedule-list__stale" role="status">
          <span className="schedule-list__mark" aria-hidden="true">
            !
          </span>
          {schedules.scheduler.lastPassAt
            ? `The scheduler last ran ${minutesAgo(schedules.scheduler.lastPassAt, now)}: schedules start only while the server's worker runs.`
            : "The scheduler has not run yet: schedules start only while the server's worker runs."}
        </p>
      )}
      {schedules.schedules.length === 0 ? (
        <p className="shell-list__note">
          {templates && templates.length > 0
            ? "Schedule a template to start it on its own, on a timetable."
            : "Save a template first, then schedule it."}
        </p>
      ) : (
        <ul className="schedule-list__rows" aria-labelledby={labelId}>
          {schedules.schedules.map((schedule) => (
            <ScheduleRow key={schedule.id} schedule={schedule} />
          ))}
        </ul>
      )}
    </section>
  );
}

function minutesAgo(at: string, now: number): string {
  const minutes = Math.max(1, Math.round((now - Date.parse(at)) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function ScheduleRow({ schedule }: { schedule: Schedule }) {
  const { openScheduleDialog } = useShell();
  const { timeZone } = schedule.trigger;
  const fire = schedule.lastFire;
  const outcome = fire ? outcomeLine(fire) : undefined;
  return (
    <li className="schedule-row">
      <span className="schedule-row__title clamp2">{schedule.name}</span>
      <span className="schedule-row__meta">
        {schedule.pausedReason && !schedule.enabled
          ? `Paused: ${pausedLine(schedule.pausedReason)}`
          : !schedule.enabled
            ? "Off"
            : schedule.nextFireAt
              ? `Next ${formatRun(schedule.nextFireAt, timeZone)} · ${timeZone}`
              : "No run in the next year"}
      </span>
      {outcome && (
        <span
          className={`schedule-row__outcome schedule-row__outcome--${outcome.tone}`}
        >
          <span className="schedule-row__word">{outcome.word}</span>{" "}
          {outcome.taskId ? (
            <a href={taskHref(outcome.taskId)}>{outcome.text}</a>
          ) : (
            outcome.text
          )}
        </span>
      )}
      <span className="schedule-row__actions">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Edit ${schedule.name}`}
          onClick={() =>
            openScheduleDialog({ kind: "edit", scheduleId: schedule.id })
          }
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Delete ${schedule.name}`}
          onClick={() =>
            openScheduleDialog({ kind: "delete", scheduleId: schedule.id })
          }
        >
          Delete
        </Button>
      </span>
    </li>
  );
}
