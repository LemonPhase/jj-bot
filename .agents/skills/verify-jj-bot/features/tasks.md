# Tasks

A user starts a task with a goal and a team. The coordinator plans and delegates, the task chat shows what the bots are doing, and the side panel shows progress steps, the session graph, the office view and the artifacts the bots wrote.

## Sub-features

- `task-start` starts a task from the New task dialog.
- `task-follow` shows the task running to done in the chat, header and progress steps.
- `task-artifacts` lists and downloads the files the task produced.
- `task-views` switches the side panel between `Progress`, `Graph` and `Office`.
- `task-continue` continues a finished task with a message or a new goal.

## How to get to it (user POV)

- The `New task` button on a bot's chat screen, or in the sidebar on the Tasks list.
- A chat request that starts a task ([bot-chat.md](bot-chat.md)).
- The sidebar's `Tasks N` button, then a task in the list; or `#/tasks/:taskId`.

## Driving it with playwright-cli

Preconditions:

- A bot named `Nova` exists, created through [bot-studio.md](bot-studio.md). Add more bots to exercise delegation.

- **Open the dialog.** On `#/bots`, choose `New task`. Run `$P "$RUN" click "getByRole('button', { name: 'New task' })"`. A dialog with the heading `New task` appears, with the textbox `Goal` focused, the combobox `Coordinator` and the group `Participants · N`. `Start task` is disabled until the goal has text.
- **Start.** Run ``$P "$RUN" fill "getByRole('textbox', { name: 'Goal' })" 'Penguin report: run `echo penguins > facts.txt`'`` and `$P "$RUN" click "getByRole('button', { name: 'Start task' })"`. The URL becomes `#/tasks/<taskId>` and the main region is named `Task: <goal>`.
- **Follow to done.** With one bot and that goal it finishes in about a second. Run `$P "$RUN" snapshot --filename=task.yml`. The header shows `done · v1`, `Stop` is disabled, the log `Messages in <goal>` holds an article `Nova, result` and the line `Task done`, and the status reads `Nova finished.`. The tab `Progress` lists step `s-1 · <goal> done · Nova`.
- **Artifacts.** The region `Artifacts · 2` lists `facts.txt` (9 B) and the bot's `notes-<hash>.md`, each with a link `Download <name>`. Confirm the bytes: `curl -s "$U/api/tasks/<taskId>"` lists the artifacts, and `curl -s "$U/api/tasks/<taskId>/artifacts/<artifactId>/content"` for `facts.txt` prints `penguins`.
- **Views.** Choose the tabs in the tablist `Task view`: `$P "$RUN" click "getByRole('tab', { name: 'Graph' })"`, then `Office`. Each shows its tabpanel. The office is a canvas named `Pixel office acting out the task conversation` (2D) or `3D office acting out the task conversation`, so screenshot it rather than snapshotting it.
- **Continue.** The composer under the chat has the textbox `Message the task group`, `Send`, and a `new goal` button. Sending continues the finished task; the header version advances on a new goal.

## Gotchas

- The API reports the status `completed`; the UI says `done`. A stopped task is `cancelled` in the API and `stopped` in the UI.
- The scripted model runs only commands quoted after "run" in the goal, in order. A goal without one still finishes, with the notes file as its only artifact.
- On the local driver the workspace files are on disk under `$RUN/sandbox`; that is a usable side-effect check, but it's removed at cleanup, so copy what you cite into `evidence/`.
- `task-continue` and multi-bot delegation haven't been driven yet: confirm the composer and the `new goal` flow from a snapshot before relying on these notes.
