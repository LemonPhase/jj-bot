import type { ModelsView, RuntimeProfile } from "@jj/contracts";
import { useId } from "react";
import {
  Input,
  SectionLabel,
  Select,
  StatusTag,
  Textarea,
} from "../../components/ui";
import { isolationLabel, profileAvailability } from "../settings/isolation";
import { SETTINGS_HREF } from "../shell/router";
import type { DraftErrors, DraftField, StudioDraft } from "./studioDraft";
import {
  effectiveProfile,
  modelChoices,
  profileChoices,
} from "./studioOptions";

export interface StudioDetailsProps {
  draft: StudioDraft;
  errors: DraftErrors;
  onField: (field: DraftField, value: string) => void;
  models: ModelsView | null;
  modelsError: string | null;
  profiles: readonly RuntimeProfile[];
  /** The stored values, kept selectable even if no longer listed. */
  current: { model: string | null; runtimeProfileId: string | null };
  /** Input ids, so the screen can focus the first invalid field. */
  ids: { name: string; role: string; instructions: string };
}

/**
 * Identity, model and runtime profile: Studio is the bot builder, so it edits
 * everything a bot has (brief, data gaps). Not in the design; it follows the
 * SPEC §14.5 proposal, styled like the rest of the kit.
 */
export function StudioDetails({
  draft,
  errors,
  onField,
  models,
  modelsError,
  profiles,
  current,
  ids,
}: StudioDetailsProps) {
  const headingId = useId();
  const profile = effectiveProfile(profiles, draft.runtimeProfileId);
  const availability = profile && profileAvailability(profile.status);
  return (
    <section className="studio-details" aria-labelledby={headingId}>
      <SectionLabel as="h2" tracking="part" id={headingId}>
        Details
      </SectionLabel>
      <div className="studio-details__grid">
        <Input
          id={ids.name}
          label="Name"
          value={draft.name}
          maxLength={60}
          autoComplete="off"
          placeholder="e.g. Nova"
          required
          error={errors.name}
          onChange={(event) => onField("name", event.target.value)}
        />
        <Input
          id={ids.role}
          label="Role"
          value={draft.role}
          maxLength={80}
          autoComplete="off"
          placeholder="e.g. Security review"
          error={errors.role}
          onChange={(event) => onField("role", event.target.value)}
        />
        <Textarea
          id={ids.instructions}
          className="studio-details__wide"
          label="Instructions"
          value={draft.instructions}
          rows={4}
          placeholder="How this bot should work, what it should check and how it reports back."
          error={errors.instructions}
          onChange={(event) => onField("instructions", event.target.value)}
        />
        <Select
          label="Model"
          value={draft.model}
          options={modelChoices(models, current.model)}
          onChange={(value) => onField("model", value)}
          hint={
            modelsError ? (
              `Models did not load: ${modelsError}`
            ) : (
              <>
                Keys are set on the server, never here.{" "}
                <a href={SETTINGS_HREF}>See models in Settings</a>.
              </>
            )
          }
        />
        <Select
          label="Runtime profile"
          value={draft.runtimeProfileId}
          options={profileChoices(profiles, current.runtimeProfileId)}
          onChange={(value) => onField("runtimeProfileId", value)}
          hint={
            profile && availability ? (
              <span className="studio-details__profile">
                <StatusTag tone={availability.tone} size="sm">
                  {availability.word}
                </StatusTag>
                <span>
                  {isolationLabel(profile.status.isolated)}
                  {profile.status.isolated
                    ? ": commands run in the driver's sandbox."
                    : ": commands run directly on the server."}
                </span>
              </span>
            ) : (
              <>
                No default profile. <a href={SETTINGS_HREF}>Add one</a>.
              </>
            )
          }
        />
      </div>
    </section>
  );
}
