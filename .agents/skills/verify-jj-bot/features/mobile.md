# Phone layout and the installable app

Below 760px wide the app is laid out for a phone: a top bar with a `Menu` button and the mode badge replaces the sidebar, which opens as a drawer; nothing scrolls sideways; every control is a 44px touch target; a task's chat fills the first screen with its Progress, Graph and Office panel below; and the office is 2D only. The built app is installable, with a manifest, icons and a service worker that caches only the app shell, never `/api`.

## Sub-features

- `mobile-nav` opens the sidebar as the `Menu` drawer, keeps it open across the Bots/Tasks switch and closes it on a row, a link, Escape, its close button or the backdrop.
- `mobile-screens` lays out Bots and direct chat, Tasks (Progress, Graph, Office 2D), Studio and Settings at 360 to 430px in both themes.
- `mobile-office` offers 2D only on a phone or without WebGL, and says why under the 2D/3D switch.
- `pwa-install` serves the manifest and icons and registers the service worker.
- `pwa-cache` serves the shell from the service worker's cache (offline too), takes `index.html` from the network first, never handles `/api`, never keeps a maintenance page, a redirect or the demo data's chunk, and offline says the API is unreachable instead of showing demo data.

## How to get to it (user POV)

- Any screen on a phone, or a desktop browser narrower than 760px.
- The browser's install prompt or Add to Home Screen, on the built app.

## Driving it with playwright-cli

Preconditions:

- Doctor exits 0. Bots and tasks to show: create them as in [bot-studio.md](bot-studio.md) and [tasks.md](tasks.md), or through the API for screens that are not under test (say so).

- **Phone width.** Run `$P "$RUN" open '#/bots'`, then `$P "$RUN" resize 390 844`. The top bar shows `Menu`, the brand and the mode badge `Scripted model`; the landmark `Navigation` is hidden. Run `$P "$RUN" run-code "async (page) => page.evaluate(() => document.scrollingElement.scrollWidth)"`: it prints the window width (`390`), never more.
- **Menu.** Run `$P "$RUN" click "getByRole('button', { name: 'Menu', exact: true })"`. The dialog `Menu` holds the sidebar: `New bot`, `Close menu`, the `Primary` switch, the list and the footer. `Tasks` switches the list and keeps the drawer open; a row in the list opens its screen and closes it, and focus returns to `Menu`. `$P "$RUN" press Escape` closes it as well.
- **Themes.** Run `$P "$RUN" localstorage-set jj.theme dark` and `$P "$RUN" reload` (`run-code "async (page) => page.evaluate(() => document.documentElement.dataset.theme)"` prints `dark`), then screenshot each screen (`screenshot --filename=<nn>-<screen>-dark.png`); `light` for the other theme. A screen's own pane scrolls, not the page: scroll that pane to capture the rest of it.
- **Office.** On a task, choose the tab `Office`: the radio `3D` is disabled and the line under the switch reads `3D needs a wider screen. The 2D office shows the same task.` The 2D office is the image `Pixel office acting out the task conversation`.
- **Install.** On the built app, `curl -s "$U/manifest.webmanifest"` shows `name` `JJ Bot`, `display` `standalone` and icons of 192 and 512 px (one `maskable`). Run `$P "$RUN" run-code "async (page) => page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r && r.active && r.active.scriptURL))"` after a load: it prints `$U/sw.js`.
- **Cache.** Run `$P "$RUN" run-code "async (page) => page.evaluate(() => caches.keys().then((names) => caches.open(names[0])).then((c) => c.keys()).then((keys) => keys.map((k) => new URL(k.url).pathname)))"`: only `/index.html` and hashed `/assets/…` files, never `/api` and never `/assets/demoApi-…`, even after a `?demo` visit. `$P "$RUN" network-state-set offline`, `$P "$RUN" reload` and a snapshot: the app still opens and reads `Couldn't load The JJ Bot API isn't reachable.` with `Reload`, and no `Demo data` badge; `network-state-set online` restores it.

## Gotchas

- `resize` changes the window, not the device: there is no touch emulation, so hover styles still apply. `npm run test:browser` (`apps/web/e2e/mobile.e2e.ts`) runs the screens on an emulated touch phone at 360px.
- Snapshots taken right after `resize` can show the old layout for a frame; snapshot again.
- The service worker registers only in the built app (`launch.sh` builds it) and controls the page from its first load on; `delete-data` or a new browser session starts without it.
