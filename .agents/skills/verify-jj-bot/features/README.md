# JJ Bot verification map

The maintained source for verifying JJ Bot's user-facing behavior in the web app. Read this index before driving, then follow the matching feature file as the recipe.

## Baseline preconditions

- An instance started by this run with `scripts/launch.sh`, and `scripts/doctor.sh "$RUN"` exiting 0.
- The workspace starts empty: no bots, no tasks, one default runtime profile ("Local (unisolated)" on the local driver). Every journey that needs a bot creates one in Studio first ([bot-studio.md](bot-studio.md)).
- The only model is the scripted test model, and the sidebar badge reads "Scripted model".
- Never drive an instance this run didn't start.

## Driving conventions

- Run browser actions through `scripts/pw.sh "$RUN" <command>`. `P` below is `.agents/skills/verify-jj-bot/scripts/pw.sh`, and `U` is `$(cat "$RUN/url")`.
- Target by ARIA role and accessible name (`getByRole(...)`), never by snapshot refs or CSS position.
- Treat quoted names as literal: accessible names include counts and states, such as `Bots 1` and `Nova Idle`.
- After a navigation or an action that loads data, snapshot again before you trust what the page shows.
- Read stored state with `curl -s "$U/api/..."` as the second view. Create state through the API only for preconditions the feature under test doesn't own, and say so.

## Proof and skip reporting

- Capture the action and the resulting state: an ARIA snapshot before and after, and a screenshot where layout or visuals matter.
- Confirm every mutation from a second view: the API's stored value, an artifact's bytes, a file in `$RUN/sandbox`, or a process that's gone.
- Record the feature and the entry point with each artifact in `$RUN/evidence`.
- Report an entry point you couldn't reach, with the attempted command and the unmet precondition. Never count a skipped entry point as verified through a different one.

## Feature entry contract

Each feature file starts with an H1 and one paragraph describing the user-visible behavior, then exactly four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with playwright-cli` (starting with `Preconditions:`, then labelled bullets pairing each user action with an exact command and its observable result), and `Gotchas`. Keep implementation details out; name user paths, stable handles, required state, commands and proof.

## Features

- [Bot studio](bot-studio.md): design and create a bot, edit it, cancel a draft.
- [Bot chat](bot-chat.md): direct chat with one bot, and a chat request that starts a task.
- [Tasks](tasks.md): start a task from the New task dialog, follow it to done, read its artifacts and progress, continue it.
- [Stop a task](stop-task.md): stop a running task and prove its work stopped.
- [Settings](settings.md): models, runtime profiles and sandbox drivers.
- [Spend caps](spend-caps.md): a task stopped at its cap and continued, a bot at its daily cap, and usage reporting.
- [Approvals](approvals.md): approval rules in a profile, a held call approved or denied in the task chat or from direct chat.
