# Approvals

A call that a rule of its bot's runtime profile matches waits for the user before it runs. The task chat shows it as a card with the whole call, the rule and the bot's text, and Approve and Deny; the header and the task list say an approval is waiting, and the coordinator's direct chat tells the user with Approve and Deny under the task's card. Approving runs the call once and the task goes on; denying returns the user's reason to the bot as the call's error. A goal change expires a pending approval and a stop cancels it; neither runs it.

## Sub-features

- `approvals-rules` adds, edits, previews and removes approval rules in a runtime profile.
- `approvals-approve` holds a call, shows it pending, approves it from the task chat, and shows it ran.
- `approvals-deny` denies a call with a reason; the bot gets the reason and the call never runs.
- `approvals-chat` answers a held call from the coordinator's direct chat, under the task card.

## How to get to it (user POV)

- Settings → `Runtime profiles` → `Edit` (or `New profile`): the group `Approvals`, with `Add a rule`, each rule's `Rule <n> tool` and `Rule <n> match` fields and `Remove rule <n>`, and `Check a bash command` for a preview.
- A task's chat: the article `Approval: <bot> asks to run <tool>`, with `Approve`, `Deny` (then `Reason for the bot (optional)` and `Deny the call`). The header shows the badge `1 approval waiting`; the task list row reads `waiting · v1 · needs approval`.
- The coordinator's direct chat: the list `Calls in <task title> waiting for your approval` under the task's newest card, with `Approve: <call>` and `Deny: <call>`.

## Driving it with playwright-cli

Preconditions:

- Doctor exits 0. A profile with a rule and a bot on it: either drive `approvals-rules` below, or (a precondition, said so in the report) `curl -s -X POST "$U/api/runtime-profiles" -H 'content-type: application/json' -d '{"name":"Guarded local","sandbox":{"driver":"local","network":{"mode":"open"}},"approvals":[{"tool":"bash","match":"git push"}]}'`, then create the bot in Studio with `Runtime profile` set to it.
- The scripted coordinator runs the command its goal quotes after "run": a goal of ``Ship the release: run `echo shipped > shipped.txt # git push` `` makes a held call (a solo coordinator runs it itself; with a teammate the worker does).

- **Rules.** In the profile editor choose `Add a rule`, keep `Rule 1 tool` at `bash`, fill `Rule 1 match` with `git push` and type `git push origin main` into `Check a bash command`: the status reads `Asks for approval: bash calls matching `git push`.`; `git pull` reads `Runs without asking.`. Choose `Save changes`; `curl -s "$U/api/runtime-profiles"` shows `"approvals":[{"tool":"bash","match":"git push"}]`.
- **Pending.** Start the task from the bot's `New task` dialog. Its chat shows the approval card with the command, `Needs your approval: bash calls matching `git push`` and `waiting for your approval · not run`; the header shows `1 approval waiting` and `waiting · v1`. `curl -s "$U/api/tasks/<taskId>"` has one approval `"status":"pending"`, no `tool.started` with its `toolCallId`, and no `shipped.txt` artifact.
- **Approve.** Choose `Approve`: the card reads `approved · waiting to run`, then `ran · exit 0`; the chat reaches `Task done` and the badge goes. The API shows the approval `approved` with `"outcome":{"ok":true,"exitCode":0,…}` and one `tool.finished` for its `toolCallId`; `shipped.txt` downloads as `shipped`.
- **Deny.** On a second task, choose `Deny`, fill `Reason for the bot (optional)` with `push to a branch instead` and choose `Deny the call`: the card reads `denied · not run` and `Your reason: push to a branch instead`. The task goes on without the file; the session's transcript gets the error `Not run: the user denied this call. Their reason: push to a branch instead`.
- **Direct chat.** Open the coordinator's chat: its update reads `"<title>" needs your approval: <bot> wants to run bash: … Approve or deny it on the card below.`, and the task card carries the list with `Approve: …` and `Deny: …`. Answer there; the list goes once the task summary updates.
- **Message while held.** Send a message in the task chat while the coordinator holds the call (the placeholder reads `Answer the approval above; a message waits for it…`): the task stays `waiting` and the approval `pending`; the coordinator reads the message after the answer.

## Gotchas

- Rules match text in the call, case-sensitively; they guide a cooperative bot and are no security boundary (the editor says so).
- A session holds one call at a time: a second matching call in the same batch is refused with a tool error, not shown as a card.
- The chat update reply is a model call of the coordinator; on the scripted model it is free and immediate.
- An approval answered elsewhere shows `Not sent` with the server's `APPROVAL_NOT_PENDING` message.
