import type { ModelsView, RuntimeProfile } from "@jj/contracts";
import type { SelectOption } from "../../components/ui";

/** The select value standing for null: "use the server's default". */
export const DEFAULT_OPTION = "";

/**
 * Model choices for a bot: the server default first, then every listed model.
 * Models of unconfigured providers are listed but disabled (keys come from
 * server env vars), except the bot's current one. A current model the server
 * no longer lists stays selectable, so saving other fields never drops it.
 */
export function modelOptions(
  models: ModelsView | null,
  current: string | null,
): SelectOption<string>[] {
  const options: SelectOption<string>[] = [
    {
      value: DEFAULT_OPTION,
      label: models?.defaultModel
        ? `Server default · ${models.defaultModel}`
        : "Server default",
    },
  ];
  for (const provider of models?.providers ?? [])
    for (const model of provider.models)
      options.push({
        value: model.ref,
        label: `${model.name} · ${provider.name}${provider.configured ? "" : " (not configured)"}`,
        disabled: !provider.configured && model.ref !== current,
      });
  if (current && !options.some((option) => option.value === current))
    options.push({ value: current, label: `${current} (not listed)` });
  return options;
}

/** Runtime profile choices: the default profile first, then every profile. */
export function profileOptions(
  profiles: readonly RuntimeProfile[],
  current: string | null,
): SelectOption<string>[] {
  const fallback = profiles.find((profile) => profile.isDefault);
  const options: SelectOption<string>[] = [
    {
      value: DEFAULT_OPTION,
      label: fallback
        ? `Default profile · ${fallback.name}`
        : "Default profile",
    },
    ...profiles.map((profile) => ({
      value: profile.id,
      label: profile.status.driverAvailable
        ? profile.name
        : `${profile.name} (driver unavailable)`,
    })),
  ];
  if (current && !profiles.some((profile) => profile.id === current))
    options.push({ value: current, label: `${current} (not found)` });
  return options;
}
