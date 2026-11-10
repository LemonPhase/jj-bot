# Sign-in

On a server that asks to sign in, a browser that is not signed in opens on the login screen (`#/login`): the access token, or the password when the server has one, or the one-time login link the server printed at boot, which signs the browser in by itself. Signing in sets an `HttpOnly` session cookie; after it the app holds no credential, and no URL, `Referer` or storage carries one. Settings → Security lists the signed-in devices, signs one or every other device out, and rotates a generated token.

## Sub-features

- `login-link` signs a browser in once with the code in the boot line's link (`#/login?code=…`), which then leaves the address bar.
- `login-token` and `login-password` sign in from the form; `Use password` shows only when the server has one.
- `login-limits` counts down after 5 failed sign-ins (the password field only; the right token still signs in).
- `login-return` opens where the user was going (a deep link, or the screen a session ended on).
- `security-devices` lists devices, marks `this device`, signs one out, the others, or this one.
- `security-rotate` replaces a generated token, shown once with `Copy`.

## How to get to it (user POV)

- Any address of an instance launched with `--auth`, while the browser is signed out.
- The `Open JJ Bot: …/#/login?code=…` line in `$RUN/server.log`.
- The `Settings` link, then the `Security` tab.

## Driving it with playwright-cli

Preconditions:

- Launch with `--auth`: `RUN=$(.agents/skills/verify-jj-bot/scripts/launch.sh --auth)`. The token is in `$RUN/token`, the password in `$RUN/password`; doctor uses the token. Every `curl` to `/api` needs `-H "Authorization: Bearer $(cat "$RUN/token")"`.

- **Login screen.** Run `$P "$RUN" open '#/settings'`. The address becomes `#/login` and the heading `Sign in`, the password field `Access token`, the button `Sign in` (disabled while empty) and the button `Use password` appear.
- **Link.** Run `$P "$RUN" goto "$(grep -o 'Open JJ Bot: [^"]*' "$RUN/server.log" | tail -1 | cut -d' ' -f4)"`. The workspace opens with the `Scripted model` badge and the address holds no `code=`. Opening the same link in another session (`playwright-cli -s=other open …`) shows `Sign in` with `A login link works once` in the error.
- **Token.** On the login screen, fill `Access token` with `$(cat "$RUN/token")` and click `Sign in`. The screen the user was going to opens (`#/settings` above).
- **Password and limits.** Click `Use password`, then `Sign in` five times with a wrong value: each shows `Sign-in failed: the token, password or link is wrong, used or expired.` The sixth, even with `$(cat "$RUN/password")`, shows `Too many failed sign-ins. Try again in 14:59, or use the access token, which still signs in.` and disables `Sign in`; `Use access token` and the token still sign in.
- **No credential left.** Run `$P "$RUN" cookie-list`: one cookie `jj_session`, `httpOnly` true, `sameSite` Strict. Run `$P "$RUN" eval "JSON.stringify(localStorage)"`: no token or code.
- **Devices.** Choose `Security` in Settings. One article per device, named by its browser and system, with `this device` on this one, and `Sign out` on each; `Sign out other devices` signs out the rest. Confirm with `curl -s -H "Authorization: Bearer $(cat "$RUN/token")" "$U/api/auth/sessions"`.
- **Rotate.** Click `Rotate token`, fill `Current access token`, click `Rotate token`. The dialog `New access token` shows the token once with `Copy`; the old token now gets 401 (`curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$RUN/token")" "$U/api/bootstrap"`), so write the new one to `$RUN/token` before using doctor again.
- **Signed out elsewhere.** Sign in a second session, and click `Sign out other devices` there: the first page returns to `Sign in` within a few seconds, and signing in takes it back to the screen it was on.

## Gotchas

- A launch without `--auth` asks for no sign-in: Security then says `This server asks for no sign-in.`
- The login screen loads only for a signed-out browser; the workspace never shows behind it.
- Each failed sign-in counts against the instance for 15 minutes, per client: drive the limits last, or relaunch.
- Rotating the token signs out every other device and ends their streams, the second session's included.
