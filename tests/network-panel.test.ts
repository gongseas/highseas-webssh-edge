import assert from "node:assert/strict";
import { test } from "node:test";
import type { ListeningPort } from "../shared/types";
import { groupNetworkPorts } from "../src/components/NetworkPanel";

test("network panel groups TCP and UDP rows by process and aggregates peers", () => {
  const groups = groupNetworkPorts([
    port({ pid: 49939, processName: "V2bX", protocol: "tcp", listenPort: 40728, ip: "104.18.32.47", remotePort: 443, transmit: 2_000, receive: 4_000 }),
    port({ pid: 49939, processName: "V2bX", protocol: "udp", listenPort: 2087, ip: "104.18.32.47", remotePort: 8443, transmit: 1_000, receive: 3_000 }),
    port({ pid: 2425, processName: "sshd", protocol: "tcp", listenPort: 22, ip: "203.0.113.10", remotePort: 51000, transmit: 500, receive: 700 })
  ]);

  assert.equal(groups.length, 2);
  const v2bx = groups.find((group) => group.pid === 49939);
  assert.ok(v2bx);
  assert.equal(v2bx.ports.length, 2);
  assert.equal(v2bx.summary.protocol, "tcp/udp");
  assert.equal(v2bx.summary.ipCount, 1);
  assert.equal(v2bx.summary.connectionCount, 2);
  assert.equal(v2bx.summary.transmitBytesPerSecond, 3_000);
  assert.equal(v2bx.summary.receiveBytesPerSecond, 7_000);
  assert.deepEqual(v2bx.summary.connectedIps[0].ports, [443, 8443]);
});

test("unresolved UDP ports collapse into one group after identified processes", () => {
  const groups = groupNetworkPorts([
    port({ pid: null, processName: "udp", protocol: "udp", listenPort: 33025, ip: "198.51.100.1", remotePort: 443, transmit: 50, receive: 100 }),
    port({ pid: null, processName: "udp", protocol: "udp", listenPort: 33104, ip: "198.51.100.2", remotePort: 443, transmit: 75, receive: 125 }),
    port({ pid: 99, processName: "dnsproxy", protocol: "udp", listenPort: 53, ip: "203.0.113.53", remotePort: 53, transmit: 10, receive: 10 })
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].pid, 99);
  assert.equal(groups[1].pid, null);
  assert.equal(groups[1].ports.length, 2);
  assert.equal(groups[1].summary.ipCount, 2);
  assert.equal(groups[1].summary.transmitBytesPerSecond, 125);
});

function port(input: { pid: number | null; processName: string; protocol: string; listenPort: number; ip: string; remotePort: number; transmit: number; receive: number }): ListeningPort {
  return {
    pid: input.pid,
    processName: input.processName,
    protocol: input.protocol,
    listenIp: input.listenPort === 22 || input.listenPort === 2087 ? "0.0.0.0" : "10.0.0.2",
    listenPort: input.listenPort,
    ipCount: 1,
    connectionCount: 1,
    transmitBytesPerSecond: input.transmit,
    receiveBytesPerSecond: input.receive,
    connectedIps: [{
      ip: input.ip,
      ports: [input.remotePort],
      region: "test",
      connectionCount: 1,
      transmitBytesPerSecond: input.transmit,
      receiveBytesPerSecond: input.receive
    }]
  };
}
