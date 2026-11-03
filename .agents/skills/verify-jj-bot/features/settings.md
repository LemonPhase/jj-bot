# Settings

Settings shows which models the server can use, lets a user manage runtime profiles (sandbox driver, network, workspace, limits, tools), and lists the sandbox drivers with their availability and isolation.

## Sub-features

- `settings-models` lists the server default and every provider, configured or not.
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

- **Open.** Run `$P "$RUN" open '#/settings'`. The heading `Settings` and the tabs `Models` (selected), `Runtime profiles`, `Drivers` and `Usage` appear.
- **Models.** The tabpanel shows `Server default` and `Providers · 1 of 10 configured`, with `Scripted test model` configured and every real provider listed as unconfigured. Confirm with `curl -s "$U/api/models"`.
- **Profiles.** Run `$P "$RUN" click "getByRole('tab', { name: 'Runtime profiles' })"`. The panel lists `Local (unisolated) default` with `Edit` and `Delete`, plus a `New profile` button. Confirm with `curl -s "$U/api/runtime-profiles"`.
- **Drivers.** Choose the `Drivers` tab (`$P "$RUN" click "getByRole('tab', { name: 'Drivers' })"`). The tabpanel shows the heading `Sandbox drivers`, a `Check again` button, and one article per registered driver. On the default launch that is only the article `Local (unisolated)`, marked `available`, with `Isolation: Unisolated`, `Network modes: open` and `Resource limits: not enforced`. With `--driver docker`, only `docker` is listed. Confirm with `curl -s "$U/api/sandbox-drivers"`.

## Gotchas

- Provider counts reflect the cleared environment of a verification instance, not your `.env`.
- Deleting a profile asks for confirmation in a dialog titled `Delete <profile name>?`, confirmed with `Delete profile`.
- A profile's `Edit` replaces the list with the region `Edit <profile name>`: the textboxes `Name` and `Description`, the sandbox fields, the spinbuttons `Max turns per run` and `Max minutes per run`, and `Save changes`, disabled (with the status `No changes to save.`) until a field changes. Saving returns to the list.
- `New profile` and the delete flow haven't been driven yet: take a snapshot before writing assertions against them.
