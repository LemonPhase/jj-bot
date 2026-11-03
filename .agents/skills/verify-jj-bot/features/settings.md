# Settings

Settings shows which models the server can use and where each provider's key comes from, stores provider keys and sandbox secrets write-only (encrypted with the server's `JJ_SECRET_KEY`), lets a user manage runtime profiles (sandbox driver, network, workspace, limits, tools, granted secrets), and lists the sandbox drivers with their availability and isolation.

## Sub-features

- `settings-models` lists the server default and every provider, configured or not, and stores, replaces or removes a provider's key.
- `settings-secrets` stores, replaces and removes named sandbox secrets, and says how to enable the store when the server has no `JJ_SECRET_KEY`.
- `settings-grants` grants stored secrets to a runtime profile, whose task sandboxes then see them as environment variables.
- `settings-profiles` lists, creates, edits and deletes runtime profiles.
- `settings-drivers` lists each sandbox driver's availability and isolation.
- `settings-usage` reports spend against the caps ([spend-caps.md](spend-caps.md)).

## How to get to it (user POV)

- The `Settings` link at the bottom of the sidebar.
- The address `#/settings`.
- `See models in Settings` under the `Model` field in Studio.

## Driving it with playwright-cli

Preconditions:

- Doctor exits 0.

- **Open.** Run `$P "$RUN" open '#/settings'`. The heading `Settings` and the tabs `Models` (selected), `Secrets`, `Runtime profiles`, `Drivers` and `Usage` appear.
- **Models.** The tabpanel shows `Server default` and `Providers · 1 of 10 configured`, with `Scripted test model` configured and every real provider listed as unconfigured. Confirm with `curl -s "$U/api/models"`.
- **Profiles.** Run `$P "$RUN" click "getByRole('tab', { name: 'Runtime profiles' })"`. The panel lists `Local (unisolated) default` with `Edit` and `Delete`, plus a `New profile` button. Confirm with `curl -s "$U/api/runtime-profiles"`.
- **Store off.** On the default launch (no `JJ_SECRET_KEY`) the Models and Secrets tabs show `To store … here, give the server a secret key.` with the line `echo "JJ_SECRET_KEY=$(openssl rand -base64 32)" >> .env`, and offer no input. `curl -s "$U/api/secrets"` answers `{"available":false,"secrets":[]}`.
- **Store a provider key** (launch with `--secret-store`). In the article `Anthropic`, click `Store a key`, fill the `Anthropic API key` password field with any value of 16 or more characters and click `Store key`. The article says `Key stored here, ends in <last four>` and offers `Replace key` and `Remove key`; the badge stays honest (the value is not a working key). Confirm with `curl -s "$U/api/models"`: `keySource` `stored`, `storedKey.hint` the last four, and the value nowhere in the answer.
- **Store a sandbox secret** (`--secret-store`). Choose the `Secrets` tab, click `New secret`, fill `Name` (`GITHUB_TOKEN`) and `Value` (16+ characters), click `Store secret`. The article `GITHUB_TOKEN` shows `stored`, `ends in <last four>` and `No profile grants it.`. Confirm with `curl -s "$U/api/secrets"`.
- **Grant it.** On `Runtime profiles`, `Edit` the default profile, select the chip `GITHUB_TOKEN` under `Secrets` and `Save changes`; the card's facts read `secrets GITHUB_TOKEN`. A task whose command is ``run `echo "$GITHUB_TOKEN"` `` then shows `[redacted]` as that command's output in its activity. Confirm with `curl -s "$U/api/tasks/<taskId>/events"`: the value appears in no event.
- **Remove.** On `Secrets`, `Remove` opens a dialog `Remove GITHUB_TOKEN?` naming the granting profiles; `Remove secret` removes it and its grants.
- **Drivers.** Choose the `Drivers` tab (`$P "$RUN" click "getByRole('tab', { name: 'Drivers' })"`). The tabpanel shows the heading `Sandbox drivers`, a `Check again` button, and one article per registered driver. On the default launch that is only the article `Local (unisolated)`, marked `available`, with `Isolation: Unisolated`, `Network modes: open` and `Resource limits: not enforced`. With `--driver docker`, only `docker` is listed. Confirm with `curl -s "$U/api/sandbox-drivers"`.

## Gotchas

- Provider counts reflect the cleared environment of a verification instance, not your `.env`.
- Deleting a profile asks for confirmation in a dialog titled `Delete <profile name>?`, confirmed with `Delete profile`.
- The profile editor (`New profile`, `Edit`) and delete flows haven't been driven yet: take a snapshot of the editor before writing assertions against its fields.
- Values are write-only: after `Store …` the input is cleared and nothing on the page or in any answer shows the value again. Check the page source and the API answers for it, not only what is visible.
- A key stored for a provider the scripted instance cannot reach is not a working key; only the provider's status changes. A live provider call is out of scope here.
