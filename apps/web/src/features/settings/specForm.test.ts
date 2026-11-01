import { sandboxSpecSchema, z } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import {
  carryDraft,
  type DriverCapabilities,
  draftFromSpec,
  readSpecDraft,
  type SpecField,
  specFormFields,
} from "./specForm";

// The schema the server sends for the in-tree drivers.
const schema = z.toJSONSchema(sandboxSpecSchema, { io: "input" }) as Record<
  string,
  unknown
>;

const docker: DriverCapabilities = {
  networkModes: ["none", "allowlist", "open"],
  resourceLimits: true,
  filesystemIsolation: true,
  exposePort: false,
  snapshot: false,
  metrics: false,
};
const local: DriverCapabilities = {
  ...docker,
  networkModes: ["open"],
  resourceLimits: false,
  filesystemIsolation: false,
};

const keys = (fields: readonly SpecField[]): string[] =>
  fields.flatMap((field) =>
    field.kind === "group" ? [field.key, ...keys(field.fields)] : [field.key],
  );

const byKey = (fields: readonly SpecField[], key: string): SpecField => {
  for (const field of fields) {
    if (field.key === key) return field;
    if (field.kind === "group") {
      const inner = field.fields.find((child) => child.key === key);
      if (inner) return inner;
    }
  }
  throw new Error(`no field ${key}`);
};

describe("specFormFields (JSON Schema → form)", () => {
  const fields = specFormFields(schema, docker);

  it("maps every describable property in schema order, leaving out driver, driverConfig and diskMb", () => {
    expect(keys(fields)).toEqual([
      "image",
      "resources",
      "resources.cpus",
      "resources.memoryMb",
      "resources.processes",
      "network",
      "workspace",
      "limits",
      "limits.execTimeoutMs",
      "limits.maxOutputBytes",
      "env",
    ]);
  });

  it("derives kinds, bounds, units and defaults from the schema", () => {
    expect(byKey(fields, "image")).toMatchObject({
      kind: "text",
      minLength: 1,
      required: false,
    });
    expect(byKey(fields, "resources.cpus")).toMatchObject({
      kind: "number",
      integer: false,
      exclusiveMinimum: 0,
      maximum: 64,
      label: "CPUs",
    });
    expect(byKey(fields, "resources.memoryMb")).toMatchObject({
      kind: "number",
      integer: true,
      unit: "MB",
    });
    expect(byKey(fields, "limits.execTimeoutMs")).toMatchObject({
      kind: "number",
      defaultValue: 120_000,
      maximum: 86_400_000,
    });
    expect(byKey(fields, "env")).toMatchObject({
      kind: "map",
      keyMinLength: 1,
      defaultValue: {},
    });
  });

  it("never offers the bot workspace, but still accepts it", () => {
    const workspace = byKey(fields, "workspace");
    expect(workspace.kind).toBe("choice");
    if (workspace.kind !== "choice") return;
    expect(workspace.options.map((o) => o.value)).toEqual([
      "ephemeral",
      "task",
    ]);
    expect(workspace.values).toContain("bot");
  });

  it("offers only the network modes the driver can enforce", () => {
    const network = byKey(fields, "network");
    if (network.kind !== "variant") throw new Error("network is a variant");
    expect(network.discriminator).toBe("mode");
    expect(network.options.map((o) => o.value)).toEqual([
      "none",
      "allowlist",
      "open",
    ]);
    expect(network.variants.map((o) => o.value)).toEqual([
      "none",
      "allowlist",
      "open",
    ]);
    const allowlist = network.variants.find((v) => v.value === "allowlist");
    expect(allowlist?.fields).toMatchObject([
      {
        key: "network.hosts",
        kind: "list",
        label: "Allowed hosts",
        hint: expect.stringContaining("One host per line"),
        placeholder: "registry.npmjs.org",
        minItems: 1,
        maxItems: 256,
        itemMaxLength: 260,
        itemPattern: expect.any(RegExp),
      },
    ]);

    const narrowed = byKey(
      specFormFields(schema, { ...docker, networkModes: ["none", "open"] }),
      "network",
    );
    if (narrowed.kind !== "variant") throw new Error("variant");
    expect(narrowed.options.map((o) => o.value)).toEqual(["none", "open"]);
    const localNetwork = byKey(specFormFields(schema, local), "network");
    if (localNetwork.kind !== "variant") throw new Error("variant");
    expect(localNetwork.options.map((o) => o.value)).toEqual(["open"]);
  });

  it("checks every allowed host against the contract's pattern, line by line", () => {
    const draft = (hosts: string) => ({
      ...draftFromSpec(fields),
      network: "allowlist",
      "network.hosts": hosts,
    });
    const valid = readSpecDraft(
      fields,
      draft(
        "Registry.npmjs.org\n\n  *.pythonhosted.org \nfiles.example.com:8443",
      ),
    );
    expect(valid.errors).toEqual({});
    // Sent as typed; the server lowercases and deduplicates.
    expect(valid.value.network).toEqual({
      mode: "allowlist",
      hosts: [
        "Registry.npmjs.org",
        "*.pythonhosted.org",
        "files.example.com:8443",
      ],
    });
    for (const [hosts, line] of [
      ["registry.npmjs.org\nhttps://pypi.org", 2],
      ["registry.npmjs.org\n\nexample.com/path", 3],
      ["*", 1],
      ["two words.com", 1],
    ] as const)
      expect(readSpecDraft(fields, draft(hosts)).errors, hosts).toEqual({
        "network.hosts": `Line ${line}: write a host such as registry.npmjs.org or *.example.com, optionally with :port, without a scheme or path.`,
      });
    // The contract's own checks beyond the pattern stay the server's.
    expect(readSpecDraft(fields, draft("example.com:99999")).errors).toEqual(
      {},
    );
  });

  it("notes resource limits a driver cannot enforce", () => {
    expect(byKey(fields, "resources")).toMatchObject({ note: undefined });
    expect(byKey(specFormFields(schema, local), "resources")).toMatchObject({
      note: expect.stringContaining("cannot enforce resource limits"),
    });
  });

  it("maps a driver-specific schema it has no presentation for", () => {
    const custom = specFormFields(
      {
        type: "object",
        properties: {
          driver: { type: "string" },
          region: { type: "string", enum: ["eu", "us"], default: "eu" },
          maxIdleSeconds: { type: "integer", minimum: 10 },
          gpu: { type: "boolean" },
          driverConfig: { type: "object", additionalProperties: {} },
        },
        required: ["driver", "region"],
      },
      docker,
    );
    expect(custom).toMatchObject([
      {
        key: "region",
        kind: "choice",
        label: "Region",
        options: [
          { value: "eu", label: "eu" },
          { value: "us", label: "us" },
        ],
      },
      { key: "maxIdleSeconds", kind: "number", label: "Max idle seconds" },
    ]);
  });
});

describe("spec drafts", () => {
  const fields = specFormFields(schema, docker);

  it("starts a new spec from the schema defaults the driver can enforce", () => {
    expect(draftFromSpec(fields)).toMatchObject({
      image: "",
      "resources.cpus": "",
      network: "none",
      "network.hosts": "",
      workspace: "task",
      "limits.execTimeoutMs": "",
      env: "",
    });
    // Local cannot enforce the schema default "none": it starts on "open".
    expect(draftFromSpec(specFormFields(schema, local)).network).toBe("open");
  });

  it("round-trips a stored spec", () => {
    const stored = sandboxSpecSchema.parse({
      driver: "docker",
      image: "node:22-bookworm-slim",
      resources: { cpus: 1.5, memoryMb: 2048 },
      network: {
        mode: "allowlist",
        hosts: ["registry.npmjs.org", "github.com"],
      },
      workspace: "ephemeral",
      limits: { execTimeoutMs: 60_000 },
      env: { NODE_ENV: "test", EMPTY: "" },
    });
    const draft = draftFromSpec(fields, stored);
    expect(draft).toMatchObject({
      image: "node:22-bookworm-slim",
      "resources.cpus": "1.5",
      "resources.memoryMb": "2048",
      "resources.processes": "",
      network: "allowlist",
      "network.hosts": "registry.npmjs.org\ngithub.com",
      workspace: "ephemeral",
      "limits.execTimeoutMs": "60000",
      "limits.maxOutputBytes": "262144",
      env: "NODE_ENV=test\nEMPTY=",
    });
    const { value, errors } = readSpecDraft(fields, draft);
    expect(errors).toEqual({});
    // Everything but the driver (chosen separately) and the opaque driverConfig.
    const { driver: _driver, driverConfig: _config, ...rest } = stored;
    expect(value).toEqual(rest);
  });

  it("leaves empty inputs out so server defaults apply", () => {
    const { value, errors } = readSpecDraft(fields, draftFromSpec(fields));
    expect(errors).toEqual({});
    expect(value).toEqual({ network: { mode: "none" }, workspace: "task" });
  });

  it("reports invalid input per field", () => {
    const draft = {
      ...draftFromSpec(fields),
      "resources.cpus": "0",
      "resources.processes": "2.5",
      "resources.memoryMb": "lots",
      "limits.execTimeoutMs": "86400001",
      network: "allowlist",
      env: "GOOD=1\nnot a pair",
    };
    const { errors } = readSpecDraft(fields, draft);
    expect(errors).toEqual({
      "resources.cpus": "Must be more than 0 and at most 64.",
      "resources.processes": "Enter a whole number.",
      "resources.memoryMb": "Enter a number.",
      "limits.execTimeoutMs": "Must be more than 0 and at most 86,400,000.",
      "network.hosts": "Add at least one.",
      env: "Line 2: write KEY=value.",
    });
    expect(
      readSpecDraft(fields, { ...draftFromSpec(fields), env: "A=1\nA=2" })
        .errors.env,
    ).toBe("Line 2: A is set twice.");
  });

  it("keeps values across a driver switch but clears the image", () => {
    const draft = {
      ...draftFromSpec(fields),
      image: "node:22",
      "resources.cpus": "2",
      network: "none",
    };
    const carried = carryDraft(draft, specFormFields(schema, local));
    expect(carried).toMatchObject({
      image: "",
      "resources.cpus": "2",
      // Not enforceable by local: kept, so the server can refuse it.
      network: "none",
    });
    expect(readSpecDraft(specFormFields(schema, local), carried).value).toEqual(
      {
        resources: { cpus: 2 },
        network: { mode: "none" },
        workspace: "task",
      },
    );
  });
});
