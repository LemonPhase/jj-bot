# Uploads

A user gives a task files to work on. In the New task dialog they drop or choose files, see each file's size and upload progress, and start the task; the files are in the task's workspace, under `uploads/`, before the coordinator's first model call. In the task chat a paperclip uploads more files, on their own or with the next message. Each upload shows in the chat as a card with a chip per file: `Waiting for the next run`, `In workspace · <path>` or `Not placed: <why>`, and a download link. The artifact list labels them `Uploaded by you`.

## Sub-features

- `upload-new-task` stages files in the New task dialog's `Files · optional` group and attaches them when the task starts.
- `upload-limits` refuses a file over the size limit, a name a path cannot take or too many files in place, without sending it, and blocks `Start task` until it is removed.
- `upload-card` shows the announcement in the task chat with each file's state and download.
- `upload-paperclip` uploads files into an open task from the chat composer, alone (`Upload N files`) or ahead of a message.
- `upload-waiting` keeps files given to a finished task waiting for its next run, which a message starts.

## How to get to it (user POV)

- The `New task` dialog (a bot's chat header, or the Tasks screen): the `Files · optional` group, with `Choose files` and a drop zone.
- An open task's chat: the `Attach files` button left of `new goal` in the composer.

## Driving it with playwright-cli

Preconditions:

- A bot named `Nova` exists ([bot-studio.md](bot-studio.md)), and its chat is open (`#/bots/<botId>`).
- Two small files on disk, such as `printf 'id,name\n1,Ada\n' > "$RUN/table.csv"` and `printf '# Notes\n' > "$RUN/notes.md"`.

- **Files with a new task.** Click `New task`, fill `Goal` with ``Check the files: run `sha256sum uploads/*` ``, then run `$P "$RUN" upload "$RUN/table.csv" "$RUN/notes.md"` right after `$P "$RUN" click "getByRole('button', { name: 'Choose files' })"` (the button opens the file chooser that `upload` answers). The list `Files to upload` shows `table.csv` with `14 B · ready` and `notes.md` with `8 B · ready`. Click `Start task`. The task opens; the log shows the article `You uploaded 2 files` with `In workspace · uploads/table.csv` and `In workspace · uploads/notes.md` once the task runs, and the task finishes. Confirm with `curl -s "$U/api/tasks/<taskId>"`: two artifacts with `upload.state` `placed`, and with `curl -s "$U/api/tasks/<taskId>/events?after=0"`: the `tool.finished` of `sha256sum uploads/*` prints both files' SHA-256 (compare with `sha256sum "$RUN/table.csv" "$RUN/notes.md"`), and every `artifact.updated` comes before the first `model.started`. On `local`, the files are in `$RUN/sandbox/task/<taskId>/uploads/`.
- **A file over the limit.** In the dialog, choose a file over 16 MiB (`head -c 17825792 /dev/zero > "$RUN/big.bin"`, 17 MiB). Its row shows the alert `Not uploaded 17 MB is over the 16 MB a file can be.` and `Start task` is disabled until you click `Remove big.bin`. Nothing reaches the server (`curl` shows no new task).
- **The paperclip.** In a finished task's chat, click `Attach files`, answer the chooser with a file, then click `Upload 1 file`. A new card `You uploaded 1 file` shows `Waiting for the next run`; the task stays `completed`. Send a message: the card turns to `In workspace · uploads/<name>` once the coordinator's run starts.

## Gotchas

- Sizes are shown in units of 1024, as the limits are set: `16 MB` is `JJ_UPLOAD_MAX_FILE_MB=16`.
- Files are staged as they are picked; closing the dialog unsent, or leaving the task with files picked, removes the staged copies (`DELETE /api/uploads/:id`).
- The scripted coordinator runs the command its goal quotes after "run", after writing its notes, so its first command shows what the workspace held.
- The group and the paperclip are hidden on a server that reports no `capabilities.uploads` (`JJ_UPLOADS=off`, or a server older than uploads).
