import { type SandboxDriverInfo, sandboxSpecSchema, z } from "@jj/contracts";
import type { DriverRegistry, EngineDriver } from "./ports";

export interface DriverEntry {
  driver: EngineDriver;
  /** Shown in settings, e.g. "Docker" or "Local (unisolated)". */
  label: string;
  /** JSON Schema of the driver's spec. Default: the generic sandbox spec. */
  specJsonSchema?: Record<string, unknown>;
}

const genericSpecSchema = () =>
  z.toJSONSchema(sandboxSpecSchema, { io: "input" }) as Record<string, unknown>;

/**
 * A registry over a fixed driver list. Probe results are reused for `ttlMs`,
 * so settings and bootstrap do not probe Docker on every request.
 */
export function createDriverRegistry(
  entries: readonly DriverEntry[],
  options: { ttlMs?: number; now?: () => number } = {},
): DriverRegistry {
  const ttlMs = options.ttlMs ?? 10_000;
  const now = options.now ?? Date.now;
  const byId = new Map(entries.map((entry) => [entry.driver.id, entry]));
  if (byId.size !== entries.length)
    throw new Error("Sandbox driver ids must be unique.");
  let cache: { at: number; value: Promise<SandboxDriverInfo[]> } | undefined;
  const probeAll = async (): Promise<SandboxDriverInfo[]> =>
    Promise.all(
      entries.map(async (entry) => {
        const health = await entry.driver.probe().catch((error: unknown) => ({
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        }));
        return {
          id: entry.driver.id,
          label: entry.label,
          available: health.ok,
          ...(health.detail ? { detail: health.detail } : {}),
          capabilities: {
            ...entry.driver.capabilities,
            networkModes: [...entry.driver.capabilities.networkModes],
          },
          specJsonSchema: entry.specJsonSchema ?? genericSpecSchema(),
        };
      }),
    );
  return {
    get: (id) => byId.get(id)?.driver,
    all: () => entries.map((entry) => entry.driver),
    list() {
      if (!cache || now() - cache.at > ttlMs)
        cache = { at: now(), value: probeAll() };
      return cache.value;
    },
  };
}
