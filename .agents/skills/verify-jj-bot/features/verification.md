# Verification checks

A user gives a task checks: commands that must exit 0 in the task's sandbox, or assertions on a workspace file or on the result. The task completes only when every check passes for the current goal version; a failing check goes back to the coordinator to fix, and the task waits for the user once the attempts run out. The header, the Progress view and the chat's task card show where the checks stand, and "verified" only when the task completed with every check passed.

## Sub-features

- `checks-create` adds checks in the New task dialog's `Checks · optional` section.
- `checks-fix` shows a failing check that the coordinator fixes, run again and passed: the task completes verified.
- `checks-fail` shows a check that cannot pass: the task waits, `failed`, never verified.
- `checks-edit` changes the checks of a task from the header's `Edit checks` dialog, which starts a new goal version and supersedes the earlier evidence.

## How to get to it (user POV)

- The New task dialog ([tasks.md](tasks.md)): `Checks · optional`, then `Add a check`.
- A task's header: the badge `Verification: …` beside the status, and the button `Edit checks` (`Add checks` on a task without any).
- The task's `Progress` tab: the region `Verification · goal vN`.

## Driving it with playwright-cli

Preconditions:

- A bot named `Nova` exists ([bot-studio.md](bot-studio.md)).
- The scripted coordinator, told its checks did not pass, runs the fix its goal quotes after "if a check fails, fix it with" and completes again; without one it says the checks did not pass and waits.

- **Add a check.** Open `New task` and fill the goal ``Write ready to checked.txt. If a check fails, fix it with `printf ready > checked.txt`.``. Choose `Add a check` (`$P "$RUN" click "getByRole('button', { name: 'Add a check' })"`), fill `What it checks` with `checked.txt says ready` and `Command` with `grep -q ready checked.txt`, then `Start task`. An empty check is refused in place with an alert and nothing is sent.
- **Fixed, then verified.** Within a few seconds the header reads `done · v1` and the badge `Verification: verified · 1/1`. The chat shows the system lines `Verification failed: 0 of 1 checks passed (goal version 1, attempt 1); …` and then `Verification passed: all 1 checks passed (goal version 1, attempt 2).` The `Progress` tab's region `Verification · goal v1` lists `checked.txt says ready` `passed` with `exit 0 · … · attempt 2`. Second view: `curl -s "$U/api/tasks/<taskId>"` has `verificationChecks` with attempt 2 passed, and `curl -s "$U/api/tasks/<taskId>/events?after=0"` both attempts' `verification.checked`.
- **Cannot pass.** Start another task with the goal `Write a short note.` and the check `never-created.txt exists` (command `test -f never-created.txt`). The header reads `waiting · v1` with `Verification: failed · 0/1`, the coordinator says the checks did not pass, and nothing reads `verified`. The region lists the check `failed` with `exit 1`.
- **Edit the checks.** On the verified task, choose `Edit checks`; the dialog `Verification checks` opens with the plan. Add or change a check and choose `Save as goal v2`. The header advances to `v2`, the badge reads `not checked · 0/N` (or the new attempt's outcome once it runs), and the region lists `Goal v1 · superseded` under the current checks.

## Gotchas

- The checks section appears only when the server reports verification; the in-browser demo (`?demo`) never offers it.
- The badge's word is in visually hidden text (`Verification: `) plus the visible `verified · 1/1`; match it with a regex or read the snapshot.
- The scripted model also runs commands a goal quotes after "run", during the work; a fix written as "run `…`" would make the first check pass already.
- Every attempt of a run re-runs every check; the view shows the latest attempt per goal version, the event log shows them all.
