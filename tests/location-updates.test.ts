import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocationUpdates } from "../worker/locationUpdates";

test("slow location lookup never blocks fresh samples or republishes old rates", async () => {
  let resolve!: () => void;
  let calls = 0;
  const published: number[] = [];
  const updates = createLocationUpdates<{ sequence: number; listeningPorts: any[] }>(
    sample => published.push(sample.sequence),
    () => { calls++; return new Promise<void>(done => { resolve = done; }); },
    () => {}
  );
  const sample = (sequence: number) => ({ sequence, listeningPorts: [{ connectedIps: [{ region: "" }] }] });
  updates.update(sample(1));
  updates.update(sample(2));
  assert.deepEqual(published, [1, 2]);
  assert.equal(calls, 1);
  resolve();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(published, [1, 2, 2]);
  updates.update(sample(3));
  updates.close();
  resolve();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(published, [1, 2, 2, 3]);
});
