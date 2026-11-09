# Spend caps

A task stops before the model call that would pass its spend cap, says so in its chat and header, refuses messages until the user raises the cap, and continues once they do. Each bot's daily cap and the server's daily cap stop work the same way. With asking on, a task (or a bot's daily cap) also waits for the user past 80% of its cap: no model call starts until the user approves continuing up to the cap, and a denial stops the task there. Settings and the bot inspector show what was spent against the caps.

## Sub-features

- `caps-profile` sets the task and daily bot caps of a runtime profile.
- `caps-task` stops a task at its cap, refuses a message, and continues it after the cap is raised in the header.
- `caps-bot` refuses a direct message to a bot at its daily cap.
- `caps-usage` reports spend in Settings → Usage and on the bot inspector, with calls on unpriced models counted apart.
- `caps-approval` asks before spending past 80% of a cap: approve, deny, ask again after a message, and raise the cap from the card.

## How to get to it (user POV)

- Settings → `Runtime profiles` → `Edit`: the fields `Spend cap per task (USD)` and `Spend cap per bot per day (USD)` in the group `Budgets`.
- The `New task` dialog: the field `Spend cap (USD)`, filled from the coordinator's profile, and the checkbox `Ask before spending past 80% of a cap` (the profile's choice until changed). The same checkbox is in the `Spend cap` dialog and in the profile editor's `Budgets`.
- A task's chat, while it waits past the threshold: the article `Approval: spend past 80% of the task's cap` (or `of <bot>'s daily cap`), with `Approve`, `Deny` and `Raise cap…`; the header badge `1 approval waiting`; the task list row `waiting · v1 · needs approval`.
- A task's header: the button named `Usage: <tokens> tokens · <spend> of <cap>…`, which opens the dialog `Spend cap`.
- The bot screen's `Profile` panel: the section `Spend`. Settings: the tab `Usage`.

## Driving it with playwright-cli

Preconditions:

- Doctor exits 0. A bot that costs something: in Studio, choose the `Model` option `Scripted test model (fictional price) · not a real model` (`$P "$RUN" select "getByRole('combobox', { name: 'Model' })" "Scripted test model (fictional price) · not a real model"`). The default `Scripted test model` lists no price, so no cap ever stops it.

- **Profile caps.** In the profile editor, fill `Spend cap per task (USD)` with `0.004` and choose `Save changes`. `curl -s "$U/api/runtime-profiles"` shows `maxUsdPerTask: 0.004`; the profile card lists `$0.004 per task`.
- **Stop at the cap.** Start a task for the bot with a goal that runs three commands (``run `echo one > one.txt`, run `echo two > two.txt`, run `echo three > three.txt` ``). Within seconds the header reads `waiting · v1` and its usage button `… $0.004789 of $0.004 · cap reached` (amounts next to a cap get the places they need, as in the server's message), and the chat shows `Stopped: The task reached its spend cap: … Raise the task's spend cap to continue.` `curl -s "$U/api/tasks/<taskId>"` has one `spend.capped` event.
- **Refused message.** Send `Carry on.` from the composer: the alert `Not sent` repeats the cap message (409 `SPEND_CAP_REACHED`).
- **Raise and continue.** Click the usage button, fill `Spend cap (USD)` with `0.05` (empty means no cap), choose `Save cap`, then send the message again. The task runs to `done`.
- **Bot cap.** Lower `Spend cap per bot per day (USD)` below what the bot spent and send it a direct message: the alert `Error` reads `<bot> reached its daily spend cap: …`. The `Spend` section of its `Profile` panel reads `Last 24 hours: … · cap reached`.
- **Usage.** Settings → `Usage` lists `Everything` over 24 hours, 7 days and 30 days, the table `Per bot` (spend against each bot's cap) and `Per model, last 30 days`. Confirm with `curl -s "$U/api/usage"`.
- **Unpriced.** A task of a bot on the default `Scripted test model` shows `… $0.00 of $5.00 · N unpriced` in its header; the button's tooltip says those calls are not in the cost and no cap bounds them. Settings → `Usage` adds `+ N unpriced` to every cell that has such calls.
- **Ask past 80%.** Start a task for the priced bot with ``Write the notes: run `echo 1`, …, run `echo 25`.``, `Spend cap (USD)` `0.05` and `Ask before spending past 80% of a cap` ticked. Within seconds the chat shows the card `Spent $0.04… of $0.05, past the 80% threshold. Continue up to the cap?` and `waiting · no model calls`; `curl -s "$U/api/tasks/<taskId>"` has one approval `"kind":"spend","status":"pending"`, `spend.threshold` before `approval.requested`, and no `model.started` after it.
- **Approve.** Choose `Approve`: the card reads `approved`, the task runs on and stops at the cap (`Stopped: The task reached its spend cap…`), and no second approval is asked for that cap.
- **Deny.** On a second task (a teammate shows the worker's side), choose `Deny`: the card reads `denied · task stopped`, the worker's result ends `(Stopped before finishing: spend past 80% of the task's $0.05 cap was not approved.)`, the chat shows `Stopped: spend past 80% of the task's $0.05 cap was not approved. …`, the spend does not move and there is no `spend.capped`. A message from the composer continues the task and shows a new card, still `waiting · no model calls`.
- **Raise cap.** On a pending card choose `Raise cap…`, fill `Spend cap (USD)` with `0.08` and choose `Save cap`: the card reads `expired · cap changed` and the task goes on under the new cap, asking again only at 80% of it.
- **Update replies.** A task that stops at its coordinator's daily cap waits; the chat's update reply is refused too, so the chat shows the engine's plain update (`(Posted automatically: the reply to this update failed.)`) whose text names the cap, and the banner `Reply failed` reads `Not answered: <bot> reached its daily spend cap: …`.

## Gotchas

- The fictional price makes each scripted call cost a few tenths of a cent, so caps below $0.01 stop a task after one or two calls; the default $5 never stops a short task.
- A call already running when the cap is crossed finishes, so spend can pass the cap by one call per running session.
- Raising the cap continues nothing: the task waits until the user sends a message.
- The `Spend cap` dialog renders inside the header's actions; target its field and buttons by name.
- Each priced scripted call costs a few tenths of a cent, so the stretch between 80% and 100% of a cap below a few cents can be shorter than one call: the task then stops at the cap without asking. Use a cap of $0.05 or more to see the question.
- Calls already running when the question is asked finish and are counted; with several workers the spend can pass the threshold by one call each.
