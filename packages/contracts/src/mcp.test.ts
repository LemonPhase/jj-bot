import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  approvalRuleMatches,
  approvalRuleSchema,
  approvalSubject,
  approvalSubjectProblem,
  CODING_TOOLS,
  COLLABORATION_TOOLS,
  CONTRACT_VERSION,
  canonicalForm,
  canonicalJson,
  createRuntimeProfileCommandSchema,
  declaredMcpTools,
  describeApprovalRule,
  MAX_MCP_SERVERS,
  MCP_TOOL_PREFIX,
  MCP_TOOL_SELECTOR_PATTERN,
  type McpServer,
  type McpServerInput,
  type McpTool,
  type McpToolSnapshot,
  matchingApprovalRule,
  mcpDiscoveryResultSchema,
  mcpDiscoverySchema,
  mcpHttpServerSchema,
  mcpRulesWithoutTool,
  mcpServerNameSchema,
  mcpServerSchema,
  mcpServersSchema,
  mcpSnapshotResultSchema,
  mcpToolName,
  mcpToolNames,
  mcpToolSchema,
  mcpToolSelectorSchema,
  mcpToolSnapshotSchema,
  runtimeProfileSchema,
  sha256Hex,
  startMcpDiscoveryCommandSchema,
  toolSelectorMatches,
  ungrantedMcpSecrets,
  updateRuntimeProfileCommandSchema,
} from "./index";

const at = "2026-11-03T12:00:00.000Z";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

const stdio = {
  name: "docs",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@example/docs-mcp"],
  env: { LOG_LEVEL: "warn" },
  secretEnv: { DOCS_TOKEN: "DOCS_TOKEN" },
} satisfies McpServerInput;

const http = {
  name: "tracker",
  transport: "http",
  url: "https://mcp.example.com/v1/mcp?team=core",
  headers: { "X-Team": "core" },
  secretHeaders: {
    Authorization: { secret: "TRACKER_TOKEN", prefix: "Bearer " },
  },
} satisfies McpServerInput;

const server = (change: Record<string, unknown>, base: object = stdio) =>
  mcpServerSchema.safeParse({ ...base, ...change });
const issuePath = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues[0]?.path;

describe("MCP server configuration", () => {
  it("accepts a stdio and an http server, filling defaults", () => {
    expect(mcpServerSchema.parse(stdio)).toEqual({
      ...stdio,
      description: "",
      enabled: true,
      exposure: "direct",
      toolExposure: {},
      timeoutSec: 60,
      snapshotId: null,
      askUnlessReadOnly: false,
      startupTimeoutSec: 60,
    });
    expect(mcpServerSchema.parse(http)).toEqual({
      ...http,
      description: "",
      enabled: true,
      exposure: "direct",
      toolExposure: {},
      timeoutSec: 60,
      snapshotId: null,
      // Remote servers ask before calls not marked read-only by default.
      askUnlessReadOnly: true,
    });
    expect(
      mcpServerSchema.parse({ ...http, askUnlessReadOnly: false })
        .askUnlessReadOnly,
    ).toBe(false);
    expect(
      mcpServerSchema.parse({
        ...stdio,
        cwd: "tools/docs",
        exposure: "hidden",
        toolExposure: { search: "direct" },
        timeoutSec: 600,
        startupTimeoutSec: 300,
        snapshotId: "snap_1",
      }),
    ).toMatchObject({ cwd: "tools/docs", toolExposure: { search: "direct" } });
  });

  it("names servers with lowercase words joined by single underscores, at most 24 characters", () => {
    for (const good of ["a", "docs", "my_docs2", "a1_b2_c3", "x".repeat(24)])
      expect(mcpServerNameSchema.safeParse(good).success, good).toBe(true);
    for (const bad of [
      "",
      "my__docs",
      "docs_",
      "_docs",
      "Docs",
      "DOCS",
      "2docs",
      "my-docs",
      "my docs",
      "x".repeat(25),
    ])
      expect(mcpServerNameSchema.safeParse(bad).success, bad).toBe(false);
  });

  it("accepts only an https URL, without credentials in it, stored normalized", () => {
    const url = (value: string) =>
      mcpHttpServerSchema.parse({ ...http, url: value }).url;
    expect(url("https://mcp.example.com/mcp")).toBe(
      "https://mcp.example.com/mcp",
    );
    expect(url(" HTTPS://Mcp.Example.com ")).toBe("https://mcp.example.com/");
    expect(url("https://203.0.113.7:8443/mcp")).toBe(
      "https://203.0.113.7:8443/mcp",
    );
    expect(url("https://mcp.example.com/mcp?team=core&page=2")).toBe(
      "https://mcp.example.com/mcp?team=core&page=2",
    );
    // The check reads names only: a secret written into the path is not seen.
    expect(url("https://mcp.example.com/sk-live-abc123/mcp;v=2")).toBe(
      "https://mcp.example.com/sk-live-abc123/mcp;v=2",
    );
    // A non-ASCII host is stored as punycode, so a look-alike shows as such.
    expect(url("https://bücher.example/mcp")).toBe(
      "https://xn--bcher-kva.example/mcp",
    );
    for (const bad of [
      "http://mcp.example.com/mcp",
      "ftp://mcp.example.com",
      "wss://mcp.example.com",
      "https:mcp.example.com",
      "https:/mcp.example.com",
      "https://",
      "mcp.example.com",
      "https://user:token@mcp.example.com/mcp",
      "https://token@mcp.example.com/mcp",
      "https://mcp.example.com/mcp?api_key=abc",
      "https://mcp.example.com/mcp?apikey=abc",
      "https://mcp.example.com/mcp?access_token=abc",
      "https://mcp.example.com/mcp?Secret=abc",
      "https://mcp.example.com/mcp?password=abc",
      "https://mcp.example.com/mcp?auth=abc",
      // The name pattern is broad on purpose: a false positive only moves a value to secretHeaders.
      "https://mcp.example.com/mcp?author=me",
      "https://mcp.example.com/mcp?key=abc",
      "https://mcp.example.com/mcp?X-Amz-Signature=abc",
      "https://mcp.example.com/mcp?sig=abc",
      "https://mcp.example.com/mcp?code=abc",
      "https://mcp.example.com/mcp?pwd=abc",
      "https://mcp.example.com/mcp?pass=abc",
      "https://mcp.example.com/mcp?subscription-key=abc",
      // Encoded names are decoded, and `;` separates parameters too.
      "https://mcp.example.com/mcp?t%6Fken=abc",
      "https://mcp.example.com/mcp?a=1;token=abc",
      "https://mcp.example.com/mcp;token=abc",
      "https://mcp.example.com/v1;session=1;api_key=abc/mcp",
      "https://mcp.example.com/mcp#access_token=abc",
      // URL parsing would drop the newline and tab, and read \ as /.
      "https://mcp.exa\nmple.com/mcp",
      "https://mcp.example.com/m\tcp",
      "https://mcp.example.com\\@evil.example/mcp",
      `https://example.com/${"x".repeat(2048)}`,
    ]) {
      const result = server({ url: bad }, http);
      expect(result.success, bad).toBe(false);
      expect(issuePath(result), bad).toEqual(["url"]);
    }
  });

  it("takes any POSIX variable name for a stdio server except JJ_*", () => {
    for (const name of [
      "PATH",
      "HOME",
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "HTTPS_PROXY",
      "npm_config_cache",
      "_private",
      "x".repeat(128),
    ]) {
      expect(server({ env: { [name]: "x" } }).success, name).toBe(true);
      expect(
        server({ secretEnv: { [name]: "DOCS_TOKEN" } }).success,
        name,
      ).toBe(true);
    }
    for (const name of [
      "JJ_SANDBOX_EXEC",
      "JJ_TOKEN",
      "1BAD",
      "has-dash",
      "has space",
      "",
      "x".repeat(129),
    ]) {
      expect(server({ env: { [name]: "x" } }).success, name).toBe(false);
      expect(
        server({ secretEnv: { [name]: "DOCS_TOKEN" } }).success,
        name,
      ).toBe(false);
    }
    // The value of secretEnv names a stored secret, with the secrets' rules.
    expect(server({ secretEnv: { DOCS_TOKEN: "PATH" } }).success).toBe(false);
    expect(server({ secretEnv: { DOCS_TOKEN: "docs" } }).success).toBe(false);
    // A variable comes from one place only.
    const twice = server({
      env: { DOCS_TOKEN: "plain" },
      secretEnv: { DOCS_TOKEN: "DOCS_TOKEN" },
    });
    expect(twice.success).toBe(false);
    expect(issuePath(twice)).toEqual(["secretEnv", "DOCS_TOKEN"]);
  });

  it("refuses a command, argument or path that cannot run as given", () => {
    expect(server({ command: "" }).success).toBe(false);
    expect(server({ command: "node\u0000x" }).success).toBe(false);
    expect(server({ args: ["ok", "bad\u0000"] }).success).toBe(false);
    expect(
      server({ args: Array.from({ length: 65 }, () => "a") }).success,
    ).toBe(false);
    for (const cwd of [
      "/etc",
      "../outside",
      "a/../../b",
      ".",
      "./.",
      "./tools",
      "tools//docs",
      "tools/",
      "a/\u0000",
    ])
      expect(server({ cwd }).success, cwd).toBe(false);
    expect(server({ cwd: "tools/.docs" }).success).toBe(true);
    for (const timeout of [0, 601, 1.5])
      expect(server({ timeoutSec: timeout }).success, String(timeout)).toBe(
        false,
      );
    expect(server({ startupTimeoutSec: 301 }).success).toBe(false);
  });

  it("refuses reserved, malformed or repeated headers", () => {
    for (const name of [
      "Host",
      "content-length",
      "Content-Type",
      "Accept",
      "Connection",
      "Transfer-Encoding",
      "Mcp-Session-Id",
      "MCP-Protocol-Version",
      "Last-Event-ID",
      "Bad Header",
      "X_Under",
      "",
    ]) {
      expect(server({ headers: { [name]: "v" } }, http).success, name).toBe(
        false,
      );
      expect(
        server({ secretHeaders: { [name]: { secret: "TRACKER_TOKEN" } } }, http)
          .success,
        name,
      ).toBe(false);
    }
    expect(
      server({ headers: { "X-Team": "a\r\nX-Evil: 1" } }, http).success,
    ).toBe(false);
    const repeated = server(
      {
        headers: { "x-team": "core" },
        secretHeaders: { "X-Team": { secret: "TRACKER_TOKEN" } },
      },
      http,
    );
    expect(repeated.success).toBe(false);
    expect(issuePath(repeated)).toEqual(["secretHeaders", "X-Team"]);
    expect(
      server({ secretHeaders: { "X-Key": { secret: "lower" } } }, http).success,
    ).toBe(false);
  });

  it("keeps credential headers out of plain headers, for secretHeaders instead", () => {
    for (const name of [
      "Authorization",
      "proxy-authorization",
      "Cookie",
      "X-Api-Key",
      "X-APIKEY",
      "Api-Key",
      "X-Auth-Token",
      "X-Access-Token",
      "X-Client-Secret",
      "X-Password",
      "X-Passwd",
      "X-Access-Key",
      "Ocp-Apim-Subscription-Key",
      "Key",
      "X-Signature",
      "X-Sig",
      "X-Pass",
      "X-Pwd",
      "X-Auth-Code",
    ]) {
      const plain = server({ headers: { [name]: "value" } }, http);
      expect(plain.success, name).toBe(false);
      expect(plain.error?.issues[0]?.message, name).toContain("secretHeaders");
      expect(
        server({ secretHeaders: { [name]: { secret: "TRACKER_TOKEN" } } }, http)
          .success,
        name,
      ).toBe(true);
    }
    expect(
      server({ headers: { "X-Team": "core", "X-Request-Source": "jj" } }, http)
        .success,
    ).toBe(true);
  });

  it("holds at most 8 servers with unique names", () => {
    const named = (name: string) => ({ ...stdio, name, secretEnv: {} });
    const eight = Array.from({ length: MAX_MCP_SERVERS }, (_, index) =>
      named(`s${index}`),
    );
    expect(mcpServersSchema.safeParse(eight).success).toBe(true);
    expect(mcpServersSchema.safeParse([...eight, named("s8")]).success).toBe(
      false,
    );
    const duplicate = mcpServersSchema.safeParse([
      named("docs"),
      { ...http, name: "docs" },
    ]);
    expect(duplicate.success).toBe(false);
    expect(issuePath(duplicate)).toEqual([1, "name"]);
  });

  it("refuses an unknown transport, legacy SSE included", () => {
    expect(server({ transport: "sse" }, http).success).toBe(false);
    expect(server({ transport: undefined }, http).success).toBe(false);
  });
});

describe("MCP servers on a runtime profile", () => {
  const command = (fields: Record<string, unknown>) =>
    createRuntimeProfileCommandSchema.safeParse({
      name: "With MCP",
      sandbox: { driver: "local", network: { mode: "open" } },
      ...fields,
    });

  it("requires each secretEnv secret to be granted by the same profile", () => {
    expect(
      command({ secrets: ["DOCS_TOKEN"], mcpServers: [stdio] }).success,
    ).toBe(true);
    for (const secrets of [undefined, [], ["OTHER_TOKEN"]]) {
      const refused = command({ secrets, mcpServers: [http, stdio] });
      expect(refused.success).toBe(false);
      expect(refused.error?.issues).toHaveLength(1);
      expect(issuePath(refused)).toEqual([
        "mcpServers",
        1,
        "secretEnv",
        "DOCS_TOKEN",
      ]);
      expect(refused.error?.issues[0]?.message).toContain("not granted");
    }
    // A secret header's secret is never granted to a sandbox: the server checks it is stored.
    expect(command({ mcpServers: [http] }).success).toBe(true);
    // A malformed server is reported as such, without the grant check failing on it.
    const malformed = command({
      mcpServers: [{ ...stdio, secretEnv: "DOCS_TOKEN" }],
    });
    expect(malformed.success).toBe(false);
  });

  it("checks a patch's grants when it carries both lists, and leaves the merge to the server otherwise", () => {
    const patch = (fields: Record<string, unknown>) =>
      updateRuntimeProfileCommandSchema.safeParse(fields);
    expect(
      patch({ mcpServers: [stdio], secrets: ["DOCS_TOKEN"] }).success,
    ).toBe(true);
    expect(patch({ mcpServers: [stdio], secrets: [] }).success).toBe(false);
    // A disabled server (its secret removed) runs nowhere: not checked.
    expect(
      patch({ mcpServers: [{ ...stdio, enabled: false }], secrets: [] })
        .success,
    ).toBe(true);
    expect(patch({ mcpServers: [stdio] }).success).toBe(true);
    expect(patch({ secrets: [] }).success).toBe(true);
    expect(patch({ mcpServers: [], skills: [] })).toMatchObject({
      success: true,
      data: { mcpServers: [], skills: [] },
    });
  });

  it("is contract 1.12.0, which the changelog's newest entry records", () => {
    expect(CONTRACT_VERSION).toBe("1.12.0");
    const changelog = readFileSync(
      new URL("../../../docs/contract-changelog.md", import.meta.url),
      "utf8",
    );
    expect(/^## (\d+\.\d+\.\d+) — /m.exec(changelog)?.[1]).toBe(
      CONTRACT_VERSION,
    );
    expect(changelog).toMatch(
      /^## 1\.12\.0 — .* — MCP servers in sessions; a discovery's configuration hash$/m,
    );
  });

  it("takes an optional draft sandbox in a discovery, in the profile's shape", () => {
    const server = { name: "docs", transport: "stdio", command: "docs-mcp" };
    expect(startMcpDiscoveryCommandSchema.parse({ server }).sandbox).toBe(
      undefined,
    );
    expect(
      startMcpDiscoveryCommandSchema.parse({
        server,
        sandbox: { driver: "docker", env: { REGION: "eu" } },
      }).sandbox,
    ).toMatchObject({
      driver: "docker",
      env: { REGION: "eu" },
      network: { mode: "none" },
      workspace: "task",
    });
    expect(
      startMcpDiscoveryCommandSchema.safeParse({
        server,
        sandbox: { env: { REGION: "eu" } },
      }).success,
    ).toBe(false);
  });

  it("lists the ungranted secrets for the server's merged check", () => {
    const servers = mcpServersSchema.parse([stdio, http]);
    expect(ungrantedMcpSecrets(servers, [])).toEqual([
      {
        index: 0,
        server: "docs",
        variable: "DOCS_TOKEN",
        secret: "DOCS_TOKEN",
      },
    ]);
    expect(ungrantedMcpSecrets(servers, ["DOCS_TOKEN"])).toEqual([]);
    // Enabled servers only: a disabled one is checked once it is enabled.
    const disabled = mcpServersSchema.parse([{ ...stdio, enabled: false }]);
    expect(ungrantedMcpSecrets(disabled, [])).toEqual([]);
    expect(
      command({ mcpServers: [{ ...stdio, enabled: false }], secrets: [] })
        .success,
    ).toBe(true);
    expect(command({ mcpServers: [stdio], secrets: [] }).success).toBe(false);
  });

  it("parses profiles from servers before MCP as having none, and stays lenient on read", () => {
    const stored = {
      id: "p1",
      name: "Local",
      sandbox: { driver: "local" },
      budgets: {},
      isDefault: true,
      status: { driverAvailable: true, isolated: false },
      createdAt: at,
      updatedAt: at,
    };
    expect(runtimeProfileSchema.parse(stored)).toMatchObject({
      mcpServers: [],
      skills: [],
    });
    // A removed secret leaves its server disabled; the record still parses.
    expect(
      runtimeProfileSchema.parse({
        ...stored,
        mcpServers: [{ ...stdio, enabled: false }],
      }).mcpServers,
    ).toHaveLength(1);
  });

  it("grants at most 32 unique, well-named skills", () => {
    const names = Array.from({ length: 32 }, (_, index) => `skill-${index}`);
    expect(command({ skills: names }).success).toBe(true);
    expect(command({ skills: [...names, "skill-32"] }).success).toBe(false);
    expect(command({ skills: ["pdf", "pdf"] }).success).toBe(false);
    for (const bad of ["PDF", "pdf_tools", "-pdf", "pdf-", "pdf--x", ""])
      expect(command({ skills: [bad] }).success, bad).toBe(false);
  });
});

describe("MCP tool names", () => {
  it("prefixes, sanitizes and keeps short names as pi does", () => {
    expect(mcpToolName("docs", "search")).toBe("mcp__docs__search");
    expect(mcpToolName("docs", "get.page")).toBe("mcp__docs__get_page");
    expect(mcpToolName("docs", "a-b")).toBe("mcp__docs__a_b");
    // Each UTF-16 unit outside [A-Za-z0-9_] becomes "_", an emoji two.
    expect(mcpToolName("docs", "ünïcode😀")).toBe("mcp__docs___n_code__");
    const exactly64 = "list_pull_request_review_comments_for_repository_v2";
    expect(mcpToolName("github", exactly64)).toBe(`mcp__github__${exactly64}`);
    expect(mcpToolName("github", exactly64)).toHaveLength(64);
  });

  it("shortens a name over 64 characters with a sha256 suffix of server and tool", () => {
    const tool = "x".repeat(57);
    const name = mcpToolName("s", tool);
    expect(name).toBe(`mcp__s__${"x".repeat(47)}_065b956f`);
    expect(name).toHaveLength(64);
    expect(name.slice(-8)).toBe(hash(`s\0${tool}`).slice(0, 8));
    expect(mcpToolName("my_server", "x".repeat(60))).toBe(
      `mcp__my_server__${"x".repeat(39)}_cdc4768b`,
    );
    // Deterministic.
    expect(mcpToolName("s", tool)).toBe(name);
  });

  it("suffixes a name the caller reports taken", () => {
    expect(mcpToolName("docs", "a_b", () => true)).toBe(
      "mcp__docs__a_b_63617bb9",
    );
    expect(hash("docs\0a_b").slice(0, 8)).toBe("63617bb9");
  });

  it("names a server's list order-independently, suffixing every tool that collides", () => {
    const tools = ["search", "a-b", "a_b", "a.b", "get", "x".repeat(70)];
    const names = mcpToolNames("docs", tools);
    expect(names.get("search")).toBe("mcp__docs__search");
    expect(names.get("get")).toBe("mcp__docs__get");
    // a-b, a_b and a.b all sanitize to a_b: none keeps the plain name.
    for (const tool of ["a-b", "a_b", "a.b"])
      expect(names.get(tool)).toBe(
        `mcp__docs__a_b_${hash(`docs\0${tool}`).slice(0, 8)}`,
      );
    expect(new Set(names.values()).size).toBe(tools.length);

    const permutations = [
      [...tools].reverse(),
      [tools[3], tools[0], tools[5], tools[1], tools[4], tools[2]],
      [...tools, "search"],
    ];
    for (const order of permutations)
      expect(mcpToolNames("docs", order as string[])).toEqual(names);
  });

  it("keeps names unique even when a shortened name meets another tool's", () => {
    const long = "x".repeat(70);
    const shortened = mcpToolName("s", long);
    // A tool whose plain name is exactly the long tool's shortened one.
    const twin = shortened.slice("mcp__s__".length);
    for (const order of [
      [long, twin],
      [twin, long],
    ]) {
      const names = mcpToolNames("s", order);
      expect(new Set(names.values()).size).toBe(2);
      for (const name of names.values()) {
        expect(name.length).toBeLessThanOrEqual(64);
        expect(mcpToolSchema.shape.exposedName.safeParse(name).success).toBe(
          true,
        );
      }
      expect(mcpToolNames("s", order)).toEqual(names);
    }
  });

  it("gives every tool a valid exposed name of at most 64 characters", () => {
    const tools = [
      "",
      "-",
      "a".repeat(128),
      "名前",
      "tool with spaces",
      "UPPER_case",
      ...Array.from({ length: 30 }, (_, index) => `t-${index}`),
      ...Array.from({ length: 30 }, (_, index) => `t_${index}`),
    ];
    const names = mcpToolNames("x".repeat(24), tools);
    expect(new Set(names.values()).size).toBe(tools.length);
    for (const name of names.values()) {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name.startsWith(`mcp__${"x".repeat(24)}__`)).toBe(true);
    }
  });

  it("never gives a built-in tool name the MCP prefix", () => {
    for (const tool of [...CODING_TOOLS, ...COLLABORATION_TOOLS]) {
      expect(tool.startsWith(MCP_TOOL_PREFIX), tool).toBe(false);
      expect(MCP_TOOL_SELECTOR_PATTERN.test(tool), tool).toBe(false);
    }
  });
});

const tool = (name: string, server = "docs") => ({
  name,
  exposedName: mcpToolName(server, name),
  description: `Does ${name}.`,
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  hash: hash(name),
});

const snapshot = (
  id: string,
  server: string,
  tools: string[],
): McpToolSnapshot =>
  mcpToolSnapshotSchema.parse({
    id,
    profileId: "p1",
    server,
    configHash: hash(`${server} config`),
    serverInfo: {
      name: server,
      version: "1.0.0",
      protocolVersion: "2025-06-18",
    },
    tools: tools.map((name) => ({
      ...tool(name, server),
      exposedName: mcpToolNames(server, tools).get(name),
    })),
    warnings: [],
    discoveredAt: at,
  });

describe("MCP snapshots and discoveries", () => {
  it("parses a snapshot, its discovery and the route results", () => {
    const docs = snapshot("snap_1", "docs", ["search", "fetch"]);
    expect(mcpSnapshotResultSchema.parse({ snapshot: docs })).toEqual({
      snapshot: docs,
    });
    const discovery = {
      id: "disc_1",
      profileId: "p1",
      server: "docs",
      configHash: docs.configHash,
      status: "succeeded",
      error: null,
      stderrTail: null,
      snapshot: docs,
      durationMs: 812,
      createdAt: at,
      finishedAt: at,
    };
    expect(mcpDiscoveryResultSchema.parse({ discovery })).toEqual({
      discovery,
    });
    for (const status of ["queued", "running", "failed"])
      expect(
        mcpDiscoverySchema.safeParse({
          ...discovery,
          status,
          snapshot: null,
          finishedAt: null,
          durationMs: null,
        }).success,
      ).toBe(true);
    expect(
      mcpDiscoverySchema.safeParse({ ...discovery, status: "done" }).success,
    ).toBe(false);
    // The hash of what the test runs is there from the start, for a client to match.
    const { configHash: _hash, ...unhashed } = discovery;
    expect(mcpDiscoverySchema.safeParse(unhashed).success).toBe(false);
    expect(
      mcpDiscoverySchema.safeParse({ ...discovery, configHash: "abc" }).success,
    ).toBe(false);
    expect(
      startMcpDiscoveryCommandSchema.parse({ server: http }).server,
    ).toMatchObject({ transport: "http", askUnlessReadOnly: true });
    expect(startMcpDiscoveryCommandSchema.safeParse({}).success).toBe(false);
  });

  it("keeps tools within the snapshot limits", () => {
    const base = tool("search");
    expect(mcpToolSchema.safeParse(base).success).toBe(true);
    for (const exposedName of [
      "search",
      "mcp__docs__a-b",
      `mcp__${"x".repeat(60)}`,
      // No tool after the server's prefix, or no prefix at all.
      "mcp__docs__",
      "mcp__docs",
      "mcp____x",
      "mcp__Docs__search",
    ])
      expect(
        mcpToolSchema.safeParse({ ...base, exposedName }).success,
        exposedName,
      ).toBe(false);
    for (const exposedName of ["mcp__docs___x", "mcp__docs__a_b_63617bb9"])
      expect(
        mcpToolSchema.safeParse({ ...base, exposedName }).success,
        exposedName,
      ).toBe(true);
    expect(
      mcpToolSchema.safeParse({ ...base, description: "x".repeat(2001) })
        .success,
    ).toBe(false);
    expect(mcpToolSchema.safeParse({ ...base, hash: "abc" }).success).toBe(
      false,
    );
    expect(
      mcpToolSnapshotSchema.safeParse({
        ...snapshot("snap_1", "docs", []),
        tools: Array.from({ length: 201 }, (_, index) => tool(`t${index}`)),
      }).success,
    ).toBe(false);
  });

  it("keeps every exposed name under its server's prefix, and unique, within a snapshot", () => {
    const docs = snapshot("snap_1", "docs", ["search", "fetch"]);
    const withTools = (tools: unknown[]) =>
      mcpToolSnapshotSchema.safeParse({ ...docs, tools });
    const [search, fetch] = docs.tools as [McpTool, McpTool];
    expect(withTools([search, fetch]).success).toBe(true);
    const foreign = withTools([
      search,
      { ...fetch, exposedName: "mcp__tracker__fetch" },
    ]);
    expect(foreign.success).toBe(false);
    expect(issuePath(foreign)).toEqual(["tools", 1, "exposedName"]);
    // A server name that only starts the same is another server.
    expect(
      withTools([{ ...search, exposedName: "mcp__docs_v2__search" }]).success,
    ).toBe(false);
    const sameExposed = withTools([
      search,
      { ...fetch, exposedName: search.exposedName },
    ]);
    expect(sameExposed.success).toBe(false);
    expect(issuePath(sameExposed)).toEqual(["tools", 1, "exposedName"]);
    const sameName = withTools([search, { ...fetch, name: search.name }]);
    expect(sameName.success).toBe(false);
    expect(issuePath(sameName)).toEqual(["tools", 1, "name"]);
  });

  it("declares the direct tools of enabled servers with a matching snapshot, sorted", () => {
    const servers: McpServer[] = mcpServersSchema.parse([
      { ...stdio, secretEnv: {}, snapshotId: "snap_docs" },
      {
        ...http,
        exposure: "hidden",
        toolExposure: { create: "direct" },
        snapshotId: "snap_tracker",
      },
      {
        ...stdio,
        name: "off",
        secretEnv: {},
        enabled: false,
        snapshotId: "snap_off",
      },
      { ...stdio, name: "new", secretEnv: {} },
      { ...stdio, name: "wrong", secretEnv: {}, snapshotId: "snap_docs" },
    ]);
    servers[0] = {
      ...(servers[0] as McpServer),
      toolExposure: { fetch: "hidden" },
    };
    const snapshots = [
      snapshot("snap_docs", "docs", ["search", "fetch"]),
      snapshot("snap_tracker", "tracker", ["create", "list"]),
      snapshot("snap_off", "off", ["x"]),
    ];
    expect(declaredMcpTools(servers, snapshots)).toEqual([
      "mcp__docs__search",
      "mcp__tracker__create",
    ]);
    expect(declaredMcpTools(servers, [])).toEqual([]);
  });
});

describe("approval rules on MCP tools", () => {
  it("accepts an MCP tool or a whole server as a rule's tool", () => {
    for (const good of [
      "mcp__docs__search",
      "mcp__docs__*",
      "mcp__my_docs__a_b_63617bb9",
      "mcp__docs___private",
    ])
      expect(mcpToolSelectorSchema.safeParse(good).success, good).toBe(true);
    for (const bad of [
      "mcp__Docs__search",
      "mcp__docs_*",
      "mcp__docs__",
      "mcp__docs__a-b",
      "mcp____x",
      "mcp__docs__*x",
      "mcp__docs__se*",
      "mcp__docs",
      `mcp__${"x".repeat(25)}__*`,
      `mcp__docs__${"x".repeat(54)}`,
      "bash",
    ])
      expect(mcpToolSelectorSchema.safeParse(bad).success, bad).toBe(false);
    expect(approvalRuleSchema.parse({ tool: "mcp__docs__*" })).toEqual({
      tool: "mcp__docs__*",
    });
    expect(approvalRuleSchema.parse({ tool: "bash" })).toEqual({
      tool: "bash",
    });
    for (const bad of ["delegate", "complete_task", "mcp__docs", "*"])
      expect(approvalRuleSchema.safeParse({ tool: bad }).success, bad).toBe(
        false,
      );
  });

  it("matches one tool exactly, or every tool of one server with *", () => {
    expect(toolSelectorMatches("mcp__docs__search", "mcp__docs__search")).toBe(
      true,
    );
    expect(
      toolSelectorMatches("mcp__docs__search", "mcp__docs__searches"),
    ).toBe(false);
    expect(toolSelectorMatches("mcp__docs__*", "mcp__docs__search")).toBe(true);
    expect(toolSelectorMatches("mcp__docs__*", "mcp__docs___private")).toBe(
      true,
    );
    for (const other of [
      "mcp__docs_v2__search",
      "mcp__doc__search",
      "mcp__docs__",
      "mcp__docs__*x",
      "bash",
    ])
      expect(toolSelectorMatches("mcp__docs__*", other), other).toBe(false);
    expect(toolSelectorMatches("bash", "bash")).toBe(true);
    expect(toolSelectorMatches("bash", "mcp__bash__x")).toBe(false);
  });

  it("matches a rule against the arguments' unescaped keys and values, in canonical order", () => {
    const args = {
      query: "drop\ntable",
      options: { z: 1, a: [2, { y: 3, b: true, c: null }] },
    };
    expect(approvalSubject("mcp__docs__search", args)).toBe(
      "options a 2 b c y 3 z 1 query drop\ntable",
    );
    // The card shows canonical one-line JSON; the rule sees what the call holds.
    expect(canonicalJson(args)).toBe(
      '{"options":{"a":[2,{"b":true,"c":null,"y":3}],"z":1},"query":"drop\\ntable"}',
    );
    const rule = (match: string) =>
      approvalRuleSchema.parse({ tool: "mcp__shell__run", match });
    // JSON escaping would hide both of these from a match on the JSON text.
    expect(
      approvalRuleMatches(rule("rm -rf /"), "mcp__shell__run", {
        cmd: "rm -rf\n/",
      }),
    ).toBe(true);
    expect(
      approvalRuleMatches(rule("C:\\Windows"), "mcp__shell__run", {
        path: "C:\\Windows",
      }),
    ).toBe(true);
    expect(
      approvalRuleMatches(rule("C:\\Windows"), "mcp__shell__run", {
        path: "C:\\Windows\\System32",
      }),
    ).toBe(true);
    expect(
      approvalRuleMatches(rule('"rm'), "mcp__shell__run", { cmd: "rm -rf /" }),
    ).toBe(false);

    const rules = [
      approvalRuleSchema.parse({
        tool: "mcp__docs__search",
        match: "query drop*",
      }),
      approvalRuleSchema.parse({ tool: "mcp__tracker__*" }),
    ];
    expect(matchingApprovalRule(rules, "mcp__docs__search", args)).toBe(
      rules[0],
    );
    expect(
      matchingApprovalRule(rules, "mcp__docs__search", { query: "read" }),
    ).toBeUndefined();
    expect(matchingApprovalRule(rules, "mcp__tracker__create", {})).toBe(
      rules[1],
    );
    expect(
      matchingApprovalRule(rules, "mcp__docs__fetch", args),
    ).toBeUndefined();
    expect(
      matchingApprovalRule(rules, "bash", { command: "drop" }),
    ).toBeUndefined();
  });

  it("stays linear on long MCP arguments that do not match", () => {
    const args = {
      text: "a".repeat(400_000),
      items: Array.from({ length: 20_000 }, (_, index) => ({ n: index })),
    };
    const started = performance.now();
    expect(
      approvalRuleMatches(
        { tool: "mcp__docs__write", match: "a*a*a*a*b" },
        "mcp__docs__write",
        args,
      ),
    ).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("holds a call whose arguments it cannot read under every rule for its tool, and says why", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let level = 0; level < 10_000; level += 1) deep = { deep };
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const unreadable: [string, Record<string, unknown>, string][] = [
      ["cycle", cyclic, "refer to themselves"],
      ["10k levels", deep, "nest deeper than 64 levels"],
      ["BigInt", { size: 10n }, "hold a value JSON cannot represent"],
      [
        "huge string",
        { text: "x".repeat(2_000_000) },
        "run longer than 1048576 characters",
      ],
      [
        "throwing getter",
        Object.defineProperty({}, "boom", {
          enumerable: true,
          get() {
            throw new Error("boom");
          },
        }),
        "hold a value JSON cannot represent",
      ],
    ];
    const rules = [
      approvalRuleSchema.parse({ tool: "mcp__other__*" }),
      approvalRuleSchema.parse({
        tool: "mcp__docs__search",
        match: "never there",
      }),
    ];
    for (const [label, args, reason] of unreadable) {
      expect(approvalSubject("mcp__docs__search", args), label).toBeUndefined();
      expect(canonicalJson(args), label).toBeUndefined();
      expect(
        approvalSubjectProblem("mcp__docs__search", args),
        label,
      ).toContain(reason);
      // Fails closed: the rule's match cannot be checked, so the call waits.
      expect(
        matchingApprovalRule(rules, "mcp__docs__search", args),
        label,
      ).toBe(rules[1]);
      // A rule for another tool still never holds it.
      expect(
        matchingApprovalRule(rules.slice(1), "mcp__docs__fetch", args),
        label,
      ).toBeUndefined();
    }
    expect(approvalSubjectProblem("mcp__docs__search", { q: "ok" })).toBe(
      undefined,
    );
    expect(approvalSubjectProblem("write", { path: "a" })).toBe(undefined);
  });

  it("finds exact MCP rules that name no tool of their server's pinned snapshot", () => {
    const servers = mcpServersSchema.parse([
      { ...stdio, secretEnv: {}, snapshotId: "snap_docs" },
      { ...http },
    ]);
    const snapshots = [snapshot("snap_docs", "docs", ["search", "a-b"])];
    const rules = [
      { tool: "mcp__docs__search" },
      // a-b's exposed name.
      { tool: "mcp__docs__a_b" },
      { tool: "mcp__docs__fetch" },
      { tool: "mcp__docs__*" },
      // tracker has no snapshot.
      { tool: "mcp__tracker__create" },
      { tool: "mcp__tracker__*" },
      { tool: "mcp__gone__x" },
      { tool: "bash", match: "git push" },
    ] as const;
    expect(mcpRulesWithoutTool(rules, servers, snapshots)).toEqual([2, 4, 6]);
    expect(mcpRulesWithoutTool(rules, [], [])).toEqual([0, 1, 2, 4, 6]);
    // `a-b` alone keeps the plain name; add `a_b` and both are renamed.
    const renamed = [snapshot("snap_docs", "docs", ["search", "a-b", "a_b"])];
    expect(
      mcpRulesWithoutTool(
        [approvalRuleSchema.parse({ tool: mcpToolName("docs", "a-b") })],
        servers,
        renamed,
      ),
    ).toEqual([0]);
  });

  it("describes MCP rules on one line", () => {
    expect(describeApprovalRule({ tool: "mcp__docs__*" })).toBe(
      "every call to MCP server docs",
    );
    expect(
      describeApprovalRule({ tool: "mcp__docs__*", match: "delete" }),
    ).toBe("calls to MCP server docs matching `delete`");
    expect(describeApprovalRule({ tool: "mcp__docs__search" })).toBe(
      "every mcp__docs__search call",
    );
  });
});

describe("canonical JSON and SHA-256", () => {
  it("sorts keys by code units at every depth and keeps arrays in order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    // An object would list integer-like keys first, in numeric order.
    expect(canonicalJson({ a: 3, 2: 2, 10: 1 })).toBe('{"10":1,"2":2,"a":3}');
    expect(canonicalForm({ a: 3, 2: "two", 10: 1 })).toEqual({
      ok: true,
      json: '{"10":1,"2":"two","a":3}',
      words: "10 1 2 two a 3",
    });
    expect(canonicalJson({ a: undefined, b: [undefined, Number.NaN] })).toBe(
      '{"b":[null,null]}',
    );
    expect(canonicalJson(undefined)).toBe("null");
    // An own "__proto__" key is data, not a prototype.
    expect(canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toBe(
      '{"__proto__":{"x":1},"a":2}',
    );
    // A shared, non-cyclic value is written each time it appears.
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe(
      '{"a":{"x":1},"b":{"x":1}}',
    );
  });

  it("never throws, and says why a value has no canonical form", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    let deep: unknown = "leaf";
    for (let level = 0; level < 10_000; level += 1) deep = [deep];
    let deepEnough: unknown = "leaf";
    for (let level = 0; level < 64; level += 1) deepEnough = [deepEnough];
    const problem = (value: unknown) => {
      const form = canonicalForm(value);
      return form.ok ? "ok" : form.problem;
    };
    expect(problem(cyclic)).toBe("cycle");
    expect(problem(deep)).toBe("depth");
    expect(problem(deepEnough)).toBe("ok");
    expect(problem([deepEnough])).toBe("depth");
    expect(problem({ n: 1n })).toBe("unserializable");
    expect(problem({ f: () => 1 })).toBe("unserializable");
    expect(problem({ s: Symbol("s") })).toBe("unserializable");
    expect(problem({ d: new Date(0) })).toBe("unserializable");
    expect(problem("x".repeat(2_000_000))).toBe("length");
    expect(problem({ ["k".repeat(2_000_000)]: 1 })).toBe("length");
    expect(problem(Array.from({ length: 300_000 }, () => null))).toBe("length");
    expect(problem("x".repeat(1_048_574))).toBe("ok");
  });

  it("hashes as Node's crypto does", () => {
    for (const text of [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "a".repeat(1000),
      "é€😀",
      "\uD800 lone",
      "docs\0search",
    ])
      expect(sha256Hex(text), JSON.stringify(text)).toBe(hash(text));
  });
});
