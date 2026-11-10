import type { AuthSession, AuthState } from "@jj/contracts";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { useApi } from "../../api/ApiContext";
import type { SessionControls } from "../../api/client";
import {
  Button,
  Card,
  Dialog,
  ErrorBanner,
  Input,
  Spinner,
  StatusTag,
} from "../../components/ui";
import { formatDay, formatMessageTime } from "../../lib/format";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** "Last seen 14:20 · ends 16 Nov 2026" for a device. */
export function sessionFacts(session: AuthSession, now = new Date()): string {
  return `Signed in ${formatDay(session.createdAt)} · last seen ${formatMessageTime(session.lastSeenAt, now)} · ends ${formatDay(session.expiresAt)}`;
}

/**
 * Settings → Security: the devices signed in to this server, signing them
 * out, and replacing the access token. Only on a live server with sign-in.
 */
export function SecurityPanel() {
  const api = useApi();
  const headingId = useId();
  const auth = api.auth;
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="settings-section__head">
        <h2 className="settings-heading" id={headingId}>
          Security
        </h2>
      </div>
      {auth ? (
        <SignInSettings auth={auth} />
      ) : (
        <p className="settings-callout">
          {api.mode === "demo"
            ? "This is demo data: it has no sign-in, no devices and no token."
            : "This server has no sign-in routes: it predates signing in."}
        </p>
      )}
    </section>
  );
}

function SignInSettings({ auth }: { auth: SessionControls }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [sessions, setSessions] = useState<AuthSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotating, setRotating] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await auth.state();
      setState(next);
      setSessions(next.required ? await auth.sessions() : []);
      setError(null);
    } catch (reason) {
      setError(message(reason));
    }
  }, [auth]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: () => Promise<void>, after?: () => void) => {
    setBusy(true);
    try {
      await action();
      if (after) after();
      else await load();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  if (error && !state)
    return (
      <ErrorBanner word="Error">Security did not load: {error}</ErrorBanner>
    );
  if (!state || !sessions) return <Spinner label="Loading…" showLabel />;
  if (!state.required)
    return (
      <p className="settings-callout">
        <strong>This server asks for no sign-in.</strong> Without a token it
        answers only on this machine, on loopback. To use JJ Bot from another
        device, give it a token and serve it over HTTPS: see "Remote access" in{" "}
        <code className="settings-code">docs/development.md</code>.
      </p>
    );

  const others = sessions.filter((session) => !session.current);
  return (
    <>
      <p className="settings-callout">
        <strong>
          Sign-in takes the access token
          {state.methods.password ? " or the password" : ""}.
        </strong>{" "}
        Each browser that signs in is a device below, kept for 30 days, or until
        it goes unused for 7. Scripts and metrics send the token as{" "}
        <code className="settings-code">Authorization: Bearer</code>.
      </p>
      {error && <ErrorBanner word="Error">{error}</ErrorBanner>}
      <div className="settings-block">
        <div className="settings-section__head">
          <h3 className="settings-card__title">Signed-in devices</h3>
          <Button
            size="sm"
            disabled={busy || others.length === 0}
            onClick={() => act(() => auth.signOutOthers())}
          >
            Sign out other devices
          </Button>
        </div>
        {sessions.length === 0 ? (
          <p className="settings-meta">
            No browser is signed in: this page was opened with the token.
          </p>
        ) : (
          <ul className="settings-list">
            {sessions.map((session) => (
              <li key={session.id}>
                <Card
                  as="article"
                  className="settings-card"
                  aria-label={session.label}
                >
                  <div className="settings-card__head">
                    <span className="settings-card__title">
                      {session.label}
                    </span>
                    {session.current && (
                      <StatusTag tone="completed">this device</StatusTag>
                    )}
                  </div>
                  <p className="settings-facts">{sessionFacts(session)}</p>
                  <div className="settings-card__actions">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        session.current
                          ? act(() => auth.logout(), auth.ended)
                          : act(() => auth.signOut(session.id))
                      }
                    >
                      Sign out
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="settings-block">
        <h3 className="settings-card__title">Access token</h3>
        <p className="settings-meta">
          Replacing the token signs out every other device and every script that
          uses the old one. A token set with API_TOKEN is changed on the server
          instead.
        </p>
        <div className="settings-card__actions">
          <Button size="sm" disabled={busy} onClick={() => setRotating(true)}>
            Rotate token
          </Button>
        </div>
      </div>
      {rotating && (
        <RotateDialog
          auth={auth}
          password={state.methods.password}
          onClose={() => {
            setRotating(false);
            void load();
          }}
        />
      )}
    </>
  );
}

/** Proves the current token or password, then shows the new token once. */
function RotateDialog({
  auth,
  password,
  onClose,
}: {
  auth: SessionControls;
  password: boolean;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<"token" | "password">("token");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setToken(
        await auth.rotateToken(
          method === "token" ? { token: value.trim() } : { password: value },
        ),
      );
      setValue("");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setError("Copying was refused: select the token and copy it.");
    }
  };

  if (token)
    return (
      <Dialog
        open
        onClose={onClose}
        title="New access token"
        footer={
          <>
            <Button onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        <p className="settings-warning">
          It is shown this once. Every other device is signed out, and scripts
          need the new token.
        </p>
        <Input
          label="New token"
          readOnly
          value={token}
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
        {error && <ErrorBanner word="Error">{error}</ErrorBanner>}
      </Dialog>
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Rotate the access token"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="rotate-token-form"
            disabled={busy || !value.trim()}
          >
            {busy ? "Rotating…" : "Rotate token"}
          </Button>
        </>
      }
    >
      <form id="rotate-token-form" className="settings-form" onSubmit={submit}>
        <Input
          key={method}
          label={method === "token" ? "Current access token" : "Password"}
          type="password"
          autoComplete={method === "token" ? "off" : "current-password"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoFocus
        />
        {password && (
          <Button
            size="sm"
            onClick={() => {
              setMethod(method === "token" ? "password" : "token");
              setValue("");
            }}
          >
            {method === "token" ? "Use password" : "Use access token"}
          </Button>
        )}
        {error && <ErrorBanner word="Error">{error}</ErrorBanner>}
      </form>
    </Dialog>
  );
}
