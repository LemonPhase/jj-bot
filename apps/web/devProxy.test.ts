import { describe, expect, it } from "vitest";
import { type ClientResponse, closeClientWithUpstream } from "./devProxy";

class FakeStream {
  private readonly listeners = new Map<string, (() => void)[]>();
  on(event: string, listener: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class FakeResponse extends FakeStream implements ClientResponse {
  writableEnded = false;
  destroyed = false;
  destroyCalls = 0;
  destroy() {
    this.destroyCalls += 1;
    this.destroyed = true;
  }
}

describe("event stream proxy", () => {
  it("destroys the client response when the upstream stream aborts", () => {
    const upstream = new FakeStream();
    const client = new FakeResponse();
    closeClientWithUpstream(upstream, client);
    upstream.emit("aborted");
    upstream.emit("error");
    upstream.emit("close");
    expect(client.destroyCalls).toBe(1);
  });

  it("destroys it when the upstream closes without ending (an API restart)", () => {
    const upstream = new FakeStream();
    const client = new FakeResponse();
    closeClientWithUpstream(upstream, client);
    upstream.emit("close");
    expect(client.destroyed).toBe(true);
  });

  it("leaves a cleanly ended stream to the pipe", () => {
    const upstream = new FakeStream();
    const client = new FakeResponse();
    closeClientWithUpstream(upstream, client);
    client.writableEnded = true; // the pipe ended it on the upstream's `end`
    upstream.emit("close");
    expect(client.destroyed).toBe(false);
  });
});
