import { randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer as createHttpServer, get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { createConnection, createServer } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  describeSandboxConformance,
  type NetworkProbe,
  type ProbeResult,
  probeNetwork,
  reached,
} from "./conformance";
import {
  type AcquireRequest,
  type Sandbox,
  SandboxCapabilityError,
  type SandboxProcess,
  SandboxRequestError,
  type SandboxSpecInput,
} from "./contract";
import {
  DOCKER_BASE_IMAGE,
  DockerSandboxDriver,
  egressNetworkProblem,
  ipv6Interfaces,
  parseSubnetPool,
} from "./drivers/docker";
import {
  DockerApiError,
  DockerEngine,
  DockerOutputLimitError,
  DockerProxyRefusedError,
  isNotFound,
  parseDockerHost,
  StreamDemuxer,
} from "./drivers/docker-engine";

/**
 * Docker driver tests. Everything that needs a daemon (DOCKER_HOST, else the
 * default socket) skips when none is reachable; CI provides one. The image is
 * JJ_SANDBOX_TEST_IMAGE when set (CI builds jj-sandbox:base-1 and sets it),
 * else jj-sandbox:base-1 when it is built (`npm run sandbox:image`), else
 * node:22-bookworm-slim, which also meets the driver's image requirements.
 * Every container, volume and network carries a per-run label and is removed
 * after the run; what a run whose process died first left behind is removed
 * by the first run that finds it stale (`isStaleRun`).
 */

const FALLBACK_IMAGE = "node:22-bookworm-slim";
const RUN_LABEL = "jj.test-run";
const runId = `${process.pid}-${Date.now().toString(36)}`;
const namespace = `jj-test-${runId}`;
const labels = { [RUN_LABEL]: runId };
const MiB = 1024 * 1024;

const health = await new DockerSandboxDriver().probe();
const engine = health.ok
  ? new DockerEngine(parseDockerHost(process.env.DOCKER_HOST))
  : undefined;
const requestedImage = process.env.JJ_SANDBOX_TEST_IMAGE?.trim() || undefined;
const image =
  requestedImage ??
  (engine &&
  (await engine
    .json("GET", `/images/${DOCKER_BASE_IMAGE}/json`)
    .then(() => true)
    .catch(() => false))
    ? DOCKER_BASE_IMAGE
    : FALLBACK_IMAGE);
if (!health.ok)
  console.warn(
    `[docker driver] skipping daemon tests: no Docker daemon reachable (${health.detail})`,
  );
else if (requestedImage)
  console.warn(
    `[docker driver] testing with ${requestedImage} (JJ_SANDBOX_TEST_IMAGE)`,
  );
else if (image !== DOCKER_BASE_IMAGE)
  console.warn(
    `[docker driver] ${DOCKER_BASE_IMAGE} is not built (npm run sandbox:image); testing with ${FALLBACK_IMAGE}`,
  );

/** The strict spec: network none (the conformance default) and every resource limit set. */
const strictSpec: Partial<SandboxSpecInput> = {
  image,
  resources: { cpus: 1, memoryMb: 512, processes: 256 },
};

const createDriver = () =>
  new DockerSandboxDriver({
    namespace,
    labels,
    killGraceMs: 300,
    egressProxyImage: image,
  });

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A plain GET from this process, which runs on the Docker host. */
const exchangeHttp = (host: string, port: number) =>
  new Promise<string>((resolve, reject) => {
    const request = httpGet(
      { host, port, path: "/", timeout: 2_000 },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve(body));
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });

type DockerSandbox = Sandbox & {
  containerId: string;
  containerName: string;
  volumeName: string;
  proxyContainerName?: string;
  networkName?: string;
};

interface ContainerInspect {
  Id: string;
  Config: { User: string; Env: string[] | null; Image: string };
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string; Gateway?: string }> | null;
  };
  HostConfig: Record<string, unknown> & {
    Privileged: boolean;
    CapDrop: string[] | null;
    CapAdd: string[] | null;
    SecurityOpt: string[] | null;
    Binds: string[] | null;
    Devices: unknown[] | null;
  };
  Mounts: Array<{
    Type: string;
    Name?: string;
    Source: string;
    Destination: string;
  }>;
}

/** Removes a run's containers, then its volumes and networks; returns what is left. */
async function removeRunResources(run = runId): Promise<string[]> {
  if (!engine) return [];
  const filters = JSON.stringify({ label: [`${RUN_LABEL}=${run}`] });
  const list = async () => {
    const containers = await engine.json<Array<{ Id: string }>>(
      "GET",
      "/containers/json",
      { query: { all: true, filters } },
    );
    const { Volumes } = await engine.json<{
      Volumes: Array<{ Name: string }> | null;
    }>("GET", "/volumes", { query: { filters } });
    const networks = await engine.json<Array<{ Id: string; Name: string }>>(
      "GET",
      "/networks",
      { query: { filters } },
    );
    return { containers, volumes: Volumes ?? [], networks };
  };
  const found = await list();
  await Promise.all(
    found.containers.map((container) =>
      engine
        .json("DELETE", `/containers/${container.Id}`, {
          query: { force: true, v: true },
        })
        .catch(() => {}),
    ),
  );
  await Promise.all([
    ...found.volumes.map((volume) =>
      engine.json("DELETE", `/volumes/${volume.Name}`).catch(() => {}),
    ),
    ...found.networks.map((network) =>
      engine.json("DELETE", `/networks/${network.Id}`).catch(() => {}),
    ),
  ]);
  const left = await list();
  return [
    ...left.containers.map((container) => `container ${container.Id}`),
    ...left.volumes.map((volume) => `volume ${volume.Name}`),
    ...left.networks.map((network) => `network ${network.Name}`),
  ];
}

/** Longer than any run of the docker tests, which takes minutes. */
const STALE_RUN_MS = 2 * 60 * 60_000;

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Whether `run`, a RUN_LABEL value (`<pid>-<start time in base 36>`, as this
 * file and the engine's docker test write it), is a run that is over: it
 * started more than STALE_RUN_MS ago and its process is not alive here. A run
 * whose process died before its `afterAll` (killed by a timeout, say) leaves
 * its resources behind. A live run is never stale, even one in another PID
 * namespace on a shared daemon, where its pid says nothing: it is younger.
 * Any other label value is left alone.
 */
function isStaleRun(run: string, now = Date.now(), alive = processAlive) {
  const match = /^([1-9]\d*)-([0-9a-z]+)$/.exec(run);
  if (!match) return false;
  const started = Number.parseInt(match[2] as string, 36);
  return now - started > STALE_RUN_MS && !alive(Number(match[1]));
}

/** Removes the resources of every stale run on the daemon; returns those runs. */
async function removeStaleRuns(): Promise<string[]> {
  if (!engine) return [];
  const filters = JSON.stringify({ label: [RUN_LABEL] });
  const labelled = [
    ...(await engine.json<Array<{ Labels?: Record<string, string> }>>(
      "GET",
      "/containers/json",
      { query: { all: true, filters } },
    )),
    ...((
      await engine.json<{
        Volumes: Array<{ Labels?: Record<string, string> | null }> | null;
      }>("GET", "/volumes", { query: { filters } })
    ).Volumes ?? []),
    ...(await engine.json<Array<{ Labels?: Record<string, string> }>>(
      "GET",
      "/networks",
      { query: { filters } },
    )),
  ];
  const stale = [
    ...new Set(labelled.map((resource) => resource.Labels?.[RUN_LABEL] ?? "")),
  ].filter((run) => isStaleRun(run));
  for (const run of stale) await removeRunResources(run);
  return stale;
}

describe("docker test runs", () => {
  const hour = 60 * 60_000;
  const now = Date.UTC(2026, 10, 3, 16);
  const id = (pid: number, started: number) => `${pid}-${started.toString(36)}`;

  it("are stale once over two hours old with no process alive", () => {
    const dead = () => false;
    expect(isStaleRun(id(16425, now - 3 * hour), now, dead)).toBe(true);
    expect(isStaleRun(id(16425, now - 1.5 * hour), now, dead)).toBe(false);
    // A live process keeps its run whatever its age.
    expect(isStaleRun(id(16425, now - 30 * hour), now, () => true)).toBe(false);
    // This run, and labels of any other form.
    expect(isStaleRun(runId)).toBe(false);
    for (const other of ["", "manual", "0-mw0qkqn5", "12-MW0", "12-mw0-x"])
      expect(isStaleRun(other, now, dead)).toBe(false);
  });

  it("are looked up by pid on this host", () => {
    expect(processAlive(process.pid)).toBe(true);
    // Above Linux's pid_max, so never a process.
    expect(processAlive(2 ** 22 + 1)).toBe(false);
  });
});

describe("docker engine client", () => {
  it("parses DOCKER_HOST values and refuses what it cannot speak", () => {
    expect(parseDockerHost(undefined)).toEqual({
      kind: "unix",
      socketPath: "/var/run/docker.sock",
    });
    expect(parseDockerHost("unix:///run/proxy.sock")).toEqual({
      kind: "unix",
      socketPath: "/run/proxy.sock",
    });
    expect(parseDockerHost("tcp://127.0.0.1:2375")).toEqual({
      kind: "tcp",
      host: "127.0.0.1",
      port: 2375,
    });
    expect(parseDockerHost("tcp://localhost:2375")).toMatchObject({
      host: "localhost",
    });
    expect(parseDockerHost("tcp://[::1]")).toEqual({
      kind: "tcp",
      host: "::1",
      port: 2375,
    });
    expect(() => parseDockerHost("ssh://user@host")).toThrow(/unsupported/);
    expect(() => parseDockerHost("unix://relative.sock")).toThrow(/absolute/);
    expect(() =>
      parseDockerHost("tcp://127.0.0.1:2376", { tlsVerify: "1" }),
    ).toThrow(/TLS/);
  });

  it("refuses plain tcp:// to a non-loopback host unless the operator opts in", async () => {
    for (const host of [
      "tcp://docker-proxy:2375",
      "tcp://10.0.0.5:2375",
      "tcp://[2001:db8::1]:2375",
      "tcp://127.0.0.1.example.com:2375",
    ])
      expect(() => parseDockerHost(host)).toThrow(/allowInsecureTcp/);
    expect(
      parseDockerHost("tcp://docker-proxy:2375", { allowInsecureTcp: true }),
    ).toEqual({ kind: "tcp", host: "docker-proxy", port: 2375 });
    const refused = await new DockerSandboxDriver({
      host: "tcp://10.0.0.5:2375",
    }).probe();
    expect(refused.ok).toBe(false);
    expect(refused.detail).toMatch(
      /not loopback.*JJ_DOCKER_ALLOW_INSECURE_TCP/s,
    );
  });

  it("demultiplexes attach frames split at any byte", () => {
    const frame = (stream: number, text: string) => {
      const payload = Buffer.from(text);
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const wire = Buffer.concat([
      frame(1, "out-1 "),
      frame(2, "err"),
      frame(1, ""),
      frame(1, "out-2"),
    ]);
    for (let size = 1; size <= wire.length; size++) {
      const seen: Record<number, string> = { 1: "", 2: "" };
      const demuxer = new StreamDemuxer((stream, chunk) => {
        seen[stream] += chunk.toString();
      });
      for (let offset = 0; offset < wire.length; offset += size)
        demuxer.push(wire.subarray(offset, offset + size));
      expect(seen).toEqual({ 1: "out-1 out-2", 2: "err" });
    }
  });

  it("refuses specs it cannot enforce or would ignore, without a daemon", () => {
    const driver = new DockerSandboxDriver({
      host: "unix:///nonexistent.sock",
    });
    const spec = (overrides: Partial<SandboxSpecInput> = {}) =>
      driver.validateSpec({ driver: "docker", ...overrides });
    expect(spec().network.mode).toBe("none");
    expect(spec({ network: { mode: "open" } }).network.mode).toBe("open");
    expect(
      spec({
        network: { mode: "allowlist", hosts: ["Example.com", "*.npmjs.org"] },
      }).network,
    ).toEqual({ mode: "allowlist", hosts: ["example.com", "*.npmjs.org"] });
    expect(() =>
      spec({ network: { mode: "allowlist", hosts: ["https://example.com"] } }),
    ).toThrow(/host such as/);
    expect(() => spec({ resources: { diskMb: 1024 } })).toThrow(
      SandboxCapabilityError,
    );
    expect(() => spec({ driverConfig: { privileged: true } })).toThrow(
      SandboxRequestError,
    );
    expect(() => spec({ env: { "A=B": "x" } })).toThrow(SandboxRequestError);
    expect(() => spec({ image: "bad image" })).toThrow(SandboxRequestError);
    expect(() => spec({ driver: "local" })).toThrow(SandboxRequestError);
  });

  it("takes egress subnet pools only from aligned private ranges", () => {
    expect(parseSubnetPool("10.213.0.0/16")).toEqual({
      base: (10 << 24) + (213 << 16),
      prefix: 16,
    });
    expect(parseSubnetPool("172.29.16.0/20").prefix).toBe(20);
    expect(parseSubnetPool("100.64.0.0/28").prefix).toBe(28);
    for (const bad of [
      "10.213.0.0",
      "10.213.0.1/16",
      "10.0.0.0/7",
      "10.0.0.0/29",
      "8.8.0.0/16",
      "172.32.0.0/16",
      "192.169.0.0/16",
      "300.1.0.0/16",
      "fd00::/64",
    ])
      expect(() => parseSubnetPool(bad), bad).toThrow(/egress subnet pool/);
    expect(
      () => new DockerSandboxDriver({ egressSubnetPool: "8.8.8.0/24" }),
    ).toThrow(/must lie in 10\/8/);
  });

  it("accepts an allowlist network only when Docker gave the host no address on it", () => {
    const subnet = "10.213.4.16/28";
    const made = {
      Internal: true,
      EnableIPv6: false,
      Options: { "com.docker.network.bridge.inhibit_ipv4": "true" },
      IPAM: { Config: [{ Subnet: subnet }] },
    };
    expect(egressNetworkProblem(made, subnet)).toBeUndefined();
    // Docker echoes any option, so the option alone proves nothing; a
    // gateway means the host's side of the bridge has that address.
    expect(
      egressNetworkProblem(
        {
          ...made,
          IPAM: { Config: [{ Subnet: subnet, Gateway: "10.213.4.17" }] },
        },
        subnet,
      ),
    ).toMatch(/host's side of its bridge the address 10\.213\.4\.17/);
    expect(egressNetworkProblem({ ...made, Internal: false }, subnet)).toMatch(
      /not internal/,
    );
    expect(egressNetworkProblem({ ...made, EnableIPv6: true }, subnet)).toMatch(
      /IPv6/,
    );
    expect(
      egressNetworkProblem({ ...made, IPAM: { Config: [] } }, subnet),
    ).toMatch(/address range/);
    expect(egressNetworkProblem({ ...made, IPAM: null }, subnet)).toMatch(
      /address range/,
    );
  });

  it("finds IPv6 addresses on interfaces other than loopback", () => {
    const lo = "00000000000000000000000000000001 01 80 10 80       lo";
    const eth0 = "fe800000000000001c2a3bfffe4d5e6f 02 40 20 80     eth0";
    expect(ipv6Interfaces("")).toEqual([]);
    expect(ipv6Interfaces(`${lo}\n`)).toEqual([]);
    expect(ipv6Interfaces(`${lo}\n${eth0}\n${eth0}\n`)).toEqual(["eth0"]);
  });

  it("names a call a socket proxy refuses, and keeps the daemon's own refusals as they are", async () => {
    // What tecnativa/docker-socket-proxy answers a call it does not allow.
    const proxyRefusal =
      "<html><body><h1>403 Forbidden</h1>\nRequest forbidden by administrative rules.\n</body></html>\n";
    const server = createHttpServer((request, response) => {
      const path = request.url ?? "";
      if (path === "/version") {
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ ApiVersion: "1.47" }));
      }
      if (path === "/_ping") return response.end("OK");
      if (path.endsWith("/networks/create")) {
        response.writeHead(403, { "Content-Type": "application/json" });
        return response.end(
          JSON.stringify({ message: "operation not permitted" }),
        );
      }
      if (path.includes("/exec/")) {
        response.writeHead(405, { "Content-Type": "text/plain" });
        return response.end("method not allowed");
      }
      response.writeHead(403, {
        "Content-Type": "text/html",
        Connection: "close",
      });
      response.end(proxyRefusal);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const proxied = new DockerEngine(
      parseDockerHost(`tcp://127.0.0.1:${port}`),
    );
    try {
      const refused = await proxied
        .json("POST", "/containers/create", { body: {} })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(DockerProxyRefusedError);
      expect(refused).toMatchObject({
        status: 403,
        method: "POST",
        path: "/containers/create",
      });
      expect((refused as Error).message).toBe(
        `tcp://127.0.0.1:${port} refused POST /containers/create (HTTP 403) without a Docker Engine error: a socket proxy in front of the daemon does not allow this call. ` +
          "The docker driver needs the Engine API's containers, exec, images, networks and volumes endpoints, with POST, PUT and DELETE (docs/development.md, Docker socket proxy).",
      );
      await expect(
        proxied.startExec("abc", () => {}, Buffer.alloc(0)),
      ).rejects.toThrow(
        "refused POST /exec/abc/start (HTTP 405) without a Docker Engine error",
      );
      // The daemon's own 403 is its message, not a proxy's refusal.
      const daemon = await proxied
        .json("POST", "/networks/create", { body: {} })
        .catch((error: unknown) => error);
      expect(daemon).toBeInstanceOf(DockerApiError);
      expect(daemon).not.toBeInstanceOf(DockerProxyRefusedError);
      expect((daemon as Error).message).toBe("operation not permitted");
    } finally {
      proxied.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("reports an unreachable daemon as unhealthy", async () => {
    const health = await new DockerSandboxDriver({
      host: "unix:///nonexistent.sock",
    }).probe();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/unreachable/);
  });
});

describe.skipIf(!health.ok)("docker driver against a live daemon", () => {
  beforeAll(async () => {
    const stale = await removeStaleRuns();
    if (stale.length > 0)
      console.warn(
        `[docker driver] removed what ${stale.length} earlier test runs left behind: ${stale.join(", ")}`,
      );
    await createDriver().ensureImage(image);
  }, 300_000);

  afterAll(async () => {
    const left = await removeRunResources();
    engine?.close();
    if (left.length > 0)
      throw new Error(`Test resources left behind: ${left.join(", ")}`);
  }, 60_000);

  describeSandboxConformance("docker", createDriver, {
    spec: strictSpec,
    timeoutMs: 60_000,
  });

  describe("docker specifics", () => {
    const driver = createDriver();
    const live: Sandbox[] = [];
    const uniqueKey = (label: string) =>
      `${label}-${Math.random().toString(36).slice(2)}`;

    afterEach(async () => {
      await Promise.all(
        live.splice(0).map((sandbox) => sandbox.release().catch(() => {})),
      );
    });

    const request = (
      overrides: Partial<SandboxSpecInput> = {},
      workspaceKey = uniqueKey("docker"),
      extra: Partial<AcquireRequest> = {},
    ): AcquireRequest => ({
      sessionId: "session-1",
      taskId: "task-1",
      spec: driver.validateSpec({
        driver: "docker",
        workspace: "ephemeral",
        ...strictSpec,
        ...overrides,
      }),
      workspaceKey,
      ...extra,
    });

    async function acquire(
      ...args: Parameters<typeof request>
    ): Promise<DockerSandbox> {
      const sandbox = await driver.acquire(request(...args));
      live.push(sandbox);
      return sandbox as DockerSandbox;
    }

    const size = async (sandbox: Sandbox, file: string) =>
      (await sandbox.fs.stat(file))?.size ?? 0;

    it("creates unprivileged, capability-free containers with only a named workspace volume", async () => {
      const sandbox = await acquire({ workspace: "task" }, uniqueKey("hard"), {
        secrets: { JJ_SECRET: "never-in-container-config" },
      });
      const container = await engine?.json<ContainerInspect>(
        "GET",
        `/containers/${sandbox.containerId}/json`,
      );
      if (!container) throw new Error("no engine");
      const host = container.HostConfig;
      expect(host.Privileged).toBe(false);
      expect(host.CapDrop).toEqual(["ALL"]);
      expect(host.CapAdd ?? []).toEqual([]);
      expect(host.SecurityOpt).toContain("no-new-privileges:true");
      expect(container.Config.User).toBe("1000:1000");
      expect(host.PidsLimit).toBe(256);
      expect(host.Memory).toBe(512 * MiB);
      expect(host.MemorySwap).toBe(512 * MiB);
      expect(host.NanoCpus).toBe(1e9);
      expect(host.NetworkMode).toBe("none");
      expect(host.Binds ?? []).toEqual([]);
      expect(host.Devices ?? []).toEqual([]);
      for (const mode of ["PidMode", "IpcMode", "UTSMode", "UsernsMode"])
        expect(host[mode]).not.toBe("host");
      expect(host.Mounts).toEqual([
        expect.objectContaining({ Type: "volume", Target: "/workspace" }),
      ]);
      expect(container.Mounts).toEqual([
        expect.objectContaining({
          Type: "volume",
          Name: sandbox.volumeName,
          Destination: "/workspace",
        }),
      ]);
      for (const mount of container.Mounts)
        expect(`${mount.Source} ${mount.Destination}`).not.toMatch(
          /docker\.sock/,
        );
      expect(JSON.stringify(container.Config.Env)).not.toContain(
        "never-in-container-config",
      );
      const volume = await engine?.json<{
        Driver: string;
        Options: Record<string, string> | null;
      }>("GET", `/volumes/${sandbox.volumeName}`);
      expect(volume?.Driver).toBe("local");
      expect(volume?.Options ?? {}).toEqual({});

      const inside = await sandbox.exec(
        "id -u; grep -E '^(CapEff|NoNewPrivs):' /proc/self/status; " +
          "for s in /var/run/docker.sock /run/docker.sock; do test -e $s && echo socket-present; done; " +
          'echo "secret=$JJ_SECRET"',
      );
      const lines = inside.stdout.split("\n");
      expect(lines[0]).toBe("1000");
      expect(inside.stdout).toMatch(/CapEff:\s+0{16}/);
      expect(inside.stdout).toMatch(/NoNewPrivs:\s+1/);
      expect(inside.stdout).not.toContain("socket-present");
      expect(inside.stdout).toContain("secret=never-in-container-config");
    });

    it("uses the default bridge for network mode open", async () => {
      const sandbox = await acquire({ network: { mode: "open" } });
      const container = await engine?.json<ContainerInspect>(
        "GET",
        `/containers/${sandbox.containerId}/json`,
      );
      expect(container?.HostConfig.NetworkMode).toBe("bridge");
    });

    it("has the kernel enforce the process and memory limits", async () => {
      const sandbox = await acquire({
        resources: { memoryMb: 256, processes: 24 },
      });
      const limits = await sandbox.exec(
        "cat /sys/fs/cgroup/pids.max /sys/fs/cgroup/pids/pids.max 2>/dev/null; " +
          "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null; true",
      );
      expect(limits.stdout.split("\n")).toEqual(
        expect.arrayContaining(["24", String(256 * MiB)]),
      );
      const forks = await sandbox.exec(
        "for i in $(seq 1 40); do sleep 3 & done; wait",
        { timeoutMs: 20_000 },
      );
      expect(forks.stderr).toMatch(/fork|Resource temporarily unavailable/i);
    });

    it("keeps task volumes and removes ephemeral ones on release", async () => {
      const task = await acquire({ workspace: "task" }, uniqueKey("keep"));
      const ephemeral = await acquire({ workspace: "ephemeral" });
      await Promise.all([task.release(), ephemeral.release()]);
      await expect(
        engine?.json("GET", `/volumes/${task.volumeName}`),
      ).resolves.toBeDefined();
      await expect(
        engine?.json("GET", `/volumes/${ephemeral.volumeName}`),
      ).rejects.toSatisfy(isNotFound);
      await expect(
        engine?.json("GET", `/containers/${task.containerId}/json`),
      ).rejects.toSatisfy(isNotFound);
    });

    it("refuses to mount a pre-existing volume that is not a plain workspace volume", async () => {
      const key = uniqueKey("disguised");
      await engine?.json("POST", "/volumes/create", {
        body: {
          Name: `${namespace}-task-${key}`,
          Driver: "local",
          DriverOpts: { type: "none", o: "bind", device: "/tmp" },
          Labels: {
            ...labels,
            "jj.sandbox.namespace": namespace,
            "jj.sandbox.workspace-mode": "task",
            "jj.sandbox.workspace-key": key,
          },
        },
      });
      await expect(
        driver.acquire(request({ workspace: "task" }, key)),
      ).rejects.toThrow(SandboxRequestError);
    });

    it("explains how to build a missing jj-sandbox image instead of pulling it", async () => {
      await expect(
        driver.acquire(request({ image: "jj-sandbox:base-0-missing" })),
      ).rejects.toThrow(/npm run sandbox:image/);
    });

    it("leaves a finished command's background processes alone when stopping another", async () => {
      const sandbox = await acquire();
      const started = await sandbox.exec(
        "nohup sh -c 'while :; do echo x >> keep; sleep 0.1; done' >/dev/null 2>&1 &",
      );
      expect(started.interrupted).toBe("no");
      const stopped = await sandbox.exec("sleep 30", { timeoutMs: 500 });
      expect(stopped.interrupted).toBe("yes");
      const before = await size(sandbox, "keep");
      await delay(500);
      expect(await size(sandbox, "keep")).toBeGreaterThan(before);
    });

    it('stops double-forked descendants that keep the marker and reports "yes"', async () => {
      const sandbox = await acquire();
      const result = await sandbox.exec(
        `( sh -c 'trap "" TERM; while :; do echo x >> daemon; sleep 0.1; done' >/dev/null 2>&1 & ); sleep 30`,
        { timeoutMs: 800 },
      );
      expect(result.interrupted).toBe("yes");
      const before = await size(sandbox, "daemon");
      expect(before).toBeGreaterThan(0);
      await delay(600);
      expect(await size(sandbox, "daemon")).toBe(before);
    });

    it('reports "unknown" when a descendant clears its environment and leaves the tree', async () => {
      const sandbox = await acquire();
      const result = await sandbox.exec(
        `( env -i /bin/sh -c 'trap "" TERM; while :; do echo x >> /workspace/hidden; sleep 0.1; done' >/dev/null 2>&1 & ); sleep 30`,
        { timeoutMs: 800 },
      );
      expect(result.interruptReason).toBe("timeout");
      expect(result.interrupted).toBe("unknown");
    });

    it("resolves a command running at release as interrupted by release", async () => {
      const sandbox = await acquire();
      const running = sandbox.exec("sleep 30");
      await delay(500);
      await sandbox.release();
      const result = await running;
      expect(result.interruptReason).toBe("release");
      expect(result.interrupted).toBe("yes");
    });

    it("does not let a command override its process marker", async () => {
      const sandbox = await acquire();
      const result = await sandbox.exec('echo "$JJ_SANDBOX_EXEC"', {
        env: { JJ_SANDBOX_EXEC: "spoofed" },
      });
      expect(result.stdout.trim()).toMatch(/^c\d+-[0-9a-f]+$/);
    });

    /** Process states in the container (`R`, `S`, `Z`…), one per process. */
    const processStates = async (sandbox: Sandbox) =>
      (
        await sandbox.exec(
          "for f in /proc/[0-9]*/stat; do sed 's/.*) //' \"$f\" 2>/dev/null | cut -c1; done",
        )
      ).stdout
        .split("\n")
        .filter(Boolean);

    it("runs a spawned process as the sandbox user and leaves neither a running exec nor a zombie once killed", async () => {
      const sandbox = await acquire();
      const spawned = (await sandbox.spawn?.(
        [
          "sh",
          "-c",
          'trap "" TERM; id -u; echo "$JJ_SANDBOX_EXEC"; while :; do sleep 0.1; done',
        ],
        { env: { JJ_SANDBOX_EXEC: "spoofed" } },
      )) as SandboxProcess & { execId: string };
      let output = "";
      const ready = new Promise<void>((done) =>
        spawned.onOutput((chunk) => {
          output += chunk.toString();
          if (output.split("\n").length > 2) done();
        }),
      );
      await ready;
      const [uid, marker] = output.split("\n");
      expect(uid).toBe("1000");
      // Its marker is the driver's, whatever the caller passes.
      expect(marker).toMatch(/^s\d+-[0-9a-f]+$/);
      expect((await engine?.inspectExec(spawned.execId))?.Running).toBe(true);
      const exit = await spawned.kill();
      expect(exit).toMatchObject({
        interrupted: "yes",
        interruptReason: "kill",
        exitCode: 137,
      });
      expect((await engine?.inspectExec(spawned.execId))?.Running).toBe(false);
      expect(await processStates(sandbox)).not.toContain("Z");
    });

    it("leaves other commands' and processes' background work alone when it kills a spawned process", async () => {
      const sandbox = await acquire();
      await sandbox.exec(
        "nohup sh -c 'while :; do echo x >> kept-exec; sleep 0.1; done' >/dev/null 2>&1 &",
      );
      const other = await sandbox.spawn?.([
        "sh",
        "-c",
        "while :; do echo x >> kept-spawn; sleep 0.1; done",
      ]);
      const target = await sandbox.spawn?.(["sleep", "30"]);
      await delay(400);
      expect((await target?.kill())?.interrupted).toBe("yes");
      const before = [
        await size(sandbox, "kept-exec"),
        await size(sandbox, "kept-spawn"),
      ];
      await delay(600);
      expect(await size(sandbox, "kept-exec")).toBeGreaterThan(before[0] ?? 0);
      expect(await size(sandbox, "kept-spawn")).toBeGreaterThan(before[1] ?? 0);
      expect(other).toBeDefined();
    });

    it("round-trips binary files and refuses to block on a FIFO", async () => {
      const sandbox = await acquire();
      const data = randomBytes(300_000);
      await sandbox.fs.write("blob.bin", data);
      expect((await sandbox.fs.read("blob.bin")).equals(data)).toBe(true);
      await sandbox.fs.write("empty.txt", "");
      expect((await sandbox.fs.read("empty.txt")).length).toBe(0);
      expect((await sandbox.exec("mkfifo pipe")).exitCode).toBe(0);
      await expect(sandbox.fs.read("pipe")).rejects.toMatchObject({
        code: "EINVAL",
      });
      await expect(sandbox.fs.read("missing.txt")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("refuses files and listings over the fs limits instead of buffering them", async () => {
      const limited = new DockerSandboxDriver({
        namespace,
        labels,
        maxFileBytes: 1000,
        maxListEntries: 20,
      });
      const sandbox = (await limited.acquire(request())) as DockerSandbox;
      live.push(sandbox);
      await sandbox.fs.write("fits.bin", Buffer.alloc(1000, 1));
      expect((await sandbox.fs.read("fits.bin")).length).toBe(1000);
      await sandbox.fs.write("over.bin", Buffer.alloc(1001, 1));
      await expect(sandbox.fs.read("over.bin")).rejects.toMatchObject({
        code: "EFBIG",
        message: expect.stringMatching(/1001 bytes.*maxFileBytes/),
      });
      const made = await sandbox.exec(
        "mkdir few many && (cd few && seq 1 20 | xargs touch) && (cd many && seq 1 21 | xargs touch)",
      );
      expect(made.exitCode).toBe(0);
      expect(await sandbox.fs.list("few")).toHaveLength(20);
      await expect(sandbox.fs.list("many")).rejects.toMatchObject({
        code: "E2BIG",
        message: expect.stringMatching(/more than 20 entries/),
      });
      await expect(
        sandbox.fs.list(".", { recursive: true }),
      ).rejects.toMatchObject({ code: "E2BIG" });
    });

    it("refuses an 80 MB file under the default 32 MiB read limit", async () => {
      const sandbox = await acquire();
      const made = await sandbox.exec("head -c 80000000 /dev/zero > huge.bin");
      expect(made.exitCode).toBe(0);
      await expect(sandbox.fs.read("huge.bin")).rejects.toMatchObject({
        code: "EFBIG",
        message: expect.stringMatching(/80000000 bytes.*33554432-byte/),
      });
    });

    it("drops a helper's connection once its output passes the cap", async () => {
      const sandbox = await acquire();
      await expect(
        engine?.run(
          sandbox.containerId,
          {
            Cmd: ["head", "-c", "5000000", "/dev/zero"],
            Env: [],
            User: "1000:1000",
          },
          undefined,
          1000,
        ),
      ).rejects.toBeInstanceOf(DockerOutputLimitError);
      expect((await sandbox.exec("echo still-usable")).stdout).toBe(
        "still-usable\n",
      );
    });

    it("reaps containers another driver instance left behind, keeping workspaces", async () => {
      const reapNamespace = `${namespace}-reap`;
      const crashed = new DockerSandboxDriver({
        namespace: reapNamespace,
        labels,
        instanceId: "crashed-worker",
      });
      const current = new DockerSandboxDriver({
        namespace: reapNamespace,
        labels,
        instanceId: "current-worker",
      });
      const neighbour = new DockerSandboxDriver({
        namespace: `${namespace}-other`,
        labels,
        instanceId: "crashed-worker",
      });
      const key = uniqueKey("reap");
      const orphan = (await crashed.acquire(
        request({ workspace: "task" }, key),
      )) as DockerSandbox;
      live.push(orphan);
      await orphan.fs.write("kept.txt", "survives");
      const mine = (await current.acquire(request())) as DockerSandbox;
      const other = (await neighbour.acquire(request())) as DockerSandbox;
      live.push(mine, other);

      expect(await current.reapOrphans()).toEqual({
        removed: [orphan.containerName],
      });
      await expect(
        engine?.json("GET", `/containers/${orphan.containerId}/json`),
      ).rejects.toSatisfy(isNotFound);
      for (const alive of [mine, other])
        expect((await alive.exec("true")).exitCode).toBe(0);
      await expect(
        engine?.json("GET", `/volumes/${orphan.volumeName}`),
      ).resolves.toBeDefined();
      const resumed = await current.acquire(
        request({ workspace: "task" }, key),
      );
      live.push(resumed);
      expect((await resumed.fs.read("kept.txt")).toString()).toBe("survives");
      expect(await current.reapOrphans()).toEqual({ removed: [] });

      // Drivers in one process share an instance id, so they never reap each other.
      const sameNamespace = `${namespace}-same`;
      const first = new DockerSandboxDriver({
        namespace: sameNamespace,
        labels,
      });
      live.push(await first.acquire(request()));
      const second = new DockerSandboxDriver({
        namespace: sameNamespace,
        labels,
      });
      expect(second.instanceId).toBe(first.instanceId);
      expect(await second.reapOrphans()).toEqual({ removed: [] });
    });

    it("ships the tools the base image promises", async (context) => {
      // Only the real build is checked: an image merely tagged
      // jj-sandbox:base-1 locally, or the node fallback, lacks the tools. CI
      // builds it and sets JJ_SANDBOX_TEST_IMAGE, so this runs there.
      if (requestedImage !== DOCKER_BASE_IMAGE)
        return context.skip(
          `checks the real ${DOCKER_BASE_IMAGE}: run npm run sandbox:image and set JJ_SANDBOX_TEST_IMAGE=${DOCKER_BASE_IMAGE}`,
        );
      const sandbox = await acquire();
      const result = await sandbox.exec(
        "id -un; stat -c %U /workspace; git --version; python3 --version; rg --version; curl --version; node --version",
      );
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.split("\n");
      expect(lines.slice(0, 2)).toEqual(["sandbox", "sandbox"]);
      for (const pattern of [
        /git version/,
        /Python 3/,
        /ripgrep/,
        /curl/,
        /v22\./,
      ])
        expect(result.stdout).toMatch(pattern);
    });

    it("reaches the daemon through a tcp:// DOCKER_HOST, such as a socket proxy", async (context) => {
      const endpoint = engine?.endpoint;
      if (endpoint?.kind !== "unix")
        return context.skip("needs a unix-socket daemon to proxy");
      // A transparent TCP-to-socket relay standing in for a filtering proxy.
      const sockets = new Set<{ destroy(): void }>();
      const server = createServer({ allowHalfOpen: true }, (client) => {
        const upstream = createConnection({
          path: endpoint.socketPath,
          allowHalfOpen: true,
        });
        sockets.add(client).add(upstream);
        client.pipe(upstream).pipe(client);
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      try {
        const proxied = new DockerSandboxDriver({
          host: `tcp://127.0.0.1:${port}`,
          namespace,
          labels,
          killGraceMs: 300,
        });
        expect((await proxied.probe()).ok).toBe(true);
        const sandbox = await proxied.acquire(request());
        live.push(sandbox);
        await sandbox.fs.write("via-proxy.txt", "proxied");
        const result = await sandbox.exec("cat via-proxy.txt");
        expect(result.stdout).toBe("proxied");
        await sandbox.release();
      } finally {
        server.close();
        for (const socket of sockets) socket.destroy();
      }
    });

    // Each allowlist sandbox is a network and two containers, which a daemon
    // other suites share creates slowly: the conformance suite's budget, not
    // the 20 s default meant for PGlite suites.
    describe("network mode allowlist", { timeout: 60_000 }, () => {
      const allowlist = (...hosts: string[]): Partial<SandboxSpecInput> => ({
        network: { mode: "allowlist", hosts },
      });
      const inspect = (name: string) =>
        engine?.json<ContainerInspect>(
          "GET",
          `/containers/${encodeURIComponent(name)}/json`,
        ) as Promise<ContainerInspect>;
      const gone = async (kind: "containers" | "networks", name?: string) => {
        if (!name) throw new Error(`no ${kind} name`);
        await expect(
          engine?.json(
            "GET",
            `/${kind}/${encodeURIComponent(name)}${kind === "containers" ? "/json" : ""}`,
          ),
        ).rejects.toSatisfy(isNotFound);
      };
      const probe = async (sandbox: Sandbox, probes: NetworkProbe[]) => {
        const results = await probeNetwork(sandbox, probes);
        if (!results) throw new Error(`${image} has no node to probe with`);
        return results;
      };

      it("puts the sandbox alone on an internal network beside a hardened egress proxy", async () => {
        const sandbox = await acquire(
          allowlist("example.com", "*.npmjs.org"),
          uniqueKey("allow"),
          { secrets: { JJ_SECRET: "never-in-container-config" } },
        );
        const { networkName, proxyContainerName } = sandbox;
        if (!networkName || !proxyContainerName)
          throw new Error("no egress resources");

        const network = await engine?.json<{
          Internal: boolean;
          EnableIPv6: boolean;
          Options: Record<string, string>;
          Labels: Record<string, string>;
          IPAM: { Config: Array<{ Subnet: string; Gateway?: string }> };
        }>("GET", `/networks/${networkName}`);
        expect(network).toMatchObject({
          Internal: true,
          EnableIPv6: false,
          Options: { "com.docker.network.bridge.inhibit_ipv4": "true" },
          Labels: {
            "jj.sandbox.namespace": namespace,
            "jj.sandbox.role": "egress-network",
          },
        });
        // A /28 of the driver's own pool, with no gateway: the host's side
        // of the bridge has no address.
        expect(network?.IPAM.Config).toEqual([
          { Subnet: expect.stringMatching(/^10\.213\.\d+\.\d+\/28$/) },
        ]);

        const proxy = await inspect(proxyContainerName);
        const host = proxy.HostConfig;
        expect(host.Privileged).toBe(false);
        expect(host.CapDrop).toEqual(["ALL"]);
        expect(host.CapAdd ?? []).toEqual([]);
        expect(host.SecurityOpt).toContain("no-new-privileges:true");
        expect(proxy.Config.User).toBe("1000:1000");
        expect(host.ReadonlyRootfs).toBe(true);
        expect(host.PidsLimit).toBe(64);
        expect(host.Memory).toBe(256 * MiB);
        expect(host.MemorySwap).toBe(256 * MiB);
        expect(host.Binds ?? []).toEqual([]);
        expect(host.Mounts ?? []).toEqual([]);
        expect(proxy.Mounts).toEqual([]);
        expect(host.LogConfig).toMatchObject({ Type: "none" });
        expect(
          Object.keys(proxy.NetworkSettings.Networks ?? {}).sort(),
        ).toEqual(["bridge", networkName].sort());
        // On two networks, it never routes between them.
        expect(host.Sysctls).toEqual({ "net.ipv4.ip_forward": "0" });
        const forwarding = await engine?.run(proxyContainerName, {
          Cmd: ["cat", "/proc/sys/net/ipv4/ip_forward"],
          Env: [],
          User: "1000:1000",
        });
        expect(forwarding?.stdout.toString().trim()).toBe("0");
        // Its own configuration is all it gets, besides the image's environment.
        const imageEnv = new Set(
          (
            await engine?.json<{ Config: { Env: string[] | null } }>(
              "GET",
              `/images/${proxy.Config.Image}/json`,
            )
          )?.Config.Env ?? [],
        );
        const added = (proxy.Config.Env ?? []).filter(
          (entry) => !imageEnv.has(entry),
        );
        expect(added).toHaveLength(1);
        expect(
          JSON.parse(added[0]?.replace(/^JJ_EGRESS_CONFIG=/, "") ?? ""),
        ).toMatchObject({ hosts: ["example.com", "*.npmjs.org"], port: 3128 });

        const container = await inspect(sandbox.containerId);
        expect(container.HostConfig.NetworkMode).toBe(networkName);
        expect(Object.keys(container.NetworkSettings.Networks ?? {})).toEqual([
          networkName,
        ]);
        // Its embedded resolver's upstream is resolved from its own network
        // namespace, which has no route to it: no name leaves the sandbox,
        // even on engines that forward for internal networks (CVE-2024-29018).
        expect(container.HostConfig.Dns).toEqual(["198.51.100.53"]);
        const dns = await sandbox.exec(
          "getent hosts example.com || echo no-name; grep -c '^nameserver 127.0.0.11$' /etc/resolv.conf",
        );
        expect(dns.stdout.split("\n").slice(0, 2)).toEqual(["no-name", "1"]);
        const proxyAddress =
          proxy.NetworkSettings.Networks?.[networkName]?.IPAddress;
        const url = `http://${proxyAddress}:3128`;
        expect(container.Config.Env).toEqual(
          expect.arrayContaining([
            `HTTP_PROXY=${url}`,
            `HTTPS_PROXY=${url}`,
            `http_proxy=${url}`,
            `https_proxy=${url}`,
            "NO_PROXY=localhost,127.0.0.1",
            "NODE_USE_ENV_PROXY=1",
          ]),
        );
        expect(JSON.stringify(container.Config.Env)).not.toContain(
          "never-in-container-config",
        );

        // No default route, and no IPv6 address but loopback's (none
        // reaches the host's bridge over link-local).
        const inside = await sandbox.exec(
          'echo "secret=$JJ_SECRET proxy=$HTTPS_PROXY"; cat /proc/net/route; echo ---; cat /proc/net/if_inet6 2>/dev/null; true',
        );
        expect(inside.stdout).toContain(
          `secret=never-in-container-config proxy=${url}`,
        );
        // A spawned process gets the same: the proxy, and the secret per exec.
        const spawned = await sandbox.spawn?.([
          "sh",
          "-c",
          'echo "secret=$JJ_SECRET proxy=$HTTPS_PROXY"',
        ]);
        let spawnedOut = "";
        spawned?.onOutput((chunk) => {
          spawnedOut += chunk.toString();
        });
        expect((await spawned?.exited)?.exitCode).toBe(0);
        expect(spawnedOut.trim()).toBe(
          `secret=never-in-container-config proxy=${url}`,
        );
        expect(
          JSON.stringify((await inspect(sandbox.containerId)).Config.Env),
        ).not.toContain("never-in-container-config");
        const [routes = "", inet6 = ""] = inside.stdout.split("---");
        expect(routes).not.toMatch(/^\S+\s+00000000\s/m);
        for (const line of inet6.trim().split("\n").filter(Boolean))
          expect(line).toMatch(/\slo$/);
      });

      it("refuses unlisted hosts and ports with a reason an agent can read", async () => {
        const sandbox = await acquire(allowlist("example.com"));
        const [https, http, port] = await probe(sandbox, [
          { kind: "http", url: "https://example.org/" },
          { kind: "http", url: "http://example.org/x" },
          { kind: "http", url: "https://example.com:8443/" },
        ]);
        const unlisted =
          "JJ Bot egress: example.org is not in this runtime profile's network allowlist";
        expect(https).toMatchObject({
          outcome: "refused",
          status: 403,
          reason: unlisted,
          body: `${unlisted}\n`,
        });
        expect(http).toMatchObject({
          outcome: "response",
          status: 403,
          reason: unlisted,
          body: `${unlisted}\n`,
        });
        expect(port).toMatchObject({
          outcome: "refused",
          status: 403,
          reason:
            "JJ Bot egress: port 8443 of example.com is not in this runtime profile's network allowlist",
        });
        // A real client, where the image has one (the base image does).
        const curl = await sandbox.exec(
          "command -v curl >/dev/null || exit 99; curl -sS -o /dev/null -w '%{http_connect}' https://example.org/",
        );
        if (curl.exitCode !== 99) {
          expect(curl.stdout).toBe("403");
          expect(curl.exitCode).not.toBe(0);
        }
      });

      it("keeps other containers and the Docker host unreachable, directly and through the proxy, even when listed", async () => {
        if (!engine) throw new Error("no engine");
        // Stand-ins for the app and PostgreSQL: one on the default bridge,
        // one on a user-defined network like the compose project's.
        const victimNetwork = `${namespace}-victims`;
        await engine.json("POST", "/networks/create", {
          body: { Name: victimNetwork, Driver: "bridge", Labels: labels },
        });
        const server = `require("http").createServer((q,s)=>{require("fs").appendFileSync("/tmp/hits","x\\n");s.end("victim-reached\\n")}).listen(8080)`;
        const victims: Array<{ name: string; network: string }> = [
          { name: `${namespace}-victim-bridge`, network: "bridge" },
          { name: `${namespace}-victim-compose`, network: victimNetwork },
        ];
        try {
          await Promise.all(
            victims.map(async (victim) => {
              await engine.json("POST", "/containers/create", {
                query: { name: victim.name },
                body: {
                  Image: image,
                  Entrypoint: ["node", "-e", server],
                  Cmd: [],
                  User: "1000:1000",
                  Labels: labels,
                  HostConfig: { NetworkMode: victim.network },
                  NetworkingConfig: {
                    EndpointsConfig: {
                      [victim.network]:
                        victim.network === "bridge"
                          ? {}
                          : { Aliases: ["postgres", "app"] },
                    },
                  },
                },
              });
              await engine.json("POST", `/containers/${victim.name}/start`);
            }),
          );
          const details = await Promise.all(
            victims.map((v) => inspect(v.name)),
          );
          const addresses = details.map(
            (detail, index) =>
              detail.NetworkSettings.Networks?.[victims[index]?.network ?? ""]
                ?.IPAddress ?? "",
          );
          const gateways = (
            await Promise.all(
              ["bridge", victimNetwork].map((name) =>
                engine?.json<{ IPAM: { Config: Array<{ Gateway?: string }> } }>(
                  "GET",
                  `/networks/${name}`,
                ),
              ),
            )
          ).flatMap((network) =>
            (network?.IPAM.Config ?? []).flatMap((config) =>
              config.Gateway ? [config.Gateway] : [],
            ),
          );
          expect(addresses.every(Boolean)).toBe(true);
          expect(gateways.length).toBeGreaterThan(0);
          const hits = async () =>
            Promise.all(
              victims.map(async (victim) => {
                const result = await engine?.run(victim.name, {
                  Cmd: ["sh", "-c", "cat /tmp/hits 2>/dev/null | wc -l"],
                  Env: [],
                  User: "1000:1000",
                });
                return Number(result?.stdout.toString().trim());
              }),
            );

          // Controls: both victims answer the Docker host, and an open
          // sandbox on the default bridge reaches the first, so the probes
          // below would notice a way through.
          for (const address of addresses) {
            let answer = "";
            for (let attempt = 0; attempt < 40 && !answer; attempt++) {
              answer = await exchangeHttp(address, 8080).catch(() => "");
              if (!answer) await delay(250);
            }
            expect(answer, address).toContain("victim-reached");
          }
          expect(await hits()).toEqual([1, 1]);
          const open = await acquire({ network: { mode: "open" } });
          let control: ProbeResult | undefined;
          for (let attempt = 0; attempt < 40; attempt++) {
            [control] = await probe(open, [
              { kind: "tcp", host: addresses[0] ?? "", port: 8080 },
            ]);
            if (control?.outcome === "connected") break;
            await delay(250);
          }
          expect(control?.outcome).toBe("connected");
          await open.release();

          const targets = [
            ...addresses,
            ...gateways,
            ...victims.map((victim) => victim.name),
            "postgres",
            "app",
            "host.docker.internal",
          ];
          const sandbox = await acquire(
            allowlist(
              "example.com",
              ...addresses,
              ...targets.map((target) => `${target}:8080`),
            ),
          );
          const before = await hits();
          const probes: NetworkProbe[] = [
            ...[...addresses, ...gateways].map(
              (host): NetworkProbe => ({ kind: "tcp", host, port: 8080 }),
            ),
            ...targets.flatMap((target): NetworkProbe[] => [
              { kind: "http", url: `http://${target}:8080/` },
              { kind: "http", url: `https://${target}:8080/` },
            ]),
            ...addresses.map(
              (address): NetworkProbe => ({
                kind: "http",
                url: `http://${address}/`,
              }),
            ),
          ];
          const results = await probe(sandbox, probes);
          for (const [index, result] of results.entries()) {
            const label = `${JSON.stringify(probes[index])} ${JSON.stringify(result)}`;
            expect(reached(result), label).toBe(false);
            expect(JSON.stringify(result), label).not.toContain(
              "victim-reached",
            );
            const target = probes[index];
            if (target?.kind === "http" && /\/\/\d/.test(target.url))
              expect(result?.reason, label).toMatch(
                /is a private address; only public destinations are reachable$/,
              );
          }
          expect(await hits()).toEqual(before);
        } finally {
          await Promise.all(
            victims.map((victim) =>
              engine
                ?.json("DELETE", `/containers/${victim.name}`, {
                  query: { force: true },
                })
                .catch(() => {}),
            ),
          );
          await engine
            .json("DELETE", `/networks/${victimNetwork}`)
            .catch(() => {});
        }
      });

      it("removes the proxy and the network on release, and after an acquire that fails midway", async () => {
        const sandbox = await acquire(allowlist("example.com"));
        await sandbox.release();
        await gone("containers", sandbox.containerName);
        await gone("containers", sandbox.proxyContainerName);
        await gone("networks", sandbox.networkName);
        await expect(sandbox.release()).resolves.toBeUndefined();

        // Abort as soon as the proxy exists: the acquire must undo all of it.
        const taskId = `abort-${Math.random().toString(36).slice(2)}`;
        const controller = new AbortController();
        const filters = JSON.stringify({
          label: [`jj.sandbox.task=${taskId}`],
        });
        const owned = async () => ({
          containers:
            (await engine?.json<unknown[]>("GET", "/containers/json", {
              query: { all: true, filters },
            })) ?? [],
          networks:
            (await engine?.json<unknown[]>("GET", "/networks", {
              query: { filters },
            })) ?? [],
        });
        const attempt = driver.acquire(
          request(allowlist("example.com"), uniqueKey("abort"), {
            taskId,
            signal: controller.signal,
          }),
        );
        attempt.then((late) => late.release()).catch(() => {});
        for (let poll = 0; poll < 500; poll++) {
          if ((await owned()).containers.length > 0) break;
          await delay(10);
        }
        controller.abort();
        await expect(attempt).rejects.toThrow();
        expect(await owned()).toEqual({ containers: [], networks: [] });
      });

      it("reaps the proxies and networks another driver instance left behind", async () => {
        const reapNamespace = `${namespace}-reapnet`;
        const options = {
          namespace: reapNamespace,
          labels,
          egressProxyImage: image,
        };
        const crashed = new DockerSandboxDriver({
          ...options,
          instanceId: "crashed-worker",
        });
        const current = new DockerSandboxDriver({
          ...options,
          instanceId: "current-worker",
        });
        // Independent, so acquired together: each is two containers and a
        // network, which a daemon other suites share is slow to make.
        const made = await Promise.allSettled([
          crashed.acquire(request(allowlist("example.com"))),
          current.acquire(request(allowlist("example.com"))),
        ]);
        // Released after the test even when the other acquire failed.
        for (const result of made)
          if (result.status === "fulfilled") live.push(result.value);
        const [orphan, mine] = made.map((result) => {
          if (result.status === "rejected") throw result.reason;
          return result.value as DockerSandbox;
        });
        if (!orphan || !mine) throw new Error("no sandboxes");

        const { removed } = await current.reapOrphans();
        expect([...removed].sort()).toEqual(
          [
            orphan.containerName,
            orphan.proxyContainerName,
            orphan.networkName,
          ].sort(),
        );
        await gone("containers", orphan.containerName);
        await gone("containers", orphan.proxyContainerName);
        await gone("networks", orphan.networkName);
        expect((await mine.exec("true")).exitCode).toBe(0);
        await expect(
          inspect(mine.proxyContainerName ?? ""),
        ).resolves.toBeDefined();
        await expect(
          engine?.json("GET", `/networks/${mine.networkName}`),
        ).resolves.toBeDefined();
        expect(await current.reapOrphans()).toEqual({ removed: [] });
      });

      /** The containers and networks carrying a task's label. */
      const ownedBy = async (taskId: string) => {
        const filters = JSON.stringify({
          label: [`jj.sandbox.task=${taskId}`],
        });
        return {
          containers:
            (await engine?.json<unknown[]>("GET", "/containers/json", {
              query: { all: true, filters },
            })) ?? [],
          networks:
            (await engine?.json<unknown[]>("GET", "/networks", {
              query: { filters },
            })) ?? [],
        };
      };
      const subnetOf = async (sandbox: DockerSandbox) =>
        (
          await engine?.json<{ IPAM: { Config: Array<{ Subnet: string }> } }>(
            "GET",
            `/networks/${sandbox.networkName}`,
          )
        )?.IPAM.Config[0]?.Subnet;

      it("takes networks from its own pool, so many never exhaust Docker's default pools", async () => {
        // Docker's default pools hold about 30 networks; well past that.
        const count = 40;
        const sandboxes: DockerSandbox[] = [];
        for (let batch = 0; batch < count; batch += 8)
          sandboxes.push(
            ...(await Promise.all(
              Array.from({ length: Math.min(8, count - batch) }, () =>
                acquire(allowlist("example.com")),
              ),
            )),
          );
        const subnets = await Promise.all(sandboxes.map(subnetOf));
        expect(new Set(subnets).size).toBe(count);
        for (const subnet of subnets)
          expect(subnet).toMatch(/^10\.213\.\d+\.\d+\/28$/);
        // Docker's own pools are untouched: a network that takes from them
        // (compose's, say) can still be made.
        const fromDefaults = `${namespace}-default-pool`;
        await engine?.json("POST", "/networks/create", {
          body: { Name: fromDefaults, Labels: labels },
        });
        await engine?.json("DELETE", `/networks/${fromDefaults}`);
        await Promise.all(sandboxes.map((sandbox) => sandbox.release()));
        for (const sandbox of sandboxes)
          await gone("networks", sandbox.networkName);
      }, 300_000);

      /**
       * Creates `name` on the first /28 of a /27 in 10.214.0.0/16 that no
       * network on the daemon overlaps; returns the /27 and its free /28.
       * Another checkout's suite can share the daemon, or a killed run leave
       * its networks behind, so no fixed range is safe to take.
       */
      const blockFirstHalf = async (name: string) => {
        const ipv4 = (n: number) =>
          [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join(".");
        const range = (cidr: string): [number, number] | undefined => {
          const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
          if (!match) return undefined;
          const [a, b, c, d, bits] = match.slice(1).map(Number) as number[];
          const start =
            (((a ?? 0) << 24) |
              ((b ?? 0) << 16) |
              ((c ?? 0) << 8) |
              (d ?? 0)) >>>
            0;
          return [start, start + 2 ** (32 - (bits ?? 32)) - 1];
        };
        for (let attempt = 0; attempt < 20; attempt++) {
          const networks =
            (await engine?.json<
              Array<{
                IPAM?: { Config?: Array<{ Subnet?: string }> | null } | null;
              }>
            >("GET", "/networks")) ?? [];
          const taken = networks
            .flatMap((network) => network.IPAM?.Config ?? [])
            .flatMap((config) => {
              const held = config.Subnet ? range(config.Subnet) : undefined;
              return held ? [held] : [];
            });
          const base =
            (((10 << 24) | (214 << 16)) >>> 0) + randomInt(2048) * 32;
          if (taken.some(([start, end]) => start <= base + 31 && base <= end))
            continue;
          try {
            await engine?.json("POST", "/networks/create", {
              body: {
                Name: name,
                Internal: true,
                IPAM: { Config: [{ Subnet: `${ipv4(base)}/28` }] },
                Labels: labels,
              },
            });
          } catch (error) {
            // Taken between the listing and the create: pick another.
            if (
              error instanceof DockerApiError &&
              /overlap/i.test(error.message)
            )
              continue;
            throw error;
          }
          return { pool: `${ipv4(base)}/27`, free: `${ipv4(base + 16)}/28` };
        }
        throw new Error("No /27 in 10.214.0.0/16 is free on this daemon");
      };

      // Three allowlist sandboxes in a row, while other suites on the daemon
      // may be in the pool test above: twice this block's budget.
      it("skips subnets other networks hold, and says so when its pool is full", async () => {
        // Two /28s; another network already holds the first.
        const blocker = `${namespace}-blocker`;
        try {
          const { pool, free } = await blockFirstHalf(blocker);
          const small = new DockerSandboxDriver({
            namespace,
            labels,
            egressProxyImage: image,
            egressSubnetPool: pool,
          });
          const first = (await small.acquire(
            request(allowlist("example.com")),
          )) as DockerSandbox;
          live.push(first);
          expect(await subnetOf(first)).toBe(free);
          const taskId = `full-${Math.random().toString(36).slice(2)}`;
          await expect(
            small.acquire(
              request(allowlist("example.com"), uniqueKey("full"), { taskId }),
            ),
          ).rejects.toThrow(
            `No free /28 left in the egress subnet pool ${pool}`,
          );
          expect(await ownedBy(taskId)).toEqual({
            containers: [],
            networks: [],
          });
          // Released, its subnet is free again.
          await first.release();
          const again = (await small.acquire(
            request(allowlist("example.com")),
          )) as DockerSandbox;
          live.push(again);
          expect(await subnetOf(again)).toBe(free);
        } finally {
          await Promise.all(
            live.splice(0).map((sandbox) => sandbox.release().catch(() => {})),
          );
          await engine?.json("DELETE", `/networks/${blocker}`).catch(() => {});
        }
      }, 120_000);

      it("refuses, and removes, a sandbox that has IPv6 addresses", async (context) => {
        // Engines with CVE-2024-32473 leave IPv6 link-local addresses on
        // IPv4-only interfaces. Here the sandbox gets them from a second,
        // IPv6 network joined right after it starts, before the driver checks.
        if (!existsSync("/proc/net/if_inet6")) {
          if (process.env.CI)
            throw new Error("CI runners have IPv6; this check must run there");
          return context.skip(
            "this machine's kernel has no IPv6, so no sandbox can have an IPv6 address",
          );
        }
        if (!engine) throw new Error("no engine");
        const v6 = `${namespace}-v6`;
        await engine.json("POST", "/networks/create", {
          body: {
            Name: v6,
            Internal: true,
            EnableIPv6: true,
            IPAM: {
              Config: [
                { Subnet: "10.215.0.0/28" },
                { Subnet: "fd6a:6a00:6a00::/64" },
              ],
            },
            Labels: labels,
          },
        });
        const leaky = new DockerSandboxDriver({
          namespace,
          labels,
          egressProxyImage: image,
        });
        const leakyEngine = (leaky as unknown as { engine: DockerEngine })
          .engine;
        const json = leakyEngine.json.bind(leakyEngine);
        leakyEngine.json = (async (
          method: string,
          path: string,
          init?: Parameters<DockerEngine["json"]>[2],
        ) => {
          const result = await json(method, path, init);
          const started = /^\/containers\/([0-9a-f]{64})\/start$/.exec(path);
          if (method === "POST" && started)
            await json("POST", `/networks/${v6}/connect`, {
              body: { Container: started[1] },
            });
          return result;
        }) as DockerEngine["json"];
        const taskId = `ipv6-${Math.random().toString(36).slice(2)}`;
        try {
          await expect(
            leaky.acquire(
              request(allowlist("example.com"), uniqueKey("ipv6"), { taskId }),
            ),
          ).rejects.toThrow(/IPv6 addresses on (eth0, )?eth1 .*CVE-2024-32473/);
          expect(await ownedBy(taskId)).toEqual({
            containers: [],
            networks: [],
          });
        } finally {
          await engine.json("DELETE", `/networks/${v6}`).catch(() => {});
        }
      });

      it("waits for the engine to record a proxy's exit before saying it did not start listening", async () => {
        // The engine reads a container as running until it has handled its
        // exit, a moment after the process ended, and a dying proxy fails the
        // start-up check within that moment. Here the proxy is killed as the
        // check starts, and the first read after the check is a stale one.
        const lagging = new DockerSandboxDriver({
          namespace,
          labels,
          egressProxyImage: image,
        });
        const lagEngine = (lagging as unknown as { engine: DockerEngine })
          .engine;
        const json = lagEngine.json.bind(lagEngine);
        const run = lagEngine.run.bind(lagEngine);
        const isProxy = (name: string) => /-egress-[0-9a-f-]{36}$/.test(name);
        let lastRunning: unknown;
        let stale = false;
        lagEngine.json = (async (
          method: string,
          path: string,
          init?: Parameters<DockerEngine["json"]>[2],
        ) => {
          const read = /^\/containers\/([^/]+)\/json$/.exec(path)?.[1];
          const proxyRead = method === "GET" && read && isProxy(read);
          if (proxyRead && stale) {
            stale = false;
            return lastRunning;
          }
          const result = await json(method, path, init);
          if (
            proxyRead &&
            (result as { State?: { Running?: boolean } }).State?.Running
          )
            lastRunning = result;
          return result;
        }) as DockerEngine["json"];
        lagEngine.run = async (...args: Parameters<DockerEngine["run"]>) => {
          const [container] = args;
          if (isProxy(container) && lastRunning) {
            await json("POST", `/containers/${container}/kill`);
            await json("POST", `/containers/${container}/wait`);
            stale = true;
          }
          return run(...args);
        };
        const taskId = `lagging-${Math.random().toString(36).slice(2)}`;
        await expect(
          lagging.acquire(
            request(allowlist("example.com"), uniqueKey("lagging"), {
              taskId,
            }),
          ),
        ).rejects.toThrow(/exited as it started \(exit code 137\)/);
        expect(stale).toBe(false);
        expect(await ownedBy(taskId)).toEqual({
          containers: [],
          networks: [],
        });
      });

      it("cleans up a failed sandbox at once while its proxy's check still waits for it to listen", async () => {
        // A proxy that runs but never listens holds its check for 15 s, then
        // 5 s more while the engine may record an exit. Here the sandbox's
        // start fails meanwhile: the acquire must not wait for the check.
        const stuck = new DockerSandboxDriver({
          namespace,
          labels,
          egressProxyImage: image,
        });
        const stuckEngine = (stuck as unknown as { engine: DockerEngine })
          .engine;
        const json = stuckEngine.json.bind(stuckEngine);
        let failedAt = Number.NaN;
        stuckEngine.json = (async (
          method: string,
          path: string,
          init?: Parameters<DockerEngine["json"]>[2],
        ) => {
          const name = String(init?.query?.name ?? "");
          if (path === "/containers/create" && /-egress-/.test(name))
            return json(method, path, {
              ...init,
              body: {
                ...(init?.body as object),
                Entrypoint: ["sleep", "3600"],
              },
            });
          const result = await json(method, path, init);
          if (
            method === "POST" &&
            /^\/containers\/[0-9a-f]{64}\/start$/.test(path)
          ) {
            failedAt = Date.now();
            throw new Error("injected sandbox start failure");
          }
          return result;
        }) as DockerEngine["json"];
        const taskId = `stuck-${Math.random().toString(36).slice(2)}`;
        await expect(
          stuck.acquire(
            request(allowlist("example.com"), uniqueKey("stuck"), { taskId }),
          ),
        ).rejects.toThrow("injected sandbox start failure");
        // The removals alone: far less than what is left of the check's wait.
        expect(Date.now() - failedAt).toBeLessThan(10_000);
        expect(await ownedBy(taskId)).toEqual({
          containers: [],
          networks: [],
        });
      });

      it("explains that the egress proxy's image needs node, and leaves nothing behind", async () => {
        if (!engine) throw new Error("no engine");
        // An image with nothing in it: an empty archive, imported.
        const empty = `jj-test-empty:${runId}`;
        await engine.json("POST", "/images/create", {
          query: { fromSrc: "-", repo: "jj-test-empty", tag: runId },
          body: Buffer.alloc(1024),
          contentType: "application/x-tar",
        });
        try {
          const nodeless = new DockerSandboxDriver({
            namespace,
            labels,
            egressProxyImage: empty,
          });
          const taskId = `nodeless-${Math.random().toString(36).slice(2)}`;
          await expect(
            nodeless.acquire(
              request(allowlist("example.com"), uniqueKey("nodeless"), {
                taskId,
              }),
            ),
          ).rejects.toThrow(
            new RegExp(
              `(exited as it started|could not start) .*its image ${empty} needs node 22 or later`,
            ),
          );
          expect(await ownedBy(taskId)).toEqual({
            containers: [],
            networks: [],
          });
        } finally {
          await engine
            .json("DELETE", `/images/${empty}`, { query: { force: true } })
            .catch(() => {});
        }
      });
    });
  });
});
