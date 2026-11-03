import {
  CODING_TOOLS,
  COLLABORATION_TOOLS,
  describeApprovalRule,
  matchingApprovalRule,
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
  type ApprovalRuleDraft,
  approvalMatchKey,
  BUDGETS,
  type BudgetKey,
  createProfileCommand,
  draftFromProfile,
  newProfileDraft,
  type ProfileDraft,
  type ProfileErrors,
  profilePatch,
  readProfileDraft,
  SPEND_CAPS,
  type SpendCapKey,
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
            Coding tools run inside the task's sandbox. Collaboration tools (
            {COLLABORATION_TOOLS.join(", ")}) are not set here: each task
            session gets the ones its place in the task allows.
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
            {(Object.keys(SPEND_CAPS) as SpendCapKey[]).map((key) => (
              <Input
                key={key}
                type="number"
                inputMode="decimal"
                step="any"
                min={0}
                label={SPEND_CAPS[key].label}
                hint={SPEND_CAPS[key].hint}
                placeholder="No cap"
                error={errors[key]}
                value={draft[key]}
                onChange={(event) => set({ [key]: event.target.value })}
              />
            ))}
          </div>
          <p className="ui-field__hint">
            Spend caps count model calls with a listed price. Calls on a model
            with no listed price are counted apart, and no cap can bound them.
          </p>
        </fieldset>

        <ApprovalRules
          rules={draft.approvals}
          errors={errors}
          onChange={(approvals) => set({ approvals })}
        />

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

const TOOL_OPTIONS: SelectOption<ToolName>[] = CODING_TOOLS.map((tool) => ({
  value: tool,
  label: tool,
}));

/**
 * The profile's approval rules: calls of its bots that wait for the user's
 * approval before they run. None by default. A preview says whether a bash
 * command would ask, with the same matcher the server uses.
 */
function ApprovalRules({
  rules,
  errors,
  onChange,
}: {
  rules: readonly ApprovalRuleDraft[];
  errors: ProfileErrors;
  onChange: (rules: ApprovalRuleDraft[]) => void;
}) {
  const [sample, setSample] = useState("");
  const update = (index: number, change: Partial<ApprovalRuleDraft>) =>
    onChange(
      rules.map((rule, at) => (at === index ? { ...rule, ...change } : rule)),
    );
  const parsed = rules.map((rule) =>
    rule.match.trim()
      ? { tool: rule.tool, match: rule.match.trim() }
      : { tool: rule.tool },
  );
  const matched = sample.trim()
    ? matchingApprovalRule(parsed, "bash", { command: sample })
    : undefined;
  return (
    <fieldset className="settings-group">
      <legend className="ui-field__label">Approvals</legend>
      {rules.length === 0 ? (
        <p className="ui-field__hint">
          No rules: every call runs without asking.
        </p>
      ) : (
        <ul className="settings-approvals" aria-label="Approval rules">
          {rules.map((rule, index) => (
            <li key={index} className="settings-approvals__rule">
              <Select
                label={`Rule ${index + 1} tool`}
                value={rule.tool}
                options={TOOL_OPTIONS}
                onChange={(tool) => update(index, { tool })}
              />
              <Input
                label={`Rule ${index + 1} match`}
                placeholder="Every call"
                value={rule.match}
                error={errors[approvalMatchKey(index)]}
                onChange={(event) =>
                  update(index, { match: event.target.value })
                }
              />
              <Button
                onClick={() => onChange(rules.filter((_, at) => at !== index))}
                aria-label={`Remove rule ${index + 1}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {errors.approvals && (
        <p className="ui-field__error">{errors.approvals}</p>
      )}
      <div>
        <Button
          onClick={() => onChange([...rules, { tool: "bash", match: "" }])}
        >
          Add a rule
        </Button>
      </div>
      <p className="ui-field__hint">
        A call that matches a rule waits for your approval in the task before it
        runs. The match is case-sensitive text found anywhere in the call: the
        command for bash, the path for file tools; <code>*</code> stands for any
        text, and an empty match asks before every call of the tool. Rules guide
        a cooperative bot; they are not a security boundary, since a command can
        reach the same effect another way (a script it wrote). The sandbox and
        its network policy remain the boundary.
      </p>
      {rules.length > 0 && (
        <div className="settings-approvals__preview">
          <Input
            label="Check a bash command"
            placeholder="git push origin main"
            value={sample}
            onChange={(event) => setSample(event.target.value)}
          />
          {sample.trim() && (
            <p className="ui-field__hint" role="status">
              {matched
                ? `Asks for approval: ${describeApprovalRule(matched)}.`
                : "Runs without asking."}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}
