import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Client, ClientChannel } from "ssh2";
import { captureMonitorExec } from "../worker/monitorExec";

function fakeChannel() {
  const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), closed: false, close() { this.closed = true; this.emit("close"); } });
  return stream;
}
function clientWith(exec: (callback: (error: Error | undefined, stream: ClientChannel) => void) => void) {
  return { exec: (_command: string, callback: Parameters<typeof exec>[0]) => exec(callback) } as Pick<Client, "exec">;
}

test("a stalled monitoring channel times out and the next command still succeeds", async () => {
  const signal = new AbortController().signal;
  const stuck = fakeChannel();
  await assert.rejects(captureMonitorExec(clientWith(callback => callback(undefined, stuck as unknown as ClientChannel)), "read", signal, 20), /timed out/);
  assert.equal(stuck.closed, true);
  const next = fakeChannel();
  const result = captureMonitorExec(clientWith(callback => callback(undefined, next as unknown as ClientChannel)), "read", signal, 500);
  next.emit("data", "fresh"); next.emit("close", 0);
  assert.equal(await result, "fresh");
});

test("opening timeout closes a channel that arrives late", async () => {
  let complete!: (error: Error | undefined, channel: ClientChannel) => void;
  await assert.rejects(captureMonitorExec(clientWith(callback => { complete = callback; }), "read", new AbortController().signal, 20), /timed out/);
  const late = fakeChannel();
  complete(undefined, late as unknown as ClientChannel);
  assert.equal(late.closed, true);
});

test("monitor abort, stream errors and oversized output settle instead of hanging", async () => {
  for (const reason of ["abort", "error", "size"] as const) {
    const controller = new AbortController();
    const stream = fakeChannel();
    const result = captureMonitorExec(clientWith(callback => callback(undefined, stream as unknown as ClientChannel)), "read", controller.signal, 500, 4);
    if (reason === "abort") controller.abort();
    if (reason === "error") stream.emit("error", new Error("stream failed"));
    if (reason === "size") stream.emit("data", "too much data");
    await assert.rejects(result);
    assert.equal(stream.closed, true);
  }
});
