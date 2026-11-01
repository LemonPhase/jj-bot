import type { ModelsView, RuntimeProfile } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import {
  formatContextWindow,
  formatCost,
  sortProviders,
} from "../settings/models";
import {
  DEFAULT_VALUE,
  effectiveProfile,
  modelChoices,
  profileChoices,
} from "./studioOptions";

const model = (provider: string, id: string, name: string) => ({
  ref: `${provider}/${id}`,
  provider,
  id,
  name,
  reasoning: false,
  input: ["text" as const],
});

const view: ModelsView = {
  defaultModel: "openai/gpt-mini",
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      configured: false,
      envVars: ["ANTHROPIC_API_KEY"],
      models: [model("anthropic", "haiku", "Claude Haiku")],
    },
    {
      id: "openai",
      name: "OpenAI",
      configured: true,
      envVars: ["OPENAI_API_KEY"],
      models: [model("openai", "gpt-mini", "GPT Mini")],
    },
    {
      id: "scripted",
      name: "Scripted",
      configured: true,
      envVars: [],
      models: [model("scripted", "team", "Scripted test model")],
    },
  ],
};

describe("modelChoices", () => {
  it("lists the server default, configured providers first, and disabled unconfigured ones with their env var", () => {
    expect(modelChoices(view, null)).toEqual([
      { value: DEFAULT_VALUE, label: "Server default · GPT Mini · OpenAI" },
      { value: "openai/gpt-mini", label: "GPT Mini · OpenAI" },
      {
        value: "scripted/team",
        label: "Scripted test model · not a real model",
      },
      {
        value: "provider:anthropic",
        label: "Anthropic · Set ANTHROPIC_API_KEY on the server",
        disabled: true,
      },
    ]);
  });

  it("keeps the bot's current model selectable", () => {
    const options = modelChoices(view, "anthropic/haiku");
    expect(options).toContainEqual({
      value: "anthropic/haiku",
      label: "Claude Haiku · Anthropic (not configured)",
    });
    expect(modelChoices(view, "gone/model").at(-1)).toEqual({
      value: "gone/model",
      label: "gone/model (not listed)",
    });
    expect(modelChoices(null, null)).toEqual([
      { value: DEFAULT_VALUE, label: "Server default" },
    ]);
    expect(
      modelChoices({ defaultModel: null, providers: [] }, null)[0]?.label,
    ).toBe("Server default · none configured");
  });
});

describe("profileChoices", () => {
  const profile = (
    id: string,
    driver: string,
    isolated: boolean,
    extra: Partial<RuntimeProfile> = {},
  ) =>
    ({
      id,
      name: id,
      sandbox: { driver },
      isDefault: false,
      status: { driverAvailable: true, isolated },
      ...extra,
    }) as RuntimeProfile;
  const profiles = [
    profile("Docker", "docker", true, { isDefault: true }),
    profile("Local", "local", false, {
      status: { driverAvailable: false, isolated: false },
    }),
  ];

  it("labels isolation and availability, with the default first", () => {
    expect(profileChoices(profiles, null).map((o) => o.label)).toEqual([
      "Default profile · Docker · docker · Isolated",
      "Docker · docker · Isolated",
      "Local · local · Unisolated · driver unavailable",
    ]);
    expect(profileChoices(profiles, "missing").at(-1)?.label).toBe(
      "missing (not found)",
    );
    expect(effectiveProfile(profiles, DEFAULT_VALUE)?.id).toBe("Docker");
    expect(effectiveProfile(profiles, "Local")?.id).toBe("Local");
  });
});

describe("model formatting", () => {
  it("formats context windows and costs", () => {
    expect(formatContextWindow(200_000)).toBe("200k");
    expect(formatContextWindow(1_048_576)).toBe("1.05M");
    expect(formatContextWindow(undefined)).toBe("—");
    expect(formatCost({ inputPerMTok: 3, outputPerMTok: 15 })).toBe(
      "$3.00 in · $15.00 out",
    );
    expect(formatCost({ inputPerMTok: 0.075, outputPerMTok: 0.3 })).toBe(
      "$0.075 in · $0.30 out",
    );
    expect(formatCost(undefined)).toBe("—");
  });

  it("puts configured providers first", () => {
    expect(sortProviders(view.providers).map((p) => p.id)).toEqual([
      "openai",
      "scripted",
      "anthropic",
    ]);
  });
});
