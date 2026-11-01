import {
  CODING_TOOLS,
  COLLABORATION_TOOLS,
  type RuntimeProfile,
  type SandboxDriverInfo,
  type ToolName,
} from "@jj/contracts";
import { type FormEvent, useId, useMemo, useRef, useState } from "react";
import { useApi } from "../../api/ApiContext";
import { isApiError } from "../../api/client";
import {
  Button,
  Chip,
  ErrorBanner,
  Input,
  Select,
  type SelectOption,
  StatusTag,
  Textarea,
} from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import {
  driverAvailability,
  ISOLATION_HELP,
  isolationLabel,
} from "./isolation";
import {
  BUDGETS,
  type BudgetKey,
  createProfileCommand,
  draftFromProfile,
  newProfileDraft,
  type ProfileDraft,
  type ProfileErrors,
  profilePatch,
  readProfileDraft,
} from "./profileDraft";
import { SpecFields } from "./SpecFields";
import { carryDraft, type SpecField, specFormFields } from "./specForm";

export interface ProfileEditorProps {
  /** The profile to edit; null creates one. */
  profile: RuntimeProfile | null;
  drivers: readonly SandboxDriverInfo[];
  onClose: () => void;
}

type SaveState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; code: string; message: string };

const fieldsFor = (driver: SandboxDriverInfo | undefined): SpecField[] =>
  driver ? specFormFields(driver.specJsonSchema, driver.capabilities) : [];

/** The first available driver that isolates, else the first available, else the first. */
const preferredDriver = (drivers: readonly SandboxDriverInfo[]) =>
  drivers.find((d) => d.available && d.capabilities.filesystemIsolation) ??
  drivers.find((d) => d.available) ??
  drivers[0];

/**
 * Create or edit a runtime profile. The sandbox fields are generated from the
 * chosen driver's `specJsonSchema`; an edit sends a PATCH with only what
 * changed (see profileDraft.ts). Server refusals such as PROFILE_UNSUPPORTED
 * are shown verbatim at the top of the form.
 */
export function ProfileEditor({
  profile,
  drivers,
  onClose,
}: ProfileEditorProps) {
  const api = useApi();
  const { refreshProfiles } = useWorkspace();
  const headingId = useId();
  const bannerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<ProfileDraft>(() => {
    if (profile)
      return draftFromProfile(
        profile,
        fieldsFor(drivers.find((d) => d.id === profile.sandbox.driver)),
      );
    const driver = preferredDriver(drivers);
    return newProfileDraft(driver?.id ?? "", fieldsFor(driver));
  });
  const [submitted, setSubmitted] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const driver = drivers.find((d) => d.id === draft.driver);
  const fields = useMemo(() => fieldsFor(driver), [driver]);
  const read = readProfileDraft(draft, fields);
  const diff =
    profile && read.value ? profilePatch(profile, read.value, fields) : null;
  const errors: ProfileErrors = submitted
    ? { ...read.errors, ...(diff?.errors ?? {}) }
    : {};
  const unchanged =
    profile !== null &&
    diff !== null &&
    diff.patch === null &&
    Object.keys(diff.errors).length === 0;
  const busy = save.kind === "busy";

  const set = (change: Partial<ProfileDraft>) =>
    setDraft((current) => ({ ...current, ...change }));

  const switchDriver = (id: string) => {
    const next = drivers.find((d) => d.id === id);
    setDraft((current) => ({
      ...current,
      driver: id,
      spec: carryDraft(current.spec, fieldsFor(next)),
    }));
  };

  const toggleTool = (tool: ToolName) =>
    set({
      tools: draft.tools.includes(tool)
        ? draft.tools.filter((item) => item !== tool)
        : [...draft.tools, tool],
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    if (!read.value || (diff && Object.keys(diff.errors).length > 0)) return;
    if (profile && !diff?.patch) return;
    setSave({ kind: "busy" });
    try {
      if (profile && diff?.patch)
        await api.updateProfile(profile.id, diff.patch);
      else await api.createProfile(createProfileCommand(read.value));
      await refreshProfiles().catch(() => {});
      onClose();
    } catch (reason) {
      setSave({
        kind: "error",
        code: isApiError(reason) ? reason.code : "Error",
        message:
          reason instanceof Error
            ? reason.message
            : "The profile was not saved.",
      });
      requestAnimationFrame(() =>
        bannerRef.current?.scrollIntoView({ block: "nearest" }),
      );
    }
  };

  const driverOptions: SelectOption<string>[] = drivers.map((d) => ({
    value: d.id,
    label: `${d.label} · ${isolationLabel(d.capabilities.filesystemIsolation)}${d.available ? "" : " · unavailable"}`,
  }));
  if (draft.driver && !driver)
    driverOptions.push({
      value: draft.driver,
      label: `${draft.driver} · not installed`,
    });

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="settings-section__head">
        <h2 className="settings-heading" id={headingId}>
          {profile ? `Edit ${profile.name}` : "New runtime profile"}
        </h2>
      </div>
      <form className="settings-form" onSubmit={submit} noValidate>
        <div ref={bannerRef}>
          {save.kind === "error" && (
            <ErrorBanner
              word={save.code}
              onDismiss={() => setSave({ kind: "idle" })}
            >
              {save.message}
            </ErrorBanner>
          )}
        </div>

        <fieldset className="settings-group">
          <legend className="ui-field__label">Profile</legend>
          <div className="settings-group__fields settings-group__fields--wide">
            <Input
              label="Name"
              value={draft.name}
              maxLength={60}
              autoComplete="off"
              required
              error={errors.name}
              onChange={(event) => set({ name: event.target.value })}
            />
            <Textarea
              label="Description"
              value={draft.description}
              rows={2}
              maxLength={500}
              placeholder="What this profile is for."
              error={errors.description}
              onChange={(event) => set({ description: event.target.value })}
            />
          </div>
        </fieldset>

        <fieldset className="settings-group">
          <legend className="ui-field__label">Sandbox</legend>
          <div className="settings-group__fields settings-group__fields--wide">
            <Select
              label="Driver"
              value={draft.driver}
              options={driverOptions}
              onChange={switchDriver}
              error={errors.driver}
              hint={ISOLATION_HELP}
            />
            {driver ? (
              <p className="settings-meta settings-driver-line">
                <StatusTag tone={driverAvailability(driver).tone} size="sm">
                  {driverAvailability(driver).word}
                </StatusTag>
                <span>
                  {isolationLabel(driver.capabilities.filesystemIsolation)} ·
                  network {driver.capabilities.networkModes.join(", ")} ·{" "}
                  {driver.capabilities.resourceLimits
                    ? "enforces resource limits"
                    : "no resource limits"}
                </span>
              </p>
            ) : (
              <p className="settings-warning">
                The {draft.driver || "chosen"} driver is not installed on this
                server, so its sandbox settings cannot be edited here.
              </p>
            )}
            <SpecFields
              fields={fields}
              draft={draft.spec}
              errors={errors}
              onChange={(key, value) =>
                set({ spec: { ...draft.spec, [key]: value } })
              }
            />
          </div>
        </fieldset>

        <fieldset className="settings-group">
          <legend className="ui-field__label">Tools</legend>
          <div
            className="settings-tools"
            role="group"
            aria-label="Coding tools"
          >
            {CODING_TOOLS.map((tool) => (
              <Chip
                key={tool}
                selected={draft.tools.includes(tool)}
                onClick={() => toggleTool(tool)}
              >
                {tool}
              </Chip>
            ))}
          </div>
          <p className="ui-field__hint">
            Coding tools run inside the task's sandbox.{" "}
            {COLLABORATION_TOOLS.join(", ")} are always available to task
            sessions.
          </p>
        </fieldset>

        <fieldset className="settings-group">
          <legend className="ui-field__label">Budgets</legend>
          <div className="settings-group__fields">
            {(Object.keys(BUDGETS) as BudgetKey[]).map((key) => (
              <Input
                key={key}
                type="number"
                inputMode="numeric"
                step={1}
                min={BUDGETS[key].min}
                max={BUDGETS[key].max}
                label={BUDGETS[key].label}
                hint={`${BUDGETS[key].min}–${BUDGETS[key].max}, default ${BUDGETS[key].default}`}
                error={errors[key]}
                value={draft[key]}
                onChange={(event) => set({ [key]: event.target.value })}
              />
            ))}
          </div>
        </fieldset>

        {profile?.isDefault ? (
          <p className="settings-hint">
            This is the default profile. Make another profile the default to
            change that.
          </p>
        ) : (
          <label className="settings-check">
            <input
              type="checkbox"
              checked={draft.isDefault}
              onChange={(event) => set({ isDefault: event.target.checked })}
            />
            Use as the default profile
          </label>
        )}

        <div className="settings-form__actions">
          {submitted && Object.keys(errors).length > 0 && (
            <span className="settings-form__status" role="status">
              Fix the highlighted fields.
            </span>
          )}
          {unchanged && (
            <span className="settings-form__status" role="status">
              No changes to save.
            </span>
          )}
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || unchanged}>
            {profile
              ? busy
                ? "Saving…"
                : "Save changes"
              : busy
                ? "Creating…"
                : "Create profile"}
          </Button>
        </div>
      </form>
    </section>
  );
}
