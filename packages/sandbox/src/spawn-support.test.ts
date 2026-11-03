import { describe, expect, it } from "vitest";
import { type OutputStream, SPAWN_HOLD_BYTES } from "./contract";
import { OutputRelay } from "./drivers/spawn-support";

/** The relay behind both drivers' `SandboxProcess.onOutput`, against a fake source. */
function relay() {
  const source = { paused: false, pauses: 0 };
  const output = new OutputRelay({
    pause: () => {
      source.paused = true;
      source.pauses++;
    },
    resume: () => {
      source.paused = false;
    },
  });
  return { source, output };
}

const received = () => {
  const chunks: Array<[string, OutputStream]> = [];
  return {
    chunks,
    listener: (chunk: Buffer, stream: OutputStream) => {
      chunks.push([chunk.toString("latin1"), stream]);
    },
  };
};

const microtask = () => new Promise<void>((done) => queueMicrotask(done));

describe("spawned process output relay", () => {
  it("passes chunks straight to the listeners registered, keeping none", () => {
    const { source, output } = relay();
    const first = received();
    const second = received();
    output.subscribe(first.listener);
    const unsubscribe = output.subscribe(second.listener);
    output.push(Buffer.from("a"), "stdout");
    unsubscribe();
    output.push(Buffer.from("b"), "stderr");
    expect(first.chunks).toEqual([
      ["a", "stdout"],
      ["b", "stderr"],
    ]);
    expect(second.chunks).toEqual([["a", "stdout"]]);
    expect(source.paused).toBe(false);
  });

  it("holds output until a listener registers, then gives it to every listener registered together", async () => {
    const { output } = relay();
    output.push(Buffer.from("early-1"), "stdout");
    output.push(Buffer.from("early-2"), "stderr");
    const first = received();
    const second = received();
    output.subscribe(first.listener);
    output.subscribe(second.listener);
    // Delivered on a microtask, not inside subscribe.
    expect(first.chunks).toEqual([]);
    // Output read before the flush stays behind the held output.
    output.push(Buffer.from("later"), "stdout");
    await microtask();
    const expected = [
      ["early-1", "stdout"],
      ["early-2", "stderr"],
      ["later", "stdout"],
    ];
    expect(first.chunks).toEqual(expected);
    expect(second.chunks).toEqual(expected);
  });

  it("pauses its source once the hold is full and resumes it after the flush", async () => {
    const { source, output } = relay();
    const chunk = Buffer.alloc(64 * 1024);
    let pushed = 0;
    while (!source.paused) {
      output.push(chunk, "stdout");
      pushed += chunk.length;
      expect(pushed).toBeLessThanOrEqual(SPAWN_HOLD_BYTES);
    }
    expect(source.pauses).toBe(1);
    let total = 0;
    output.subscribe((data) => {
      total += data.length;
    });
    expect(source.paused).toBe(true);
    await microtask();
    expect(total).toBe(pushed);
    expect(source.paused).toBe(false);
  });

  it("counts many small chunks against the hold, so a trickle cannot pile up buffers", () => {
    const { source, output } = relay();
    let chunks = 0;
    while (!source.paused && chunks < SPAWN_HOLD_BYTES) {
      output.push(Buffer.from("x"), "stderr");
      chunks++;
    }
    expect(source.paused).toBe(true);
    expect(chunks).toBeLessThan(SPAWN_HOLD_BYTES / 64);
  });

  it("drops unheard output once told to, and never stays paused", () => {
    const { source, output } = relay();
    while (!source.paused) output.push(Buffer.alloc(64 * 1024), "stdout");
    output.discardUnheard();
    expect(source.paused).toBe(false);
    for (let index = 0; index < 64; index++)
      output.push(Buffer.alloc(64 * 1024), "stdout");
    expect(source.paused).toBe(false);
    // A listener still receives what is read while it listens.
    const late = received();
    output.subscribe(late.listener);
    output.push(Buffer.from("tail"), "stderr");
    expect(late.chunks).toEqual([["tail", "stderr"]]);
  });

  it("keeps delivering to other listeners when one throws", () => {
    const { output } = relay();
    const healthy = received();
    output.subscribe(() => {
      throw new Error("listener bug");
    });
    output.subscribe(healthy.listener);
    output.push(Buffer.from("a"), "stdout");
    expect(healthy.chunks).toEqual([["a", "stdout"]]);
  });

  it("keeps the rest held when every listener leaves during the flush", async () => {
    const { output } = relay();
    output.push(Buffer.from("one"), "stdout");
    output.push(Buffer.from("two"), "stdout");
    const first: string[] = [];
    const unsubscribe = output.subscribe((chunk) => {
      first.push(chunk.toString());
      unsubscribe();
    });
    await microtask();
    expect(first).toEqual(["one"]);
    const second = received();
    output.subscribe(second.listener);
    await microtask();
    expect(second.chunks).toEqual([["two", "stdout"]]);
  });
});
