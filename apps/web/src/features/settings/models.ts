import type { ModelInfo, ModelsView, ProviderInfo } from "@jj/contracts";

/**
 * Presentation helpers for `ModelsView` (GET /api/models), shared by Settings
 * and the Studio model select. Keys are never entered in the UI: a provider is
 * configured when one of its `envVars` is set on the server.
 */

/**
 * The keyless, deterministic test provider the server can register for tests
 * and demos. It is labelled as such everywhere and never shown as a real model.
 */
export const SCRIPTED_PROVIDER_ID = "scripted";

export const isScriptedProvider = (provider: Pick<ProviderInfo, "id">) =>
  provider.id === SCRIPTED_PROVIDER_ID;

/** Configured providers first; the server's order is kept within each group. */
export function sortProviders(
  providers: readonly ProviderInfo[],
): ProviderInfo[] {
  return [
    ...providers.filter((provider) => provider.configured),
    ...providers.filter((provider) => !provider.configured),
  ];
}

/** How a provider is enabled, e.g. "Set ANTHROPIC_API_KEY on the server". */
export function enableHint(
  provider: Pick<ProviderInfo, "envVars" | "configured">,
): string {
  if (provider.envVars.length > 0)
    return `Set ${provider.envVars.join(" or ")} on the server`;
  return provider.configured ? "No key needed" : "Not available on this server";
}

export interface ModelMatch {
  provider: ProviderInfo;
  model: ModelInfo;
}

/** The listed model with this ref, if any. */
export function findModel(
  view: ModelsView | null,
  ref: string | null,
): ModelMatch | null {
  if (!view || !ref) return null;
  for (const provider of view.providers)
    for (const model of provider.models)
      if (model.ref === ref) return { provider, model };
  return null;
}

/** A model's name with its provider, flagging the scripted test model. */
export function modelLabel(match: ModelMatch): string {
  if (isScriptedProvider(match.provider))
    return `${match.model.name} · not a real model`;
  return `${match.model.name} · ${match.provider.name}`;
}

/** "200k", "1M", "1.05M"; "—" when unknown. */
export function formatContextWindow(tokens: number | undefined): string {
  if (tokens === undefined) return "—";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

const dollars = (value: number) =>
  `$${value > 0 && value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;

/** "$3.00 in · $15.00 out" (per million tokens); "—" when the cost is unknown. */
export function formatCost(cost: ModelInfo["cost"]): string {
  if (!cost) return "—";
  return `${dollars(cost.inputPerMTok)} in · ${dollars(cost.outputPerMTok)} out`;
}
