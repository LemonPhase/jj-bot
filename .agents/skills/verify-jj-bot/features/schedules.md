# Schedules

A user schedules a task template to start on its own, at the times a cron expression names in a time zone. The editor fills the cron field from presets, previews the next 3 runs and refuses inline what the server would refuse (a gap under the server's minimum, a time that never comes, an unknown zone, a template without a spend cap). The Schedules section of the Tasks sidebar lists each schedule with its next run and its last outcome, and warns when the server's scheduler has not run for 2 minutes. A task a schedule started reads `Scheduled · <name>` in its header.

## Sub-features

- `schedule-new` saves a schedule from a template's `Schedule…` button, or from `New schedule` in the Schedules section.
- `schedule-preview` fills the cron field from a preset (`Hourly`, `Daily`, `Weekdays`, `Weekly`) and shows the next 3 runs in the zone.
- `schedule-refusals` shows the server's refusals inline: the gap, a time that never comes, an unknown zone, a template without a cap.
- `schedule-fire` starts the template at its time, once: the row reads `Started opened a task`, and the task's header `Scheduled · <name>`.
- `schedule-outcomes` lists `Skipped`, `Missed`, `Refused` and `Paused` rows.
- `schedule-edit` and `schedule-delete` change or remove a schedule; its tasks are kept. A template a schedule starts cannot be deleted.
- `schedule-stale` warns while the scheduler's last pass is more than 2 minutes old.

## How to get to it (user POV)

- The sidebar's `Tasks N` button: the `Schedules` section is below `Templates`, and each template row has `Schedule <title>`.
- A scheduled task's header: `Scheduled · <name>` beside `From template <title>`.

## Driving it with playwright-cli

Preconditions:

- A bot (`Nova`) and a template with a spend cap exist. Creating them through the API is a precondition, not the feature: `curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"Nova"}' "$U/api/bots"`, then ``curl -s -X POST -H 'Content-Type: application/json' -d '{"title":"Morning notes","goal":"Notes: run `echo notes > notes.txt`","coordinatorBotId":"<botId>","spendCapUsd":1}' "$U/api/task-templates"``.

- **Open the editor.** Run `$P "$RUN" open '#/tasks'`, then `$P "$RUN" click "getByRole('button', { name: 'Schedule Morning notes' })"`. The dialog `New schedule` opens with `Template` set to `Morning notes`, `Name` filled from it, the `Daily` preset (`0 9 * * *`) and the browser's zone.
- **Preview and refusals.** Run `$P "$RUN" fill "getByLabel('Time zone')" UTC`, then `$P "$RUN" fill "getByRole('textbox', { name: 'Cron' })" '*/30 * * * *'`: the field shows `This schedule runs 30 minutes apart at times, under this server's minimum of 60 minutes between runs.` and `Save schedule` is disabled. A valid expression shows `Next runs · UTC` and three times.
- **Fire once.** Fill `Cron` with the minute two minutes from now, in UTC (`node -e 'const d=new Date(Date.now()+2*60_000);console.log(`${d.getUTCMinutes()} ${d.getUTCHours()} * * *`)'`), click `Save schedule`, and the region `Schedules` lists it with `Next … · UTC`. Within 30 s of the due time the row reads `Started opened a task`; its link opens the task, whose header reads `Scheduled · <name>` and whose first message from the coordinator quotes `Started by schedule "<name>" for <time> UTC; the user may not be watching.` Confirm with `curl -s "$U/api/schedules/<id>"`: one `started`fire whose`taskId`is the task, and`nextFireAt`the next day. A minute later,`curl -s "$U/api/tasks"`still lists one task with that`scheduleId`.
- **Template in use.** `Delete Morning notes`, then `Delete template`: the dialog shows `Not deleted` and `started by the schedule "<name>"`.
- **Delete.** `Delete <name>`, then `Delete schedule`: the row goes; `curl -s "$U/api/schedules/<id>"` answers 404, and its task keeps its `scheduleId`.

## Gotchas

- The scheduler passes every 30 s on the server's clock, so a fire lands up to 30 s after its time; a cron can name a minute, never a second.
- The minimum interval (`JJ_SCHEDULE_MIN_INTERVAL_MINUTES`, default 60) is measured on the wall clock: `59 * * * *` is allowed although on the night clocks go forward it runs at 00:59 and 02:00, a minute apart.
- `schedule-outcomes` (skipped, missed, refused, paused) and `schedule-stale` need a held approval, a stopped server or a cap; they are covered by DOM tests (`apps/web/src/features/schedules/schedules.dom.test.tsx`) and the engine tests (`packages/backend/src/schedules.test.ts`). The embedded worker of a verify instance cannot be stopped without stopping the instance.
- The section and the `Schedule…` buttons are hidden on a server that reports `capabilities.schedules` false.
