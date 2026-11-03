import {
  CODING_TOOLS,
  createRuntimeProfileCommandSchema,
  type RuntimeProfile,
  sandboxSpecSchema,
  updateRuntimeProfileCommandSchema,
  z,
} from "@jj/contracts";
import { describe, expect, it } from "vitest";
import {
  createProfileCommand,
  type DesiredProfile,
  draftFromProfile,
  newProfileDraft,
  type ProfileDraft,
  profilePatch,
  readProfileDraft,
} from "./profileDraft";
import {
  carryDraft,
  type DriverCapabilities,
  specFormFields,
} from "./specForm";

const schema = z.toJSONSchema(sandboxSpecSchema, { io: "input" }) as Record<
  string,
  unknown
>;
const dockerCaps: DriverCapabilities = {
  networkModes: ["none", "allowlist", "open"],
  resourceLimits: true,
  filesystemIsolation: true,
  exposePort: false,
  snapshot: false,
  metrics: false,
  spawn: false,
};
const localCaps: DriverCapabilities = {
  ...dockerCaps,
  networkModes: ["open"],
  resourceLimits: false,
  filesystemIsolation: false,
};
const dockerFields = specFormFields(schema, dockerCaps);
const localFields = specFormFields(schema, localCaps);

const stored: RuntimeProfile = {
  id: "profile-docker",
  name: "Docker sandbox",
  description: "Isolated.",
  sandbox: sandboxSpecSchema.parse({
    driver: "docker",
    image: "node:22-bookworm-slim",
    resources: { cpus: 2, memoryMb: 2048 },
    network: { mode: "none" },
    workspace: "task",
    env: { NODE_ENV: "test" },
  }),
  tools: [...CODING_TOOLS],
  budgets: {
    maxTurnsPerRun: 60,
    maxRunMinutes: 30,
    maxUsdPerTask: 5,
    maxUsdPerBotPerDay: null,
  },
  approvals: [],
  secrets: [],
  mcpServers: [],
  skills: [],
  isDefault: false,
  status: { driverAvailable: true, isolated: true },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

/** Edits a draft of `stored`, validates it and diffs it. */
function patchFor(
  edit: (draft: ProfileDraft) => ProfileDraft,
  fields = dockerFields,
) {
  const draft = edit(draftFromProfile(stored, dockerFields));
  const read = readProfileDraft(draft, fields);
  expect(read.errors).toEqual({});
  return profilePatch(stored, read.value as DesiredProfile, fields);
}

const withSpec = (draft: ProfileDraft, spec: Record<string, string>) => ({
  ...draft,
  spec: { ...draft.spec, ...spec },
});

describe("profile drafts", () => {
  it("validates name, budgets and the generated fields together", () => {
    const draft = {
      ...newProfileDraft("docker", dockerFields),
      maxTurnsPerRun: "0",
      maxUsdPerTask: "-2",
      spec: { ...newProfileDraft("docker", dockerFields).spec, image: " " },
    };
    expect(readProfileDraft(draft, dockerFields).errors).toEqual({
      name: "Give the profile a name.",
      maxTurnsPerRun: "Enter a whole number from 1 to 500.",
      maxUsdPerTask:
        "Enter an amount above 0 and at most 10000, or leave it empty for no cap.",
    });
  });

  it("builds a create command the contract accepts, leaving defaults to the server", () => {
    const draft = {
      ...newProfileDraft("local", localFields),
      name: " Trusted local ",
      tools: ["ls", "read"] as const,
      isDefault: true,
    };
    const { value } = readProfileDraft(draft, localFields);
    const command = createProfileCommand(value as DesiredProfile);
    expect(command).toEqual({
      name: "Trusted local",
      sandbox: {
        driver: "local",
        network: { mode: "open" },
        workspace: "task",
      },
      tools: ["read", "ls"],
      budgets: {
        maxTurnsPerRun: 60,
        maxRunMinutes: 30,
        maxUsdPerTask: 5,
        maxUsdPerBotPerDay: 20,
      },
      isDefault: true,
    });
    expect(createRuntimeProfileCommandSchema.safeParse(command).success).toBe(
      true,
    );
  });
});

describe("approval rules in a profile draft", () => {
  it("has none by default and creates none", () => {
    const draft = { ...newProfileDraft("local", localFields), name: "Local" };
    const read = readProfileDraft(draft, localFields);
    expect(read.value?.approvals).toEqual([]);
    expect(
      "approvals" in createProfileCommand(read.value as DesiredProfile),
    ).toBe(false);
  });

  it("reads an empty match as every call, and refuses an overlong one", () => {
    const draft = {
      ...newProfileDraft("local", localFields),
      name: "Local",
      approvals: [
        { tool: "bash" as const, match: " git push " },
        { tool: "write" as const, match: "  " },
      ],
    };
    const read = readProfileDraft(draft, localFields);
    expect(read.value?.approvals).toEqual([
      { tool: "bash", match: "git push" },
      { tool: "write" },
    ]);
    const command = createProfileCommand(read.value as DesiredProfile);
    expect(createRuntimeProfileCommandSchema.parse(command).approvals).toEqual(
      read.value?.approvals,
    );
    expect(
      readProfileDraft(
        { ...draft, approvals: [{ tool: "bash", match: "x".repeat(201) }] },
        localFields,
      ).errors,
    ).toEqual({ "approvals.0.match": "At most 200 characters." });
  });

  it("sends the rules whole, and only when they changed", () => {
    const guarded = {
      ...stored,
      approvals: [{ tool: "bash" as const, match: "git push" }],
    };
    const draft = draftFromProfile(guarded, dockerFields);
    expect(draft.approvals).toEqual([{ tool: "bash", match: "git push" }]);
    const same = readProfileDraft(draft, dockerFields);
    expect(
      profilePatch(guarded, same.value as DesiredProfile, dockerFields).patch,
    ).toBeNull();
    const added = readProfileDraft(
      {
        ...draft,
        approvals: [...draft.approvals, { tool: "edit", match: "" }],
      },
      dockerFields,
    );
    const { patch } = profilePatch(
      guarded,
      added.value as DesiredProfile,
      dockerFields,
    );
    expect(patch).toEqual({
      approvals: [{ tool: "bash", match: "git push" }, { tool: "edit" }],
    });
    expect(updateRuntimeProfileCommandSchema.safeParse(patch).success).toBe(
      true,
    );
  });
});

describe("MCP servers and skills in a profile draft", () => {
  it("carries them as stored, and sends them only when present or changed", () => {
    const draft = draftFromProfile(stored, dockerFields);
    expect(draft).toMatchObject({ mcpServers: [], skills: [] });
    const read = readProfileDraft(draft, dockerFields);
    expect(read.value).toMatchObject({ mcpServers: [], skills: [] });
    expect(
      profilePatch(stored, read.value as DesiredProfile, dockerFields).patch,
    ).toBeNull();
    const command = createProfileCommand(read.value as DesiredProfile);
    expect("mcpServers" in command || "skills" in command).toBe(false);
  });

  it("keeps a stored rule on an MCP tool through an edit", () => {
    const guarded = {
      ...stored,
      approvals: [{ tool: "mcp__docs__*" as const }],
    };
    const draft = draftFromProfile(guarded, dockerFields);
    expect(draft.approvals).toEqual([{ tool: "mcp__docs__*", match: "" }]);
    const renamed = readProfileDraft(
      { ...draft, name: "Renamed" },
      dockerFields,
    );
    expect(
      profilePatch(guarded, renamed.value as DesiredProfile, dockerFields)
        .patch,
    ).toEqual({ name: "Renamed" });
    expect(renamed.value?.approvals).toEqual([{ tool: "mcp__docs__*" }]);
  });
});

describe("profilePatch (PATCH sends only changed fields)", () => {
  it("is null when nothing changed", () => {
    expect(patchFor((draft) => draft)).toEqual({ patch: null, errors: {} });
  });

  it("shows no cap as an empty input, and sends a changed or cleared cap", () => {
    const draft = draftFromProfile(stored, dockerFields);
    expect(draft.maxUsdPerTask).toBe("5");
    expect(draft.maxUsdPerBotPerDay).toBe("");
    const { patch } = patchFor((current) => ({
      ...current,
      maxUsdPerTask: "",
      maxUsdPerBotPerDay: "12.5",
    }));
    expect(patch).toEqual({
      budgets: { maxUsdPerTask: null, maxUsdPerBotPerDay: 12.5 },
    });
    expect(updateRuntimeProfileCommandSchema.safeParse(patch).success).toBe(
      true,
    );
  });

  it("sends changed scalars and merged objects key by key", () => {
    const { patch } = patchFor((draft) => ({
      ...withSpec(draft, {
        "resources.cpus": "4",
        "limits.execTimeoutMs": "60000",
      }),
      name: "Docker, roomy",
      maxRunMinutes: "45",
    }));
    expect(patch).toEqual({
      name: "Docker, roomy",
      sandbox: { resources: { cpus: 4 }, limits: { execTimeoutMs: 60_000 } },
      budgets: { maxRunMinutes: 45 },
    });
    expect(updateRuntimeProfileCommandSchema.safeParse(patch).success).toBe(
      true,
    );
  });

  it("sends network, env and tools whole, because the server replaces them", () => {
    const { patch } = patchFor((draft) => ({
      ...withSpec(draft, {
        network: "open",
        env: "NODE_ENV=test\nCI=1",
      }),
      tools: draft.tools.filter((tool) => tool !== "bash"),
    }));
    expect(patch).toEqual({
      sandbox: {
        network: { mode: "open" },
        env: { NODE_ENV: "test", CI: "1" },
      },
      tools: ["read", "edit", "write", "grep", "find", "ls"],
    });
    // Emptying the env replaces it with {}.
    expect(patchFor((draft) => withSpec(draft, { env: "" })).patch).toEqual({
      sandbox: { env: {} },
    });
  });

  it("treats tool order as no change and a reordered list as the same set", () => {
    expect(
      patchFor((draft) => ({ ...draft, tools: [...draft.tools].reverse() }))
        .patch,
    ).toBeNull();
  });

  it("sends an emptied input that has a default as that default", () => {
    const changed = { ...stored, sandbox: { ...stored.sandbox } };
    changed.sandbox.limits = { execTimeoutMs: 60_000, maxOutputBytes: 262_144 };
    const draft = withSpec(draftFromProfile(changed, dockerFields), {
      "limits.execTimeoutMs": "",
    });
    const { value } = readProfileDraft(draft, dockerFields);
    expect(
      profilePatch(changed, value as DesiredProfile, dockerFields).patch,
    ).toEqual({ sandbox: { limits: { execTimeoutMs: 120_000 } } });
  });

  it("refuses to drop a saved value the contract cannot unset", () => {
    const draft = withSpec(draftFromProfile(stored, dockerFields), {
      "resources.cpus": "",
      image: "",
    });
    const { value } = readProfileDraft(draft, dockerFields);
    const result = profilePatch(stored, value as DesiredProfile, dockerFields);
    expect(result.patch).toBeNull();
    expect(Object.keys(result.errors)).toEqual(["image", "resources.cpus"]);
  });

  it("moves the default only by setting it", () => {
    expect(patchFor((draft) => ({ ...draft, isDefault: true })).patch).toEqual({
      isDefault: true,
    });
    const isDefault = { ...stored, isDefault: true };
    const { value } = readProfileDraft(
      { ...draftFromProfile(isDefault, dockerFields), isDefault: false },
      dockerFields,
    );
    expect(
      profilePatch(isDefault, value as DesiredProfile, dockerFields).patch,
    ).toBeNull();
  });

  it("switches driver: sends the driver, lets the server drop the image, keeps the rest", () => {
    const draft = draftFromProfile(stored, dockerFields);
    const switched = {
      ...draft,
      driver: "local",
      spec: carryDraft(draft.spec, localFields),
    };
    const { value } = readProfileDraft(switched, localFields);
    // network none and the resources stay on the merged spec, so the server
    // (and the demo) refuses it with PROFILE_UNSUPPORTED.
    expect(profilePatch(stored, value as DesiredProfile, localFields)).toEqual({
      patch: { sandbox: { driver: "local" } },
      errors: {},
    });
    const opened = {
      ...switched,
      spec: { ...switched.spec, network: "open" },
    };
    expect(
      profilePatch(
        stored,
        readProfileDraft(opened, localFields).value as DesiredProfile,
        localFields,
      ).patch,
    ).toEqual({ sandbox: { driver: "local", network: { mode: "open" } } });
  });
});
