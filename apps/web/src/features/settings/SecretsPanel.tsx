import {
  type RuntimeProfile,
  type SecretInfo,
  secretNameSchema,
} from "@jj/contracts";
import { type FormEvent, useId, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { isApiError } from "../../api/client";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBanner,
  Input,
  Spinner,
  StatusTag,
} from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { StoreNotice } from "./StoreNotice";
import {
  grantingProfiles,
  type ServerError,
  storedLabel,
  unreadableText,
} from "./secrets";
import type { DriversState } from "./useDrivers";
import { useSecrets } from "./useSecrets";

const toServerError = (reason: unknown, fallback: string): ServerError => ({
  code: isApiError(reason) ? reason.code : "Error",
  message: reason instanceof Error ? reason.message : fallback,
});

/**
 * Settings → Secrets: named values, such as a Git token, that runtime
 * profiles grant to their sandboxes. Values are write-only: the list shows
 * names, last four characters and dates, never a value.
 */
export function SecretsPanel({ drivers }: { drivers: DriversState }) {
  const api = useApi();
  const { profiles, refreshProfiles } = useWorkspace();
  const { view, error, reload } = useSecrets();
  const headingId = useId();
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SecretInfo | null>(null);
  const store = view?.available ?? api.capabilities.secretStore;
  const unisolated = (drivers.drivers ?? []).some(
    (driver) => !driver.capabilities.filesystemIsolation,
  );
  const changed = () => {
    reload();
    void refreshProfiles().catch(() => {});
  };

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="settings-section__head">
        <h2 className="settings-heading" id={headingId}>
          Secrets
        </h2>
        {store && !adding && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            New secret
          </Button>
        )}
      </div>
      <p className="settings-callout">
        <strong>Secrets reach sandboxes by name.</strong> A runtime profile
        grants a secret; every command in the sandbox of a task that profile
        coordinates then sees it as an environment variable, whichever bot runs
        the command. Values are stored encrypted, never shown again and replaced
        with <code className="settings-code">[redacted]</code> in task history.
        Model keys never enter a sandbox.
      </p>
      {unisolated && (
        <p className="settings-warning">
          This server has an unisolated driver (local). Commands on an
          unisolated profile run as the server's user: they can read the
          server's environment, its JJ_SECRET_KEY and its database, and so every
          stored secret, not only the granted ones.
        </p>
      )}
      {!store && api.mode === "live" && <StoreNotice what="secrets" />}
      {error && (
        <ErrorBanner word="Error">Secrets did not load: {error}</ErrorBanner>
      )}
      {adding && (
        <SecretForm
          onDone={() => {
            setAdding(false);
            changed();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {!view && !error && <Spinner label="Loading secrets…" showLabel />}
      {view &&
        (view.secrets.length === 0 ? (
          !adding && (
            <EmptyState
              message="No secrets are stored."
              action={
                store ? (
                  <Button variant="primary" onClick={() => setAdding(true)}>
                    New secret
                  </Button>
                ) : undefined
              }
            />
          )
        ) : (
          <ul className="settings-list">
            {view.secrets.map((secret) => (
              <li key={secret.name}>
                <SecretCard
                  secret={secret}
                  store={store}
                  profiles={grantingProfiles(secret.name, profiles)}
                  replacing={replacing === secret.name}
                  onReplace={() => setReplacing(secret.name)}
                  onReplaced={() => {
                    setReplacing(null);
                    changed();
                  }}
                  onCancel={() => setReplacing(null)}
                  onRemove={() => setRemoving(secret)}
                />
              </li>
            ))}
          </ul>
        ))}
      {removing && (
        <RemoveDialog
          secret={removing}
          profiles={grantingProfiles(removing.name, profiles)}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            changed();
          }}
        />
      )}
    </section>
  );
}

function SecretCard({
  secret,
  store,
  profiles,
  replacing,
  onReplace,
  onReplaced,
  onCancel,
  onRemove,
}: {
  secret: SecretInfo;
  store: boolean;
  profiles: readonly RuntimeProfile[];
  replacing: boolean;
  onReplace: () => void;
  onReplaced: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  return (
    <Card as="article" className="settings-card" aria-label={secret.name}>
      <div className="settings-card__head">
        <h3 className="settings-card__title">
          <code className="settings-code">{secret.name}</code>
        </h3>
        {secret.readable ? (
          <StatusTag tone="completed">stored</StatusTag>
        ) : (
          <StatusTag tone="failed">unreadable</StatusTag>
        )}
      </div>
      <p className="settings-facts">{storedLabel(secret)}</p>
      {!secret.readable && (
        <p className="settings-warning">{unreadableText(store)}</p>
      )}
      <p className="settings-meta">
        {profiles.length > 0
          ? `Granted by ${profiles.map((profile) => profile.name).join(", ")}.`
          : "No profile grants it."}
      </p>
      {replacing ? (
        <SecretForm
          name={secret.name}
          onDone={onReplaced}
          onCancel={onCancel}
        />
      ) : (
        <div className="settings-card__actions">
          {store && (
            <Button size="sm" onClick={onReplace}>
              Replace value
            </Button>
          )}
          <Button size="sm" onClick={onRemove}>
            Remove
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Stores a new secret, or a new value for `name`. The value is cleared once sent. */
function SecretForm({
  name: fixedName,
  onDone,
  onCancel,
}: {
  name?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const [name, setName] = useState(fixedName ?? "");
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const parsedName = secretNameSchema.safeParse(name.trim());
  const nameError =
    submitted && !fixedName && !parsedName.success
      ? (parsedName.error.issues[0]?.message ?? "Enter a name.")
      : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (busy || !parsedName.success || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.putSecret(parsedName.data, { value });
      setValue("");
      onDone();
    } catch (reason) {
      setError(toServerError(reason, "The secret was not stored."));
      setBusy(false);
    }
  };

  return (
    <form
      className="settings-key-form settings-secret-form"
      onSubmit={submit}
      noValidate
    >
      {error && (
        <ErrorBanner word={error.code} onDismiss={() => setError(null)}>
          {error.message}
        </ErrorBanner>
      )}
      {!fixedName && (
        <Input
          label="Name"
          value={name}
          placeholder="GITHUB_TOKEN"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          maxLength={64}
          error={nameError}
          hint="The environment variable commands see it as: capital letters, digits and underscores."
          onChange={(event) => setName(event.target.value.toUpperCase())}
        />
      )}
      <Input
        type="password"
        label={fixedName ? `New value for ${fixedName}` : "Value"}
        autoComplete="new-password"
        spellCheck={false}
        autoFocus={Boolean(fixedName)}
        value={value}
        error={submitted && !value.trim() ? "Enter the value." : undefined}
        hint="At least 16 characters, one line. Sent once, stored encrypted, never shown again."
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="settings-card__actions">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy ? "Storing…" : fixedName ? "Store new value" : "Store secret"}
        </Button>
        <Button size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RemoveDialog({
  secret,
  profiles,
  onClose,
  onRemoved,
}: {
  secret: SecretInfo;
  profiles: readonly RuntimeProfile[];
  onClose: () => void;
  onRemoved: () => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteSecret(secret.name);
      onRemoved();
    } catch (reason) {
      setError(toServerError(reason, "The secret was not removed."));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={`Remove ${secret.name}?`}
      description={
        profiles.length > 0
          ? `This also removes it from ${profiles.map((profile) => profile.name).join(", ")}. A task sandbox already running keeps the value until it is released, so revoke a leaked token where it was issued.`
          : "This cannot be undone. A task sandbox already running keeps the value until it is released."
      }
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => void remove()}
            disabled={busy}
          >
            {busy ? "Removing…" : "Remove secret"}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner word={error.code}>{error.message}</ErrorBanner>}
    </Dialog>
  );
}
