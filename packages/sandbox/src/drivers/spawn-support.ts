import {
  type OutputListener,
  type OutputStream,
  SPAWN_HOLD_BYTES,
} from "../contract";

/**
 * Shared pieces of `Sandbox.spawn` for the in-tree drivers: the shell
 * wrapper that runs an argv, and the output relay that implements the
 * contract's hold-and-pause policy.
 */

/**
 * Arguments for `/bin/sh` that run `argv` with `exec`, so the process tree
 * is the command's own, and a missing or non-executable command exits 127 or
 * 126 with the shell's message on stderr on every driver, instead of failing
 * in a driver-specific way.
 */
export const spawnShellArgs = (argv: readonly string[]): string[] => [
  "-c",
  'exec "$@"',
  "jj-spawn",
  ...argv,
];

/** Where the relay reads from: the driver's pipes or connection. */
export interface OutputSource {
  pause(): void;
  resume(): void;
}

/**
 * What a held chunk counts for beyond its bytes, so a process that trickles
 * single bytes cannot hold an unbounded number of small buffers.
 */
const HELD_CHUNK_OVERHEAD = 128;

/**
 * Passes a spawned process's output to its listeners as it is read, keeping
 * no copy. With no listener it holds up to `SPAWN_HOLD_BYTES` and then
 * pauses the source; the first listener to register gets the held output on
 * a microtask and resumes the source. After `discardUnheard()` output that
 * nobody listens to is dropped and the source never stays paused, so a
 * stopped process can drain and end.
 */
export class OutputRelay {
  private readonly listeners = new Set<OutputListener>();
  private held: Array<[Buffer, OutputStream]> = [];
  /** Index of the next held chunk to deliver. */
  private next = 0;
  private heldBytes = 0;
  private paused = false;
  private flushing = false;
  private discarding = false;

  constructor(private readonly source: OutputSource) {}

  push(chunk: Buffer, stream: OutputStream): void {
    if (chunk.length === 0) return;
    // Held output goes first, so a pending flush keeps the order.
    if (this.listeners.size > 0 && !this.holding()) {
      this.deliver(chunk, stream);
      return;
    }
    if (this.discarding && this.listeners.size === 0) return;
    this.held.push([chunk, stream]);
    this.heldBytes += chunk.length + HELD_CHUNK_OVERHEAD;
    if (this.heldBytes >= SPAWN_HOLD_BYTES && !this.paused) {
      this.paused = true;
      this.source.pause();
    }
  }

  subscribe(listener: OutputListener): () => void {
    this.listeners.add(listener);
    if (this.holding()) this.scheduleFlush();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** From now on, output that no listener receives is dropped. */
  discardUnheard(): void {
    this.discarding = true;
    if (this.listeners.size === 0) this.dropHeld();
  }

  private holding(): boolean {
    return this.next < this.held.length;
  }

  private dropHeld(): void {
    this.held = [];
    this.next = 0;
    this.heldBytes = 0;
    this.unpause();
  }

  private scheduleFlush(): void {
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      while (this.listeners.size > 0) {
        const entry = this.held[this.next];
        if (!entry) {
          this.dropHeld();
          return;
        }
        this.held[this.next++] = undefined as never;
        this.heldBytes -= entry[0].length + HELD_CHUNK_OVERHEAD;
        this.deliver(entry[0], entry[1]);
      }
      // Every listener left during the flush: the rest stays held, and
      // reading goes on while there is room to hold more.
      if (this.discarding) return this.dropHeld();
      this.held = this.held.slice(this.next);
      this.next = 0;
      if (this.heldBytes < SPAWN_HOLD_BYTES) this.unpause();
    });
  }

  private unpause(): void {
    if (!this.paused) return;
    this.paused = false;
    this.source.resume();
  }

  private deliver(chunk: Buffer, stream: OutputStream): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(chunk, stream);
      } catch {
        // A listener must not throw; one that does cannot stop the others.
      }
    }
  }
}

/** What `SandboxProcess.write` rejects with once stdin is closed. */
export const stdinClosed = () => new Error("The process's stdin is closed");
