# Task templates

A user saves a task setup as a template (title, goal, team, checks and spend cap) and starts it again in one step, optionally with instructions for that run. The Templates section of the Tasks sidebar lists each template with Start, Edit and Delete; a template naming an archived bot shows why it cannot start and offers no Start. A task started from a template says so in its header.

## Sub-features

- `template-save-from-task` saves the open task as a template from its header (`Save as template`).
- `template-new` saves a template from scratch (`New template` in the Templates section).
- `template-start` starts a task from a template, with optional instructions and title, and shows the cap it gets.
- `template-edit` and `template-delete` change or remove a template; its tasks keep their link.
- `template-problems` shows an archived participant on the row and in the start dialog, and refuses the start.

## How to get to it (user POV)

- The sidebar's `Tasks N` button: the `Templates` section is below the task list.
- A task's header: the `Save as template` button, and `From template <title>` under the title for a task started from one.

## Driving it with playwright-cli

Preconditions:

- A bot named `Nova` exists ([bot-studio.md](bot-studio.md)), and a task of Nova's has finished ([tasks.md](tasks.md)), such as one with the goal ``Weekly notes: run `echo notes > notes.txt` ``.

- **Save the task as a template.** On the task, run `$P "$RUN" click "getByRole('button', { name: 'Save as template' })"`. The dialog `New template` opens filled from the task: `Goal` holds its goal, the radiogroup `Spend cap` has `Profile's` checked when the task's cap is the one its coordinator's profile sets (`Amount` with the task's cap otherwise). Run `$P "$RUN" fill "getByRole('dialog', { name: 'New template' }).getByRole('textbox', { name: 'Title' })" 'Weekly notes'`, then click `Save template`. The region `Templates` lists `Weekly notes` with `Nova · 1 bot` and the buttons `Start Weekly notes`, `Edit Weekly notes` and `Delete Weekly notes`. Confirm with `curl -s "$U/api/task-templates"`: one template, `problems: []`.
- **Start it with instructions.** Click `Start Weekly notes`. The dialog `Start: Weekly notes` shows `Goal`, `Team` (`Nova coordinates`), `Checks` and `Spend cap` (`$5.00, from Nova's profile.`). Run ``$P "$RUN" fill "getByRole('textbox', { name: /Instructions for this run/ })" 'This week also run `echo again > again.txt`'`` and click `Start task`. The URL becomes `#/tasks/<taskId>`, the main region is `Task: Weekly notes`, the header reads `From template Weekly notes`, and the task finishes with `again.txt` and `notes.txt` among its artifacts. `curl -s "$U/api/tasks/<taskId>"` shows `templateId` and a goal ending in `Instructions for this run:` and the instructions.
- **A template that cannot start.** Archive a participant (`curl -s -X DELETE "$U/api/bots/<botId>"` is a precondition, not the feature). The row shows `<Name> is archived.` and `Start <title>` is disabled; a start dialog already open shows `Can't start`, a disabled `Start task` and `Edit template` once the list refreshes. `curl -s -X POST -H 'Content-Type: application/json' -d '{}' "$U/api/task-templates/<id>/tasks"` answers 409 `TEMPLATE_UNUSABLE` with `details.problems`, and `curl -s "$U/api/tasks"` lists no new task.
- **Edit and delete.** `Edit <title>` opens `Edit template`; an archived bot is named as left out when you save. `Delete <title>` asks `Delete “<title>”?`; `Delete template` removes it, and a task started from it now reads `From a deleted template`.

## Gotchas

- The cap choice `Profile's` takes the coordinator's profile cap when each task starts; saving from a task picks it when the task's cap equals the profile's, and keeps any other cap as an `Amount`.
- The scripted model runs the commands quoted after "run" in the whole goal, so instructions that quote a command add a known file to the run.
- The section is hidden on a server older than templates (it answers `GET /api/task-templates` with 404).
- `template-new` from scratch and the cap choices beyond `Amount` are covered by DOM tests (`apps/web/src/features/templates/templates.dom.test.tsx`); drive them from a snapshot before relying on these notes.
