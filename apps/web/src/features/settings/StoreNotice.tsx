import { ENABLE_STORE_COMMAND } from "./secrets";

/**
 * Shown where keys or secrets could be entered while the server has no
 * `JJ_SECRET_KEY`: what it is and the one line that sets it.
 */
export function StoreNotice({ what }: { what: string }) {
  return (
    <div className="settings-callout settings-store-notice">
      <p>
        <strong>To store {what} here, give the server a secret key.</strong>{" "}
        Stored values are encrypted with{" "}
        <code className="settings-code">JJ_SECRET_KEY</code>, which only the
        server's environment holds, so the database alone reveals none of them.
        Run this where the server's <code className="settings-code">.env</code>{" "}
        is, then restart the server:
      </p>
      <pre className="settings-command">
        <code>{ENABLE_STORE_COMMAND}</code>
      </pre>
      <p>
        Keep a copy of the key somewhere safe, apart from database backups:
        without it, stored values cannot be recovered.
      </p>
    </div>
  );
}
