import { providerInfoSchema } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { ModelRegistry, ModelResolutionError, parseModelRef } from "./models";
import { SCRIPTED_MODEL_REF } from "./scripted";

describe("ModelRegistry", () => {
  it("marks a provider configured exactly when its key variable is set", () => {
    const registry = new ModelRegistry({
      env: { OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "  " },
    });
    const providers = registry.providers();
    for (const provider of providers) providerInfoSchema.parse(provider);
    const openai = providers.find((provider) => provider.id === "openai");
    const anthropic = providers.find((provider) => provider.id === "anthropic");
    expect(openai).toMatchObject({
      configured: true,
      envVars: ["OPENAI_API_KEY"],
    });
    expect(anthropic).toMatchObject({
      configured: false,
      envVars: ["ANTHROPIC_API_KEY"],
    });
    expect(
      openai?.models.some((model) => model.ref === "openai/gpt-6-luna"),
    ).toBe(true);
    expect(
      providers
        .filter((provider) => provider.configured)
        .map((provider) => provider.id),
    ).toEqual(["openai"]);
  });

  it("uses a stored key when the variable is unset, and the variable when both are set", () => {
    const stored = new Map([
      [
        "openai",
        {
          value: "sk-stored-0123456789",
          hint: "6789",
          updatedAt: "2026-11-03T00:00:00.000Z",
        },
      ],
      [
        "anthropic",
        {
          value: undefined,
          hint: "dead",
          updatedAt: "2026-11-03T00:00:00.000Z",
        },
      ],
      [
        "google",
        {
          value: "AIza-stored-0123456789",
          hint: "6789",
          updatedAt: "2026-11-03T00:00:00.000Z",
        },
      ],
    ]);
    const storedKeys = { providerKey: (id: string) => stored.get(id) };
    const registry = new ModelRegistry({
      env: { GEMINI_API_KEY: "AIza-env-0123456789" },
      storedKeys,
    });
    const providers = registry.providers();
    for (const provider of providers) providerInfoSchema.parse(provider);
    const byId = (id: string) =>
      providers.find((provider) => provider.id === id);
    expect(byId("openai")).toMatchObject({
      configured: true,
      keySource: "stored",
      storedKey: { hint: "6789", readable: true },
    });
    // A stored key the server cannot decrypt configures nothing.
    expect(byId("anthropic")).toMatchObject({
      configured: false,
      keySource: null,
      storedKey: { hint: "dead", readable: false },
    });
    // The variable wins; the stored key is still described.
    expect(byId("google")).toMatchObject({
      configured: true,
      keySource: "env",
      storedKey: { readable: true },
    });
    expect(byId("mistral")).toMatchObject({
      configured: false,
      keySource: null,
      storedKey: null,
    });
    const openai = registry.resolve("openai/gpt-6-luna");
    expect(openai.getApiKey()).toBe("sk-stored-0123456789");
    expect(registry.resolve("google/gemini-2.5-flash").getApiKey()).toBe(
      "AIza-env-0123456789",
    );
    expect(() => registry.resolve("anthropic/claude-haiku-4-5")).toThrow(
      /store its key in Settings → Models/,
    );
    // Read per call: a key replaced after resolution is the one used.
    stored.set("openai", {
      value: "sk-replaced-0123456789",
      hint: "6789",
      updatedAt: "2026-11-03T00:00:01.000Z",
    });
    expect(openai.getApiKey()).toBe("sk-replaced-0123456789");
    // Stored keys are not the registry's env secrets: the store redacts its own.
    expect(registry.secretValues()).toEqual([
      { name: "GEMINI_API_KEY", value: "AIza-env-0123456789" },
    ]);
  });

  it("reads keys only from the env it was given", async () => {
    process.env.OPENAI_API_KEY = "sk-from-process";
    try {
      const registry = new ModelRegistry({ env: {} });
      expect(
        registry.providers().find((provider) => provider.id === "openai")
          ?.configured,
      ).toBe(false);
      expect(() => registry.resolve("openai/gpt-6-luna")).toThrow(
        /OPENAI_API_KEY/,
      );
      // pi's own auth resolution sees the injected env, not process.env.
      expect(await registry.models.getAuth("openai")).toBeUndefined();
      const injected = new ModelRegistry({
        env: { OPENAI_API_KEY: "sk-injected" },
      });
      expect((await injected.models.getAuth("openai"))?.auth.apiKey).toBe(
        "sk-injected",
      );
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("resolves models of two providers with their own keys, without calling them", () => {
    const registry = new ModelRegistry({
      env: { OPENAI_API_KEY: "sk-openai", ANTHROPIC_API_KEY: "sk-anthropic" },
    });
    const openai = registry.resolve("openai/gpt-6-luna");
    expect(openai.ref).toBe("openai/gpt-6-luna");
    expect(openai.model).toMatchObject({
      provider: "openai",
      id: "gpt-6-luna",
      api: "openai-responses",
    });
    expect(openai.getApiKey()).toBe("sk-openai");
    const anthropic = registry.resolve("anthropic/claude-haiku-5-5");
    expect(anthropic.model).toMatchObject({
      provider: "anthropic",
      id: "claude-haiku-5-5",
      api: "anthropic-messages",
    });
    expect(anthropic.getApiKey()).toBe("sk-anthropic");
  });

  it("explains why a reference cannot be resolved", () => {
    const registry = new ModelRegistry({ env: { OPENAI_API_KEY: "sk" } });
    const code = (ref: string | null) => {
      try {
        registry.resolve(ref);
        return "resolved";
      } catch (error) {
        return error instanceof ModelResolutionError ? error.code : "other";
      }
    };
    expect(code("anthropic/claude-haiku-5-5")).toBe("unconfigured");
    expect(code("openai/not-a-model")).toBe("unknown_model");
    expect(code("nobody/model")).toBe("unknown_model");
    expect(code("no-slash")).toBe("invalid_ref");
    expect(code(null)).toBe("resolved");
    expect(new ModelRegistry({ env: {} }).defaultModel()).toBeNull();
    expect(() => new ModelRegistry({ env: {} }).resolve(null)).toThrow(
      /No model provider is configured/,
    );
  });

  it("picks the default model", () => {
    expect(
      new ModelRegistry({ env: { OPENAI_API_KEY: "sk" } }).defaultModel(),
    ).toBe("openai/gpt-6-luna");
    expect(
      new ModelRegistry({ env: { ANTHROPIC_API_KEY: "sk" } }).defaultModel(),
    ).toBe("anthropic/claude-haiku-5-5");
    expect(
      new ModelRegistry({
        env: { GEMINI_API_KEY: "sk", ANTHROPIC_API_KEY: "sk" },
      }).defaultModel(),
    ).toBe("anthropic/claude-haiku-5-5");
    expect(
      new ModelRegistry({
        env: {
          OPENAI_API_KEY: "sk",
          ANTHROPIC_API_KEY: "sk",
          JJ_DEFAULT_MODEL: "anthropic/claude-sonnet-5-5",
        },
      }).defaultModel(),
    ).toBe("anthropic/claude-sonnet-5-5");
    // A default whose provider has no key is ignored.
    expect(
      new ModelRegistry({
        env: {
          OPENAI_API_KEY: "sk",
          JJ_DEFAULT_MODEL: "anthropic/claude-sonnet-5-5",
        },
      }).defaultModel(),
    ).toBe("openai/gpt-6-luna");
    expect(new ModelRegistry({ env: {} }).view()).toEqual({
      defaultModel: null,
      providers: new ModelRegistry({ env: {} }).providers(),
    });
  });

  it("hides the scripted test model unless it is enabled", () => {
    const plain = new ModelRegistry({ env: {} });
    expect(
      plain.providers().some((provider) => provider.id === "scripted"),
    ).toBe(false);
    expect(() => plain.resolve(SCRIPTED_MODEL_REF)).toThrow(
      ModelResolutionError,
    );

    const enabled = new ModelRegistry({ env: {}, enableScripted: true });
    const scripted = enabled
      .providers()
      .find((provider) => provider.id === "scripted");
    expect(scripted).toMatchObject({
      name: "Scripted test model",
      configured: true,
      envVars: [],
    });
    expect(scripted?.models).toEqual([
      expect.objectContaining({
        ref: "scripted/team",
        name: "Scripted test model",
        cost: { inputPerMTok: 0, outputPerMTok: 0 },
      }),
      expect.objectContaining({
        ref: "scripted/team-priced",
        name: "Scripted test model (fictional price)",
        cost: { inputPerMTok: 1, outputPerMTok: 4 },
      }),
    ]);
    expect(enabled.defaultModel()).toBe(SCRIPTED_MODEL_REF);
    expect(enabled.resolve(SCRIPTED_MODEL_REF).getApiKey()).toBeUndefined();
    // A real key wins the default over the scripted model.
    expect(
      new ModelRegistry({
        env: { OPENAI_API_KEY: "sk" },
        enableScripted: true,
      }).defaultModel(),
    ).toBe("openai/gpt-6-luna");
  });

  it("splits references at the first slash", () => {
    expect(parseModelRef("openrouter/anthropic/claude")).toEqual({
      provider: "openrouter",
      id: "anthropic/claude",
    });
    expect(parseModelRef("/x")).toBeUndefined();
    expect(parseModelRef("x/")).toBeUndefined();
  });
});
