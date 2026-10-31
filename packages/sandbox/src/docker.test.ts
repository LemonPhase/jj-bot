import { randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { describeSandboxConformance } from "./conformance";
import {
  type AcquireRequest,
  type Sandbox,
  SandboxCapabilityError,
  SandboxRequestError,
  type SandboxSpecInput,
} from "./contract";
import { DOCKER_BASE_IMAGE, DockerSandboxDriver } from "./drivers/docker";
import {
  DockerEngine,
  DockerOutputLimitError,
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
 * Every container and volume carries a per-run label and is removed after
 * the run.
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
  new DockerSandboxDriver({ namespace, labels, killGraceMs: 300 });

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

type DockerSandbox = Sandbox & {
  containerId: string;
  containerName: string;
  volumeName: string;
};

interface ContainerInspect {
  Config: { User: string; Env: string[] | null };
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

async function removeRunResources(): Promise<string[]> {
  if (!engine) return [];
  const filters = JSON.stringify({ label: [`${RUN_LABEL}=${runId}`] });
  const list = async () => {
    const containers = await engine.json<Array<{ Id: string }>>(
      "GET",
      "/containers/json",
      { query: { all: true, filters } },
    );
    const { Volumes } = await engine.json<{
      Volumes: Array<{ Name: string }> | null;
    }>("GET", "/volumes", { query: { filters } });
    return { containers, volumes: Volumes ?? [] };
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
  await Promise.all(
    found.volumes.map((volume) =>
      engine.json("DELETE", `/volumes/${volume.Name}`).catch(() => {}),
    ),
  );
  const left = await list();
  return [
    ...left.containers.map((container) => `container ${container.Id}`),
    ...left.volumes.map((volume) => `volume ${volume.Name}`),
  ];
}

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
    expect(() =>
      spec({ network: { mode: "allowlist", hosts: ["example.com"] } }),
    ).toThrow(SandboxCapabilityError);
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

  it("reports an unreachable daemon as unhealthy", async () => {
    const health = await new DockerSandboxDriver({
      host: "unix:///nonexistent.sock",
    }).probe();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/unreachable/);
  });
});

describe.skipIf(!health.ok)("docker driver against a live daemon", () => {
  beforeAll(() => createDriver().ensureImage(image), 300_000);

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

    it.runIf(image === DOCKER_BASE_IMAGE)(
      "ships the tools the base image promises",
      async () => {
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
      },
    );

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
  });
});
