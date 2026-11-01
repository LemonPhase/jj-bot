import {
  type Bot,
  CODING_TOOLS,
  type RuntimeProfile,
  type SandboxDriverInfo,
} from "@jj/contracts";
import { useId, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { isApiError } from "../../api/client";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBanner,
  Spinner,
  StatusTag,
} from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import {
  ISOLATION_HELP,
  isolationLabel,
  profileAvailability,
} from "./isolation";
import { ProfileEditor } from "./ProfileEditor";
import type { DriversState } from "./useDrivers";

interface ServerError {
  code: string;
  message: string;
}

const toServerError = (reason: unknown, fallback: string): ServerError => ({
  code: isApiError(reason) ? reason.code : "Error",
  message: reason instanceof Error ? reason.message : fallback,
});

type Editing = { kind: "new" } | { kind: "edit"; profileId: string } | null;

/** Settings → Runtime profiles: the list, create/edit, set default, delete. */
export function ProfilesPanel({ drivers }: { drivers: DriversState }) {
  const api = useApi();
  const { profiles, bots, refreshProfiles } = useWorkspace();
  const headingId = useId();
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<ServerError | null>(null);
  const [deleting, setDeleting] = useState<RuntimeProfile | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (editing) {
    if (!drivers.drivers)
      return drivers.error ? (
        <ErrorBanner word="Error">
          Drivers did not load: {drivers.error}
        </ErrorBanner>
      ) : (
        <Spinner label="Loading drivers…" showLabel />
      );
    const profile =
      editing.kind === "edit"
        ? (profiles.find((item) => item.id === editing.profileId) ?? null)
        : null;
    return (
      <ProfileEditor
        key={editing.kind === "edit" ? editing.profileId : "new"}
        profile={profile}
        drivers={drivers.drivers}
        onClose={() => setEditing(null)}
      />
    );
  }

  const makeDefault = async (profile: RuntimeProfile) => {
    setBusyId(profile.id);
    setError(null);
    try {
      await api.updateProfile(profile.id, { isDefault: true });
      await refreshProfiles().catch(() => {});
    } catch (reason) {
      setError(toServerError(reason, "The default was not changed."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="settings-section__head">
        <h2 className="settings-heading" id={headingId}>
          Runtime profiles
        </h2>
        <Button variant="primary" onClick={() => setEditing({ kind: "new" })}>
          New profile
        </Button>
      </div>
      <p className="settings-callout">
        A profile is the sandbox, tools and budgets a bot's sessions run with.{" "}
        {ISOLATION_HELP}
      </p>
      {error && (
        <ErrorBanner word={error.code} onDismiss={() => setError(null)}>
          {error.message}
        </ErrorBanner>
      )}
      {profiles.length === 0 ? (
        <EmptyState
          message="No runtime profiles yet."
          action={
            <Button
              variant="primary"
              onClick={() => setEditing({ kind: "new" })}
            >
              New profile
            </Button>
          }
        />
      ) : (
        <ul className="settings-list">
          {profiles.map((profile) => (
            <li key={profile.id}>
              <ProfileCard
                profile={profile}
                driver={drivers.drivers?.find(
                  (d) => d.id === profile.sandbox.driver,
                )}
                users={usersOf(profile, bots)}
                busy={busyId === profile.id}
                onEdit={() =>
                  setEditing({ kind: "edit", profileId: profile.id })
                }
                onMakeDefault={() => void makeDefault(profile)}
                onDelete={() => setDeleting(profile)}
              />
            </li>
          ))}
        </ul>
      )}
      {deleting && (
        <DeleteDialog profile={deleting} onClose={() => setDeleting(null)} />
      )}
    </section>
  );
}

/** Bots that run with the profile: their own choice, or the default for bots with none. */
function usersOf(profile: RuntimeProfile, bots: readonly Bot[]): Bot[] {
  return bots.filter(
    (bot) =>
      bot.runtimeProfileId === profile.id ||
      (profile.isDefault && bot.runtimeProfileId === null),
  );
}

function ProfileCard({
  profile,
  driver,
  users,
  busy,
  onEdit,
  onMakeDefault,
  onDelete,
}: {
  profile: RuntimeProfile;
  driver: SandboxDriverInfo | undefined;
  users: readonly Bot[];
  busy: boolean;
  onEdit: () => void;
  onMakeDefault: () => void;
  onDelete: () => void;
}) {
  const availability = profileAvailability(profile.status);
  const { sandbox } = profile;
  const facts = [
    driver?.label ?? sandbox.driver,
    isolationLabel(profile.status.isolated),
    `network ${sandbox.network.mode}`,
    `${sandbox.workspace} workspace`,
    `${profile.tools.length} of ${CODING_TOOLS.length} tools`,
    `${profile.budgets.maxTurnsPerRun} turns · ${profile.budgets.maxRunMinutes} min`,
  ];
  return (
    <Card as="article" className="settings-card" aria-label={profile.name}>
      <div className="settings-card__head">
        <h3 className="settings-card__title">
          {profile.name}
          {profile.isDefault && <Badge>default</Badge>}
        </h3>
        <StatusTag tone={availability.tone} title={profile.status.detail}>
          {availability.word}
        </StatusTag>
      </div>
      {profile.description && (
        <p className="settings-card__description">{profile.description}</p>
      )}
      <p className="settings-facts">{facts.join(" · ")}</p>
      {profile.status.detail && (
        <p className="settings-meta">Driver: {profile.status.detail}</p>
      )}
      <p className="settings-meta">
        {users.length > 0
          ? `Used by ${users.map((bot) => bot.name).join(", ")}${
              profile.isDefault
                ? " (bots without a profile use the default)"
                : ""
            }.`
          : "No bot uses it."}
      </p>
      <div className="settings-card__actions">
        <Button size="sm" onClick={onEdit}>
          Edit
        </Button>
        {!profile.isDefault && (
          <Button size="sm" onClick={onMakeDefault} disabled={busy}>
            {busy ? "Setting…" : "Set as default"}
          </Button>
        )}
        <Button size="sm" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </Card>
  );
}

function DeleteDialog({
  profile,
  onClose,
}: {
  profile: RuntimeProfile;
  onClose: () => void;
}) {
  const api = useApi();
  const { refreshProfiles } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ServerError | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteProfile(profile.id);
      await refreshProfiles().catch(() => {});
      onClose();
    } catch (reason) {
      setError(toServerError(reason, "The profile was not deleted."));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={`Delete ${profile.name}?`}
      description="This cannot be undone. The server refuses while a bot uses it."
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
            {busy ? "Deleting…" : "Delete profile"}
          </Button>
        </>
      }
    >
      {error && <ErrorBanner word={error.code}>{error.message}</ErrorBanner>}
    </Dialog>
  );
}
