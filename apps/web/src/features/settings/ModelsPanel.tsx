import type { ModelsView, ProviderInfo } from "@jj/contracts";
import { type FormEvent, useId, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { isApiError } from "../../api/client";
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Input,
  SectionLabel,
  Spinner,
  StatusTag,
} from "../../components/ui";
import { useModels } from "../bots/useModels";
import {
  enableHint,
  findModel,
  formatContextWindow,
  formatCost,
  isScriptedProvider,
  sortProviders,
} from "./models";
import { StoreNotice } from "./StoreNotice";
import { type ServerError, storedLabel, unreadableText } from "./secrets";

/**
 * Settings → Models: the server default, then every provider, its key and
 * its models. A key can be stored here (encrypted with the server's
 * `JJ_SECRET_KEY`); a key set as a server variable takes precedence. Stored
 * keys are never shown again, only their last four characters.
 */
export function ModelsPanel() {
  const api = useApi();
  const { models, error, replace } = useModels();
  const headingId = useId();
  const store = api.capabilities.secretStore;
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h2 className="settings-heading" id={headingId}>
        Models
      </h2>
      {store ? (
        <p className="settings-callout">
          <strong>Keys entered here are stored encrypted</strong> with the
          server's <code className="settings-code">JJ_SECRET_KEY</code> and are
          never shown again, only their last four characters. A key set as an
          environment variable on the server takes precedence over a stored one.
          Model keys never enter a sandbox.
        </p>
      ) : (
        <>
          <p className="settings-callout">
            Each provider is enabled by an API key set as an environment
            variable on the server.
          </p>
          {api.mode === "live" && <StoreNotice what="provider keys" />}
        </>
      )}
      {error && (
        <ErrorBanner word="Error">Models did not load: {error}</ErrorBanner>
      )}
      {!models && !error && <Spinner label="Loading models…" showLabel />}
      {models && <ModelsList view={models} store={store} onChanged={replace} />}
    </section>
  );
}

function ModelsList({
  view,
  store,
  onChanged,
}: {
  view: ModelsView;
  store: boolean;
  onChanged: (view: ModelsView) => void;
}) {
  const providers = sortProviders(view.providers);
  const configured = providers.filter((provider) => provider.configured);
  const fallback = findModel(view, view.defaultModel);
  return (
    <>
      <div className="settings-block">
        <SectionLabel as="h3" tracking="part">
          Server default
        </SectionLabel>
        <Card className="settings-default">
          {view.defaultModel ? (
            <>
              <span className="settings-default__name">
                {fallback?.model.name ?? view.defaultModel}
                {fallback && isScriptedProvider(fallback.provider) && (
                  <Badge>not a real model</Badge>
                )}
              </span>
              <code className="settings-code">{view.defaultModel}</code>
            </>
          ) : (
            <span className="settings-default__name">
              None: no provider is configured, so bots cannot run.
            </span>
          )}
        </Card>
        <p className="settings-hint">
          Bots without a model of their own use it. The server picks it:{" "}
          <code className="settings-code">JJ_DEFAULT_MODEL</code> when it names
          a configured model, else a model of the first configured provider.
        </p>
      </div>

      <div className="settings-block">
        <SectionLabel as="h3" tracking="part">
          Providers · {configured.length} of {providers.length} configured
        </SectionLabel>
        {providers.length === 0 ? (
          <p className="settings-empty">This server lists no providers.</p>
        ) : (
          <ul className="settings-list">
            {providers.map((provider) => (
              <li key={provider.id}>
                <ProviderCard
                  provider={provider}
                  defaultModel={view.defaultModel}
                  store={store}
                  onChanged={onChanged}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function ProviderCard({
  provider,
  defaultModel,
  store,
  onChanged,
}: {
  provider: ProviderInfo;
  defaultModel: string | null;
  store: boolean;
  onChanged: (view: ModelsView) => void;
}) {
  const scripted = isScriptedProvider(provider);
  return (
    <Card as="article" className="settings-card" aria-label={provider.name}>
      <div className="settings-card__head">
        <h4 className="settings-card__title">
          {provider.name}
          {scripted && <Badge>Scripted test model · not a real model</Badge>}
        </h4>
        {provider.configured ? (
          <StatusTag tone="completed">configured</StatusTag>
        ) : (
          <StatusTag tone="idle">not configured</StatusTag>
        )}
      </div>
      {provider.envVars.length > 0 ? (
        <ProviderKey provider={provider} store={store} onChanged={onChanged} />
      ) : (
        <p className="settings-meta">
          {enableHint(provider)}
          {scripted &&
            ". Deterministic replies for tests and demos; nothing is generated by a model."}
        </p>
      )}
      {provider.models.length > 0 && (
        <details className="settings-details" open={provider.configured}>
          <summary>
            {provider.models.length}{" "}
            {provider.models.length === 1 ? "model" : "models"}
          </summary>
          <div className="settings-table-wrap">
            <table className="settings-table">
              <caption className="visually-hidden">
                {provider.name} models
              </caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Context</th>
                  <th scope="col">Reasoning</th>
                  <th scope="col">Cost per MTok</th>
                </tr>
              </thead>
              <tbody>
                {provider.models.map((model) => (
                  <tr key={model.ref}>
                    <th scope="row">
                      <span className="settings-table__name">
                        {model.name}
                        {model.ref === defaultModel && (
                          <Badge variant="step">default</Badge>
                        )}
                      </span>
                      <code className="settings-code">{model.ref}</code>
                    </th>
                    <td>{formatContextWindow(model.contextWindow)}</td>
                    <td>{model.reasoning ? "yes" : "no"}</td>
                    <td>{formatCost(model.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </Card>
  );
}

function EnvNames({ names }: { names: readonly string[] }) {
  return (
    <>
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 && " or "}
          <code className="settings-code">{name}</code>
        </span>
      ))}
    </>
  );
}

const toServerError = (reason: unknown, fallback: string): ServerError => ({
  code: isApiError(reason) ? reason.code : "Error",
  message: reason instanceof Error ? reason.message : fallback,
});

/**
 * Where the provider's key comes from, and the controls to store, replace or
 * remove one. The value typed is sent once and cleared; nothing shows it again.
 */
function ProviderKey({
  provider,
  store,
  onChanged,
}: {
  provider: ProviderInfo;
  store: boolean;
  onChanged: (view: ModelsView) => void;
}) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState<ServerError | null>(null);
  const stored = provider.storedKey;
  const fromEnv = provider.keySource === "env";

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !value.trim()) return;
    setBusy("save");
    setError(null);
    try {
      onChanged(await api.putProviderKey(provider.id, { value }));
      setValue("");
      setEditing(false);
    } catch (reason) {
      setError(toServerError(reason, "The key was not stored."));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy("remove");
    setError(null);
    try {
      onChanged(await api.deleteProviderKey(provider.id));
      setEditing(false);
    } catch (reason) {
      setError(toServerError(reason, "The key was not removed."));
    } finally {
      setBusy(null);
    }
  };

  const removeButton = (label: string) => (
    <Button size="sm" onClick={() => void remove()} disabled={busy !== null}>
      {busy === "remove" ? "Removing…" : label}
    </Button>
  );

  return (
    <div className="settings-key">
      {fromEnv ? (
        <p className="settings-meta">
          Key from <EnvNames names={provider.envVars} /> on the server. It takes
          precedence over a key stored here.
        </p>
      ) : stored?.readable ? (
        <p className="settings-meta">
          Key stored here, {storedLabel(stored)}. Setting{" "}
          <EnvNames names={provider.envVars} /> on the server would take
          precedence.
        </p>
      ) : stored ? (
        <p className="settings-warning">
          A key is stored ({storedLabel(stored)}). {unreadableText(store)}
        </p>
      ) : (
        <p className="settings-meta">
          Set <EnvNames names={provider.envVars} /> on the server
          {store ? ", or store a key here," : ""} to enable it.
        </p>
      )}
      {fromEnv && stored && (
        <p className="settings-meta">
          A stored key ({storedLabel(stored)}) is not used while the variable is
          set.
        </p>
      )}
      {error && (
        <ErrorBanner word={error.code} onDismiss={() => setError(null)}>
          {error.message}
        </ErrorBanner>
      )}
      {editing ? (
        <form className="settings-key-form" onSubmit={save}>
          <Input
            type="password"
            label={`${provider.name} API key`}
            autoComplete="new-password"
            spellCheck={false}
            autoFocus
            value={value}
            hint="Sent once, stored encrypted, never shown again."
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="settings-card__actions">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy !== null || !value.trim()}
            >
              {busy === "save" ? "Storing…" : "Store key"}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditing(false);
                setValue("");
                setError(null);
              }}
              disabled={busy !== null}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        (store || stored) && (
          <div className="settings-card__actions">
            {store && !fromEnv && (
              <Button size="sm" onClick={() => setEditing(true)}>
                {stored ? "Replace key" : "Store a key"}
              </Button>
            )}
            {stored &&
              removeButton(fromEnv ? "Remove stored key" : "Remove key")}
          </div>
        )
      )}
    </div>
  );
}
