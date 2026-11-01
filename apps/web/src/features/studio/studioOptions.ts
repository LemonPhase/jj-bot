import type { ModelsView, RuntimeProfile } from "@jj/contracts";
import type { SelectOption } from "../../components/ui";
import { isolationLabel } from "../settings/isolation";
import {
  enableHint,
  findModel,
  isScriptedProvider,
  modelLabel,
  sortProviders,
} from "../settings/models";

/** The select value standing for null: the server default model or the default profile. */
export const DEFAULT_VALUE = "";

/**
 * Model choices: "Server default" (null) first, then the models of configured
 * providers, then one disabled entry per unconfigured provider naming the env
 * var that enables it (keys are never entered in the UI). The bot's current
 * model stays selectable even when its provider is unconfigured or the server
 * no longer lists it, so saving other fields never drops it.
 */
export function modelChoices(
  view: ModelsView | null,
  current: string | null,
): SelectOption<string>[] {
  const fallback = findModel(view, view?.defaultModel ?? null);
  const options: SelectOption<string>[] = [
    {
      value: DEFAULT_VALUE,
      label: fallback
        ? `Server default · ${modelLabel(fallback)}`
        : view?.defaultModel
          ? `Server default · ${view.defaultModel}`
          : view
            ? "Server default · none configured"
            : "Server default",
    },
  ];
  for (const provider of sortProviders(view?.providers ?? [])) {
    if (provider.configured) {
      for (const model of provider.models)
        options.push({
          value: model.ref,
          label: modelLabel({ provider, model }),
        });
      continue;
    }
    const kept = provider.models.find((model) => model.ref === current);
    if (kept)
      options.push({
        value: kept.ref,
        label: `${kept.name} · ${provider.name} (not configured)`,
      });
    options.push({
      value: `provider:${provider.id}`,
      label: isScriptedProvider(provider)
        ? `${provider.name} · not a real model · not enabled`
        : `${provider.name} · ${enableHint(provider)}`,
      disabled: true,
    });
  }
  if (current && !options.some((option) => option.value === current))
    options.push({ value: current, label: `${current} (not listed)` });
  return options;
}

/** "Docker sandbox · docker · Isolated", flagging an unavailable driver. */
export function profileLabel(profile: RuntimeProfile): string {
  const parts = [
    profile.name,
    profile.sandbox.driver,
    isolationLabel(profile.status.isolated),
  ];
  if (!profile.status.driverAvailable) parts.push("driver unavailable");
  return parts.join(" · ");
}

/** Runtime profile choices: "Default profile" (null) first, then every profile. */
export function profileChoices(
  profiles: readonly RuntimeProfile[],
  current: string | null,
): SelectOption<string>[] {
  const fallback = profiles.find((profile) => profile.isDefault);
  const options: SelectOption<string>[] = [
    {
      value: DEFAULT_VALUE,
      label: fallback
        ? `Default profile · ${profileLabel(fallback)}`
        : "Default profile · none set",
    },
    ...profiles.map((profile) => ({
      value: profile.id,
      label: profileLabel(profile),
    })),
  ];
  if (current && !profiles.some((profile) => profile.id === current))
    options.push({ value: current, label: `${current} (not found)` });
  return options;
}

/** The profile a bot would run with: its own, else the default. */
export function effectiveProfile(
  profiles: readonly RuntimeProfile[],
  selected: string,
): RuntimeProfile | undefined {
  return selected === DEFAULT_VALUE
    ? profiles.find((profile) => profile.isDefault)
    : profiles.find((profile) => profile.id === selected);
}
