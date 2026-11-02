# Bot studio

Studio lets a user design a bot (name, role, instructions, model, runtime profile and a pixel-figure appearance), create it, and find it in the sidebar and its chat screen.

## Sub-features

- `studio-open` opens a blank design from each entry point.
- `studio-create` saves a new bot with the entered details and the parts shown in the preview.
- `studio-cancel` leaves without creating a bot.
- `studio-edit` reopens an existing bot at `#/studio/:botId` and saves changes.

## How to get to it (user POV)

- The `New bot` button at the top of the sidebar.
- The `New bot` button under "No bots yet." when the workspace is empty.
- The address `#/studio` (redirects to `#/studio/new`); `#/studio/:botId` for an existing bot.

## Driving it with playwright-cli

Preconditions:

- Doctor exits 0. No bot is named `Nova` (`curl -s "$U/api/bots"`).

- **Open studio.** Choose `New bot`. Run `$P "$RUN" open '#/studio'`, or `$P "$RUN" click "getByRole('button', { name: 'New bot' }).first()"` from any screen. The URL becomes `#/studio/new` and the heading `Design a bot` appears with a form named `Design a bot`.
- **Enter details.** Fill the name and role. Run `$P "$RUN" fill "getByRole('textbox', { name: 'Name' })" "Nova"` and `$P "$RUN" fill "getByRole('textbox', { name: 'Role' })" "Research"`. The preview card reads `Nova`. Other fields: the textbox `Instructions`, the comboboxes `Model` and `Runtime profile`.
- **Pick parts.** Optional. Each part is a radiogroup: `Shape`, `Face`, `Topper`, `Colour`, `Body`, `Walk`, and the presets in `Start from`. Run e.g. `$P "$RUN" click "getByRole('radiogroup', { name: 'Colour' }).getByRole('radio', { name: 'Teal' })"`. The preview image's name lists the chosen parts, such as `Preview of Nova: Gem · Dots · Propeller · Teal · Graphite · Glide. ...`.
- **Capture the draft.** Run `$P "$RUN" screenshot --filename=01-studio-filled.png` and `$P "$RUN" snapshot --filename=01-studio-filled.yml`.
- **Create.** Choose `Create bot`. Run `$P "$RUN" click "getByRole('button', { name: 'Create bot' })"`. The URL becomes `#/bots/<botId>`, the sidebar's `Bots` button reads `Bots 1` with a list item `Nova Idle`, and the main region is named `Chat with Nova` with a region `About Nova` showing the role.
- **Confirm persistence.** Run `curl -s "$U/api/bots" > "$RUN/evidence/02-bots.json"`. It holds one bot named `Nova` with role `Research`, and its `appearance` matches the parts named in the preview image from the draft capture. Reload (`$P "$RUN" reload`) and the bot is still listed.
- **Cancel.** Open studio again, fill `Name` with `Discard me`, choose `Cancel` (`$P "$RUN" click "getByRole('button', { name: 'Cancel' })"`). No bot named `Discard me` appears in the sidebar or in `/api/bots`.

## Gotchas

- A new draft's parts are randomized once the workspace loads, so a snapshot taken during `Loading workspace…` shows different parts from what gets saved. Read the parts from the preview right before `Create bot`, or set every radiogroup explicitly when a check depends on them.
- `New bot` appears twice when the workspace is empty (sidebar header and empty state); use `.first()` or scope the locator.
- Only the scripted model is selectable. Every provider option is disabled with "Set <KEY> on the server", which is expected on a verification instance, not a bug.
- `studio-edit` hasn't been driven yet: confirm its button names from a snapshot before relying on them.
- The `Profile` button on a bot's chat screen does not open Studio. It opens the bot inspector on the same screen ([bot-chat.md](bot-chat.md)).
