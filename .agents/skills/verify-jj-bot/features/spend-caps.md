# Spend caps

A task stops before the model call that would pass its spend cap, says so in its chat and header, refuses messages until the user raises the cap, and continues once they do. Each bot's daily cap and the server's daily cap stop work the same way. Settings and the bot inspector show what was spent against the caps.

## Sub-features

- `caps-profile` sets the task and daily bot caps of a runtime profile.
- `caps-task` stops a task at its cap, refuses a message, and continues it after the cap is raised in the header.
- `caps-bot` refuses a direct message to a bot at its daily cap.
- `caps-usage` reports spend in Settings → Usage and on the bot inspector, with calls on unpriced models counted apart.

## How to get to it (user POV)

- Settings → `Runtime profiles` → `Edit`: the fields `Spend cap per task (USD)` and `Spend cap per bot per day (USD)` in the group `Budgets`.
- The `New task` dialog: the field `Spend cap (USD)`, filled from the coordinator's profile.
- A task's header: the button named `Usage: <tokens> tokens · <spend> of <cap>…`, which opens the dialog `Spend cap`.
- The bot screen's `Profile` panel: the section `Spend`. Settings: the tab `Usage`.

## Driving it with playwright-cli

Preconditions:

- Doctor exits 0. A bot that costs something: in Studio, choose the `Model` option `Scripted test model (fictional price) · not a real model` (`$P "$RUN" select "getByRole('combobox', { name: 'Model' })" "Scripted test model (fictional price) · not a real model"`). The default `Scripted test model` lists no price, so no cap ever stops it.

- **Profile caps.** In the profile editor, fill `Spend cap per task (USD)` with `0.004` and choose `Save changes`. `curl -s "$U/api/runtime-profiles"` shows `maxUsdPerTask: 0.004`; the profile card lists `$0.004 per task`.
- **Stop at the cap.** Start a task for the bot with a goal that runs three commands (``run `echo one > one.txt`, run `echo two > two.txt`, run `echo three > three.txt` ``). Within seconds the header reads `waiting · v1` and its usage button `… $0.0048 of $0.004 · cap reached`, and the chat shows `Stopped: The task reached its spend cap: … Raise the task's spend cap to continue.` `curl -s "$U/api/tasks/<taskId>"` has one `spend.capped` event.
- **Refused message.** Send `Carry on.` from the composer: the alert `Not sent` repeats the cap message (409 `SPEND_CAP_REACHED`).
- **Raise and continue.** Click the usage button, fill `Spend cap (USD)` with `0.05` (empty means no cap), choose `Save cap`, then send the message again. The task runs to `done`.
- **Bot cap.** Lower `Spend cap per bot per day (USD)` below what the bot spent and send it a direct message: the alert `Error` reads `<bot> reached its daily spend cap: …`. The `Spend` section of its `Profile` panel reads `Last 24 hours: … · cap reached`.
- **Usage.** Settings → `Usage` lists `Everything` over 24 hours, 7 days and 30 days, the table `Per bot` (spend against each bot's cap) and `Per model, last 30 days`. Confirm with `curl -s "$U/api/usage"`.
- **Unpriced.** A task of a bot on the default `Scripted test model` shows `… $0.00 of $5.00 · N unpriced` in its header; the button's tooltip says those calls are not in the cost and no cap bounds them.

## Gotchas

- The fictional price makes each scripted call cost a few tenths of a cent, so caps below $0.01 stop a task after one or two calls; the default $5 never stops a short task.
- A call already running when the cap is crossed finishes, so spend can pass the cap by one call per running session.
- Raising the cap continues nothing: the task waits until the user sends a message.
- The `Spend cap` dialog renders inside the header's actions; target its field and buttons by name.
