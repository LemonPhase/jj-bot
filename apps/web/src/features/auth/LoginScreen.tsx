import type { AuthState } from "@jj/contracts";
import { type FormEvent, useEffect, useId, useState } from "react";
import { type AuthApi, retryAfterSeconds } from "../../api/auth";
import { Button, ErrorBanner, Input, Wordmark } from "../../components/ui";
import "./auth.css";

/** `m:ss` for a countdown. */
export function clockText(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * `#/login`: signs this browser in with the access token, or the password
 * when the server has one. The server answers with a session cookie the app
 * never reads, so nothing typed here is kept. Every failure reads the same
 * (the server's one message); too many failures count down to the next try.
 */
export default function LoginScreen({
  auth,
  state,
  error: initialError,
  onSignedIn,
}: {
  auth: AuthApi;
  state: AuthState;
  error?: string;
  onSignedIn: () => void;
}) {
  const headingId = useId();
  const [method, setMethod] = useState<"token" | "password">("token");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  // Only the password waits: the right token always signs in, so the owner
  // is never locked out.
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const waiting =
    method === "password" && waitUntil !== null && waitUntil > now;

  useEffect(() => {
    if (waitUntil === null) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= waitUntil) {
        setWaitUntil(null);
        setError(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [waitUntil]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || waiting || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await auth.login(
        method === "token" ? { token: value.trim() } : { password: value },
      );
      setValue("");
      onSignedIn();
    } catch (reason) {
      const seconds = retryAfterSeconds(reason);
      if (seconds !== null && method === "password") {
        setNow(Date.now());
        setWaitUntil(Date.now() + seconds * 1000);
      }
      setError(
        seconds !== null && method === "token"
          ? "Too many failed sign-ins from this device. The right token still signs in: check it, or open a login link."
          : reason instanceof Error
            ? reason.message
            : String(reason),
      );
      setBusy(false);
    }
  };

  const switchMethod = () => {
    setMethod(method === "token" ? "password" : "token");
    setValue("");
    setError(null);
  };

  return (
    <main className="login-screen">
      <section className="login-card" aria-labelledby={headingId}>
        <Wordmark markSize={36} className="login-card__mark" />
        <h1 className="login-card__title" id={headingId}>
          Sign in
        </h1>
        <p className="login-card__lead">
          {method === "token"
            ? "Enter this server's access token, or open the login link it printed when it started."
            : "Enter the password set on this server."}
        </p>
        <form className="login-form" onSubmit={submit} noValidate>
          {method === "token" ? (
            <Input
              key="token"
              label="Access token"
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              hint={
                <>
                  On the server, <code>npm run auth:token</code> prints it, and{" "}
                  <code>npm run auth:login-link</code> prints a new link.
                </>
              }
              autoFocus
            />
          ) : (
            <Input
              key="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
            />
          )}
          {waiting && waitUntil !== null ? (
            <ErrorBanner word="Wait">
              {`Too many failed sign-ins. Try again in ${clockText((waitUntil - now) / 1000)}, or use the access token, which still signs in.`}
            </ErrorBanner>
          ) : (
            error && <ErrorBanner word="Couldn't sign in">{error}</ErrorBanner>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={busy || waiting || !value.trim()}
          >
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          {state.methods.password && (
            <button
              type="button"
              className="login-form__switch"
              onClick={switchMethod}
            >
              {method === "token" ? "Use password" : "Use access token"}
            </button>
          )}
        </form>
      </section>
    </main>
  );
}
