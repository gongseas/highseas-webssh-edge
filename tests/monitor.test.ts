import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeNetworkMonitorOutput, MONITOR_COMMAND, NETWORK_MONITOR_COMMAND, parseMonitorOutput } from "../worker/monitor";

function fixture(sent: number, received: number) {
  return [
    "cpu 100 0 100 800 0 0 0 0 0 0",
    "Inter-| Receive | Transmit\n eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0",
    "cpu 150 0 150 900 0 0 0 0 0 0",
    "Inter-| Receive | Transmit\n eth0: 2500 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0",
    "MemTotal: 1048576 kB\nMemAvailable: 524288 kB\nSwapTotal: 262144 kB\nSwapFree: 131072 kB",
    "/dev/vda1 10737418240 5368709120 5368709120 50% /",
    "172800.00 100.00",
    "0.10 0.20 0.30 1/100 123",
    "edge-host",
    "Linux 6.1.0-cloud-amd64",
    "712 root 0.7 2.4 /usr/sbin/sshd -D\n911 www-data 1.5 1.2 nginx: worker process",
    "tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=712,fd=3))\ntcp LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:((\"node\",pid=911,fd=18))",
    `ESTAB 0 0 10.0.0.1:22 203.0.113.10:51122 users:((\"sshd\",pid=712,fd=4))\n\t cubic bytes_sent:${sent} bytes_received:${received}\n  tcp ESTAB 0 0 10.0.0.1:45210 198.51.100.20:443 users:((\"XrayR\",pid=148073,fd=8)) bytes_sent:${sent + 100} bytes_received:${received + 200}`
  ].join("\n---HIGHSEAS_SECTION---\n");
}

test("monitor parser reports listening IPs, connected peers and per-IP rates", () => {
  const first = parseMonitorOutput(fixture(1000, 1800), null, 1_000);
  assert.ok(first);
  const second = parseMonitorOutput(fixture(1600, 2600), first.snapshot, 9_000);
  assert.ok(second);
  assert.equal(second.metrics.hostname, "edge-host");
  assert.equal(second.metrics.cpuPercent, 50);
  assert.deepEqual(second.metrics.loadAverage, [0.1, 0.2, 0.3]);
  assert.equal(second.metrics.listeningPorts.length, 3);

  const ssh = second.metrics.listeningPorts.find((port) => port.listenPort === 22);
  assert.ok(ssh);
  assert.equal(ssh.listenIp, "0.0.0.0");
  assert.equal(ssh.pid, 712);
  assert.equal(ssh.processName, "sshd");
  assert.equal(ssh.connectionCount, 1);
  assert.equal(ssh.connectedIps[0].ip, "203.0.113.10");
  assert.equal(ssh.connectedIps[0].transmitBytesPerSecond, 75);
  assert.equal(ssh.connectedIps[0].receiveBytesPerSecond, 100);
  const outbound = second.metrics.listeningPorts.find((port) => port.listenPort === 45210);
  assert.ok(outbound);
  assert.equal(outbound.pid, 148073);
  assert.equal(outbound.processName, "XrayR");
  assert.equal(outbound.connectedIps[0].ip, "198.51.100.20");
});

test("monitor command keeps collecting after an optional section fails", () => {
  assert.equal(MONITOR_COMMAND.match(/HIGHSEAS_SECTION/g)?.length, 13);
  assert.doesNotMatch(MONITOR_COMMAND, /&& echo/);
  assert.match(NETWORK_MONITOR_COMMAND, /ss -H -tnpi/);
  const systemOutput = fixture(100, 200).replace(/tcp LISTEN[\s\S]*$/, "");
  const networkOutput = "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n---HIGHSEAS_SECTION---\nESTAB 0 0 10.0.0.1:22 203.0.113.10:50000\n---HIGHSEAS_SECTION---\n";
  const merged = mergeNetworkMonitorOutput(systemOutput, networkOutput);
  assert.match(merged.split("---HIGHSEAS_SECTION---")[11] ?? "", /LISTEN/);
  assert.match(merged.split("---HIGHSEAS_SECTION---")[12] ?? "", /ESTAB/);
});
