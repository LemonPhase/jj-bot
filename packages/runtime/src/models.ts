import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AuthContext,
  createModels,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type {
  ModelInfo,
  ModelRef,
  ModelsView,
  ProviderInfo,
} from "@jj/contracts";
import { createScriptedProvider } from "./scripted";

/** Environment the registry reads provider keys from. The server passes `process.env`. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

interface ProviderEntry {
  provider: Provider;
  /** Variables that configure the provider; any one set makes it configured. Empty: keyless. */
  envVars: readonly string[];
  /** Cheap, capable defaults in order of preference. */
  preferredDefaults: readonly string[];
}

/**
 * Providers JJ Bot offers. Each authenticates with one API key variable, so
 * "configured" is exactly "its key is set" and the key can be handed to pi per
 * call. Providers that need ambient credentials (cloud IAM, ADC files, OAuth
 * subscriptions) are left out: the registry never reads host credential files.
 */
function builtinEntries(): ProviderEntry[] {
  return [
    {
      provider: openaiProvider(),
      envVars: ["OPENAI_API_KEY"],
      preferredDefaults: ["gpt-6-luna", "gpt-5.6-luna", "gpt-5-mini"],
    },
    {
      provider: anthropicProvider(),
      envVars: ["ANTHROPIC_API_KEY"],
      preferredDefaults: ["claude-haiku-5-5", "claude-haiku-4-5"],
    },
    {
      provider: googleProvider(),
      envVars: ["GEMINI_API_KEY"],
      preferredDefaults: [
        "gemini-3.1-flash-lite",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash",
      ],
    },
    {
      provider: mistralProvider(),
      envVars: ["MISTRAL_API_KEY"],
      preferredDefaults: [],
    },
    {
      provider: xaiProvider(),
      envVars: ["XAI_API_KEY"],
      preferredDefaults: [],
    },
    {
      provider: groqProvider(),
      envVars: ["GROQ_API_KEY"],
      preferredDefaults: [],
    },
    {
      provider: deepseekProvider(),
      envVars: ["DEEPSEEK_API_KEY"],
      preferredDefaults: [],
    },
    {
      provider: openrouterProvider(),
      envVars: ["OPENROUTER_API_KEY"],
      preferredDefaults: [],
    },
    {
      provider: cerebrasProvider(),
      envVars: ["CEREBRAS_API_KEY"],
      preferredDefaults: [],
    },
  ];
}

export interface ModelRegistryOptions {
  /** Where provider keys are read. Defaults to `process.env`; tests inject their own. */
  env?: ProviderEnv;
  /** Registers the keyless `scripted/team` test model (`JJ_ENABLE_SCRIPTED_MODEL=true`). */
  enableScripted?: boolean;
  /**
   * Extra keyless providers, such as pi's faux provider in tests. They are
   * listed after the built-in ones and count as configured.
   */
  extraProviders?: readonly Provider[];
}

/** A model ready for a call. The key is fetched per call and handed to pi, never stored. */
export interface ResolvedModel {
  ref: ModelRef;
  model: Model<Api>;
  /** The provider key from the registry's env, or undefined for keyless providers. */
  getApiKey(): string | undefined;
}

export class ModelResolutionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_ref"
      | "unknown_model"
      | "unconfigured"
      | "no_model",
  ) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

/** Splits `provider/model` at the first slash; model ids may contain slashes. */
export function parseModelRef(
  ref: string,
): { provider: string; id: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

const isSet = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * The server's view of pi-ai's model catalog. Keys come only from the env it
 * was built with: pi's own auth resolution is pointed at that env too, and
 * never at host credential files.
 */
export class ModelRegistry {
  /** The pi model collection every call goes through. */
  readonly models: MutableModels;
  /** Stream function for pi's agent loop. */
  readonly streamFn: StreamFn;
  private readonly env: ProviderEnv;
  private readonly entries: ProviderEntry[];

  constructor(options: ModelRegistryOptions = {}) {
    this.env = options.env ?? process.env;
    const env = this.env;
    const authContext: AuthContext = {
      env: async (name) => env[name],
      // No ambient credential files (~/.aws, gcloud ADC, token files).
      fileExists: async () => false,
    };
    this.models = createModels({ authContext });
    this.entries = builtinEntries();
    for (const provider of options.extraProviders ?? [])
      this.entries.push({ provider, envVars: [], preferredDefaults: [] });
    if (options.enableScripted)
      this.entries.push({
        provider: createScriptedProvider(),
        envVars: [],
        preferredDefaults: ["team"],
      });
    for (const entry of this.entries) this.models.setProvider(entry.provider);
    this.streamFn = this.models.streamSimple.bind(this.models);
  }

  private entry(providerId: string): ProviderEntry | undefined {
    return this.entries.find((entry) => entry.provider.id === providerId);
  }

  private configured(entry: ProviderEntry): boolean {
    return (
      entry.envVars.length === 0 ||
      entry.envVars.some((name) => isSet(this.env[name]))
    );
  }

  /** Every offered provider, its models and whether its key is set. */
  providers(): ProviderInfo[] {
    return this.entries.map((entry) => ({
      id: entry.provider.id,
      name: entry.provider.name,
      configured: this.configured(entry),
      envVars: [...entry.envVars],
      models: this.models.getModels(entry.provider.id).map(toModelInfo),
    }));
  }

  /** `GET /api/models`. */
  view(): ModelsView {
    return { defaultModel: this.defaultModel(), providers: this.providers() };
  }

  /**
   * `JJ_DEFAULT_MODEL` when it names a model of a configured provider, else a
   * cheap model of the first configured provider, else null.
   */
  defaultModel(): ModelRef | null {
    const requested = this.env.JJ_DEFAULT_MODEL?.trim();
    if (requested && this.isUsable(requested)) return requested;
    for (const entry of this.entries) {
      if (!this.configured(entry)) continue;
      const models = this.models.getModels(entry.provider.id);
      const choice =
        entry.preferredDefaults
          .map((id) => models.find((model) => model.id === id))
          .find((model) => model !== undefined) ?? cheapest(models);
      if (choice) return `${entry.provider.id}/${choice.id}`;
    }
    return null;
  }

  private isUsable(ref: string): boolean {
    const parsed = parseModelRef(ref);
    const entry = parsed && this.entry(parsed.provider);
    return Boolean(
      parsed &&
        entry &&
        this.configured(entry) &&
        this.models.getModel(parsed.provider, parsed.id),
    );
  }

  /** Resolves a bot's model, or the default for null. Never calls the provider. */
  resolve(ref: ModelRef | null): ResolvedModel {
    const target = ref ?? this.defaultModel();
    if (!target)
      throw new ModelResolutionError(
        `No model provider is configured. Set one of ${this.entries
          .flatMap((entry) => entry.envVars)
          .join(", ")}.`,
        "no_model",
      );
    const parsed = parseModelRef(target);
    if (!parsed)
      throw new ModelResolutionError(
        `"${target}" is not a provider/model reference.`,
        "invalid_ref",
      );
    const entry = this.entry(parsed.provider);
    const model = entry && this.models.getModel(parsed.provider, parsed.id);
    if (!entry || !model)
      throw new ModelResolutionError(
        `Unknown model "${target}".`,
        "unknown_model",
      );
    if (!this.configured(entry))
      throw new ModelResolutionError(
        `Provider ${entry.provider.name} is not configured: set ${entry.envVars.join(" or ")} on the server.`,
        "unconfigured",
      );
    const env = this.env;
    return {
      ref: `${parsed.provider}/${model.id}`,
      model,
      getApiKey: () => entry.envVars.map((name) => env[name]).find(isSet),
    };
  }
}

function cheapest(models: readonly Model<Api>[]): Model<Api> | undefined {
  const priced = models.filter((model) => model.cost.output > 0);
  const pool = priced.length > 0 ? priced : models;
  return [...pool].sort(
    (a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output),
  )[0];
}

function toModelInfo(model: Model<Api>): ModelInfo {
  return {
    ref: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.contextWindow > 0
      ? { contextWindow: Math.floor(model.contextWindow) }
      : {}),
    ...(model.maxTokens > 0
      ? { maxOutputTokens: Math.floor(model.maxTokens) }
      : {}),
    input: model.input.filter(
      (kind): kind is "text" | "image" => kind === "text" || kind === "image",
    ),
    cost: {
      inputPerMTok: Math.max(0, model.cost.input),
      outputPerMTok: Math.max(0, model.cost.output),
    },
  };
}
