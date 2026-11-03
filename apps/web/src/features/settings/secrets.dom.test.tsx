// @vitest-environment jsdom
import "../../test/dom";
import type {
  ModelsView,
  ProviderInfo,
  RuntimeProfile,
  SecretInfo,
} from "@jj/contracts";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/ApiContext";
import type { JJApi } from "../../api/client";
import { createDemoApi } from "../../api/demoApi";
import { WorkspaceProvider } from "../../state/WorkspaceContext";
import { ModelsPanel } from "./ModelsPanel";
import { SecretsPanel } from "./SecretsPanel";
import { ENABLE_STORE_COMMAND } from "./secrets";

const TOKEN = "ghp_domTestToken0123456789abcdef";
const KEY = "sk-ant-domTest0123456789abcdefgh";
const AT = "2026-11-01T10:00:00.000Z";

const provider = (
  id: string,
  name: string,
  envVar: string,
  overrides: Partial<ProviderInfo> = {},
): ProviderInfo => ({
  id,
  name,
  configured: false,
  envVars: [envVar],
  keySource: null,
  storedKey: null,
  models: [],
  ...overrides,
});

/**
 * The demo API with a write-only store behind the secrets and key calls, as
 * the server keeps one: it answers hints and dates, never values.
 */
function storeApi(options: { store: boolean }) {
  const base = createDemoApi({ autoplay: false });
  const secrets = new Map<string, SecretInfo>();
  let models: ModelsView = {
    defaultModel: "openai/gpt",
    providers: [
      provider("openai", "OpenAI", "OPENAI_API_KEY", {
        configured: true,
        keySource: "env",
      }),
      provider("anthropic", "Anthropic", "ANTHROPIC_API_KEY"),
    ],
  };
  const putSecret = vi.fn(
    async (name: string, { value }: { value: string }) => {
      const secret = {
        name,
        hint: value.slice(-4),
        readable: true,
        createdAt: AT,
        updatedAt: AT,
      };
      secrets.set(name, secret);
      return secret;
    },
  );
  const putProviderKey = vi.fn(
    async (providerId: string, { value }: { value: string }) => {
      models = {
        ...models,
        providers: models.providers.map((entry) =>
          entry.id === providerId
            ? {
                ...entry,
                configured: true,
                keySource: "stored" as const,
                storedKey: {
                  hint: value.slice(-4),
                  readable: true,
                  updatedAt: AT,
                },
              }
            : entry,
        ),
      };
      return models;
    },
  );
  const api: JJApi = {
    ...base,
    mode: "live",
    capabilities: { ...base.capabilities, secretStore: options.store },
    getModels: async () => models,
    putProviderKey,
    listSecrets: async () => ({
      available: options.store,
      secrets: [...secrets.values()],
    }),
    putSecret,
    deleteSecret: vi.fn(async (name: string) => {
      secrets.delete(name);
    }),
    listProfiles: async () => {
      const profiles = await base.listProfiles();
      return profiles.map(
        (profile): RuntimeProfile =>
          profile.isDefault
            ? { ...profile, secrets: ["GITHUB_TOKEN"] }
            : profile,
      );
    },
  };
  return { api, putSecret, putProviderKey };
}

const drivers = {
  drivers: null,
  error: null,
  loading: false,
  reload: () => {},
};

function renderWith(api: JJApi, panel: "models" | "secrets") {
  render(
    <ApiProvider api={api}>
      <WorkspaceProvider>
        {panel === "models" ? (
          <ModelsPanel />
        ) : (
          <SecretsPanel drivers={drivers} />
        )}
      </WorkspaceProvider>
    </ApiProvider>,
  );
}

describe("Settings → Secrets", () => {
  it("stores a secret write-only: the value is sent once, cleared, and never shown", async () => {
    const { api, putSecret } = storeApi({ store: true });
    renderWith(api, "secrets");
    fireEvent.click(await screen.findByRole("button", { name: "New secret" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "github_token" },
    });
    const value = screen.getByLabelText("Value") as HTMLInputElement;
    expect(value.type).toBe("password");
    expect(value.getAttribute("autocomplete")).toBe("new-password");
    fireEvent.change(value, { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Store secret" }));
    await waitFor(() =>
      expect(putSecret).toHaveBeenCalledWith("GITHUB_TOKEN", { value: TOKEN }),
    );
    const card = await screen.findByRole("article", { name: "GITHUB_TOKEN" });
    expect(within(card).getByText(/^ends in cdef/)).toBeDefined();
    await waitFor(() =>
      expect(within(card).getByText(/^Granted by /).textContent).toContain(
        "Docker sandbox",
      ),
    );
    expect(screen.queryByLabelText("Value")).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
    expect((await screen.findByRole("dialog")).textContent ?? "").toContain(
      "This also removes it from Docker sandbox.",
    );
  });

  it("says how to turn the store on when the server has no JJ_SECRET_KEY", async () => {
    const { api } = storeApi({ store: false });
    renderWith(api, "secrets");
    expect(await screen.findByText(ENABLE_STORE_COMMAND)).toBeDefined();
    expect(screen.queryByRole("button", { name: "New secret" })).toBeNull();
  });
});

describe("Settings → Models", () => {
  it("stores a provider key for a provider no variable configures, and offers none where one does", async () => {
    const { api, putProviderKey } = storeApi({ store: true });
    renderWith(api, "models");
    const openai = await screen.findByRole("article", { name: "OpenAI" });
    expect(
      within(openai).getByText(/takes precedence over a key stored here/),
    ).toBeDefined();
    expect(within(openai).queryByRole("button", { name: /key/i })).toBeNull();
    const anthropic = screen.getByRole("article", { name: "Anthropic" });
    fireEvent.click(
      within(anthropic).getByRole("button", { name: "Store a key" }),
    );
    const input = within(anthropic).getByLabelText(
      "Anthropic API key",
    ) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: KEY } });
    fireEvent.click(
      within(anthropic).getByRole("button", { name: "Store key" }),
    );
    await waitFor(() =>
      expect(putProviderKey).toHaveBeenCalledWith("anthropic", { value: KEY }),
    );
    expect(
      await within(anthropic).findByText(/^Key stored here, ends in efgh/),
    ).toBeDefined();
    expect(
      within(anthropic).getByRole("button", { name: "Replace key" }),
    ).toBeDefined();
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("shows the one line that enables the store when it is off", async () => {
    const { api } = storeApi({ store: false });
    renderWith(api, "models");
    expect(await screen.findByText(ENABLE_STORE_COMMAND)).toBeDefined();
    const anthropic = await screen.findByRole("article", { name: "Anthropic" });
    expect(
      within(anthropic).queryByRole("button", { name: "Store a key" }),
    ).toBeNull();
  });
});
