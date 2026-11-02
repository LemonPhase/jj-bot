# Stop a task

A user stops a running task. Running sessions are interrupted, queued ones never start, and a stopped task can't be continued.

## Sub-features

- `stop-confirm` asks for confirmation, and `Keep running` leaves the task alone.
- `stop-task` stops the task and interrupts its running command.

## How to get to it (user POV)

- The `Stop` button in a running task's header.

## Driving it with playwright-cli

Preconditions:

- A bot named `Nova` exists ([bot-studio.md](bot-studio.md)).
- A running task with a slow step. Start one through the New task dialog ([tasks.md](tasks.md)) with the goal ``Slow job: run `sleep 60` ``.

- **Ask to stop.** Within the first minute, choose `Stop`. Run `$P "$RUN" click "getByRole('button', { name: 'Stop' })"`. A dialog with the heading `Stop this task?` appears with `Keep running` (focused) and `Stop task`.
- **Keep running.** Optional: choose `Keep running`; the dialog closes and the header still shows the task running.
- **Stop.** Choose `Stop task`. Run `$P "$RUN" click "getByRole('button', { name: 'Stop task' })"`. Within about 2 s the header reads `stopped · v1`, `Stop` is disabled, the chat shows `Stop requested` and `Task stopped`, the status reads `Nova stopped.`, and the composer's placeholder becomes `This task was stopped`.
- **Confirm.** `curl -s "$U/api/tasks/<taskId>"` reports `task.status` `cancelled`. `pgrep -ax sleep` lists no `sleep 60` (local driver), proving the command was interrupted, not just hidden.

## Gotchas

- `pgrep -f 'sleep 60'` matches the shell running the check itself; use `pgrep -ax sleep`.
- Stop the task before its slow step ends, or there is nothing left to interrupt.
- A stopped task can't be continued; that is the contract, not a bug.
