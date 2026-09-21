import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNTRACK_NETLINK_SCRIPT, enrichLocations, mergeNetworkMonitorOutput, MONITOR_COMMAND, NETWORK_MONITOR_COMMAND, parseMonitorOutput } from "../worker/monitor";
import type { ListeningPort } from "../shared/types";

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

test("monitor parser reports UDP peers from ss and conntrack output", () => {
  const systemOutput = fixture(100, 200);
  const networkOutput = [
    "udp UNCONN 0 0 0.0.0.0:443 0.0.0.0:* users:((\"xray\",pid=901,fd=9))",
    "tcp ESTAB 0 0 10.0.0.1:22 203.0.113.10:50000 users:((\"sshd\",pid=712,fd=4))",
    "udp ESTAB 0 0 10.0.0.1:443 198.51.100.77:53000 users:((\"xray\",pid=901,fd=10))",
    "udp      17 29 src=192.0.2.88 dst=10.0.0.1 sport=54000 dport=443 packets=4 bytes=1200 src=10.0.0.1 dst=192.0.2.88 sport=443 dport=54000 packets=3 bytes=900"
  ].join("\n---HIGHSEAS_SECTION---\n");
  const first = parseMonitorOutput(mergeNetworkMonitorOutput(systemOutput, networkOutput), null, 1_000);
  assert.ok(first);

  const secondConntrack = "udp      17 29 src=192.0.2.88 dst=10.0.0.1 sport=54000 dport=443 packets=8 bytes=2200 src=10.0.0.1 dst=192.0.2.88 sport=443 dport=54000 packets=7 bytes=1900";
  const secondNetworkOutput = networkOutput.split("---HIGHSEAS_SECTION---").slice(0, 3).concat(secondConntrack).join("\n---HIGHSEAS_SECTION---\n");
  const second = parseMonitorOutput(mergeNetworkMonitorOutput(systemOutput, secondNetworkOutput), first.snapshot, 3_000);
  assert.ok(second);

  const udp = second.metrics.listeningPorts.find((port) => port.protocol === "udp" && port.listenPort === 443);
  assert.ok(udp);
  assert.equal(udp.pid, 901);
  assert.equal(udp.processName, "xray");
  assert.equal(udp.connectionCount, 2);
  assert.deepEqual(udp.connectedIps.map((peer) => peer.ip).sort(), ["192.0.2.88", "198.51.100.77"]);
  const trackedPeer = udp.connectedIps.find((peer) => peer.ip === "192.0.2.88");
  assert.ok(trackedPeer);
  assert.equal(trackedPeer.receiveBytesPerSecond, 500);
  assert.equal(trackedPeer.transmitBytesPerSecond, 500);
});

test("monitor parser reports connected UDP peers from proc net udp without conntrack", () => {
  const systemOutput = fixture(100, 200);
  const networkOutput = [
    "udp UNCONN 0 0 0.0.0.0:5353 0.0.0.0:* users:((\"dnsproxy\",pid=902,fd=8))",
    "",
    "",
    "",
    "__HIGHSEAS_PROC_UDP4__\nsl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n0: 0100000A:14E9 2C6433C6:CF08 07 00000000:00000000 00:00000000 00000000 0 0 12345 2 0000000000000000 0\n__HIGHSEAS_PROC_UDP6__"
  ].join("\n---HIGHSEAS_SECTION---\n");
  const parsed = parseMonitorOutput(mergeNetworkMonitorOutput(systemOutput, networkOutput), null, 1_000);
  assert.ok(parsed);

  const udp = parsed.metrics.listeningPorts.find((port) => port.protocol === "udp" && port.listenPort === 5353);
  assert.ok(udp);
  assert.equal(udp.processName, "dnsproxy");
  assert.equal(udp.connectionCount, 1);
  assert.equal(udp.connectedIps[0].ip, "198.51.100.44");
});

test("monitor parser assigns outbound UDP conntrack peers to the owning process", () => {
  const systemOutput = fixture(100, 200);
  const networkOutput = [
    "udp UNCONN 0 0 0.0.0.0:2087 0.0.0.0:* users:((\"V2bX\",pid=49939,fd=9))",
    "",
    "udp UNCONN 0 0 10.170.0.2:45000 0.0.0.0:* users:((\"V2bX\",pid=49939,fd=12))",
    "udp 17 29 src=10.170.0.2 dst=104.18.32.47 sport=45000 dport=443 packets=8 bytes=2200 src=104.18.32.47 dst=10.170.0.2 sport=443 dport=45000 packets=7 bytes=1900",
    ""
  ].join("\n---HIGHSEAS_SECTION---\n");
  const parsed = parseMonitorOutput(mergeNetworkMonitorOutput(systemOutput, networkOutput), null, 1_000);
  assert.ok(parsed);

  const udp = parsed.metrics.listeningPorts.find((port) => port.protocol === "udp" && port.pid === 49939 && port.listenPort === 2087);
  assert.ok(udp);
  assert.equal(udp.processName, "V2bX");
  assert.equal(udp.connectionCount, 1);
  assert.equal(udp.connectedIps[0].ip, "104.18.32.47");
  assert.deepEqual(udp.connectedIps[0].ports, [443]);
  assert.equal(parsed.metrics.listeningPorts.some((port) => port.listenPort === 45000), false);
});

test("monitor parser uses netlink PID annotations when ss hides UDP client sockets", () => {
  const systemOutput = fixture(100, 200);
  const networkOutput = [
    "udp UNCONN 0 0 0.0.0.0:2087 0.0.0.0:* users:((\"V2bX\",pid=49939,fd=9))",
    "",
    "",
    "udp src=10.170.0.2 dst=104.18.32.47 sport=45000 dport=443 bytes=2200 src=104.18.32.47 dst=10.170.0.2 sport=443 dport=45000 bytes=1900 local_side=src pid=49939 pname=V2bX",
    ""
  ].join("\n---HIGHSEAS_SECTION---\n");
  const parsed = parseMonitorOutput(mergeNetworkMonitorOutput(systemOutput, networkOutput), null, 1_000);
  assert.ok(parsed);

  const udp = parsed.metrics.listeningPorts.find((port) => port.protocol === "udp" && port.pid === 49939 && port.listenPort === 2087);
  assert.ok(udp);
  assert.equal(udp.connectionCount, 1);
  assert.equal(udp.connectedIps[0].ip, "104.18.32.47");
  assert.deepEqual(udp.connectedIps[0].ports, [443]);
});

test("monitor parser uses Highseas Monitor UDP packet counters", () => {
  const systemOutput = fixture(100, 200);
  const createNetworkOutput = (sentBytes: number, receivedBytes: number) => [
    "udp UNCONN 0 0 0.0.0.0:2087 0.0.0.0:* users:((\"V2bX\",pid=49939,fd=9))",
    "",
    "",
    "",
    "__HIGHSEAS_PROC_UDP4__\n__HIGHSEAS_PROC_UDP6__",
    JSON.stringify({
      version: "0.2.0",
      updatedAt: 1_000,
      connections: [{
        protocol: "udp",
        pid: 49939,
        processName: "V2bX",
        localIp: "10.170.0.2",
        localPort: 45000,
        peerIp: "104.18.32.47",
        peerPort: 443,
        sentBytes,
        receivedBytes,
        transmitBytesPerSecond: sentBytes / 2,
        receiveBytesPerSecond: receivedBytes / 2,
        lastSeen: 1_000
      }]
    })
  ].join("\n---HIGHSEAS_SECTION---\n");

  const first = parseMonitorOutput(mergeNetworkMonitorOutput(systemOutput, createNetworkOutput(1_000, 2_000)), null, 1_000);
  assert.ok(first);
  const firstUdp = first.metrics.listeningPorts.find((port) => port.protocol === "udp" && port.pid === 49939 && port.listenPort === 2087);
  assert.ok(firstUdp);
  assert.equal(firstUdp.transmitBytesPerSecond, 500);
  assert.equal(firstUdp.receiveBytesPerSecond, 1_000);
  const second = parseMonitorOutput(mergeNetworkMonitorOutput(systemOutput, createNetworkOutput(1_800, 2_400)), first.snapshot, 3_000);
  assert.ok(second);

  const udp = second.metrics.listeningPorts.find((port) => port.protocol === "udp" && port.pid === 49939 && port.listenPort === 2087);
  assert.ok(udp);
  assert.equal(udp.processName, "V2bX");
  assert.equal(udp.connectionCount, 1);
  assert.equal(udp.connectedIps[0].ip, "104.18.32.47");
  assert.deepEqual(udp.connectedIps[0].ports, [443]);
  assert.equal(udp.connectedIps[0].transmitBytesPerSecond, 400);
  assert.equal(udp.connectedIps[0].receiveBytesPerSecond, 200);
  assert.equal(second.metrics.listeningPorts.some((port) => port.listenPort === 45000), false);
});

test("monitor command keeps collecting after an optional section fails", () => {
  assert.equal(MONITOR_COMMAND.match(/HIGHSEAS_SECTION/g)?.length, 13);
  assert.doesNotMatch(MONITOR_COMMAND, /&& echo/);
  assert.match(NETWORK_MONITOR_COMMAND, /ss -H -tnpi/);
  assert.match(NETWORK_MONITOR_COMMAND, /ss -H -unpa/);
  assert.match(NETWORK_MONITOR_COMMAND, /conntrack -L -p udp/);
  assert.match(NETWORK_MONITOR_COMMAND, /sudo -n \/usr\/sbin\/conntrack -L -p udp/);
  assert.match(NETWORK_MONITOR_COMMAND, /\/proc\/net\/udp6/);
  assert.match(NETWORK_MONITOR_COMMAND, /HIGHSEAS_NETLINK_PY/);
  assert.match(NETWORK_MONITOR_COMMAND, /highseas-monitor snapshot --json/);
  assert.match(NETWORK_MONITOR_COMMAND, /cat \/proc\/net\/dev/);
  assert.match(CONNTRACK_NETLINK_SCRIPT, /socket\.AF_NETLINK/);
  assert.match(CONNTRACK_NETLINK_SCRIPT, /NETLINK_NETFILTER = 12/);
  const systemOutput = fixture(100, 200).replace(/tcp LISTEN[\s\S]*$/, "");
  const networkOutput = "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n---HIGHSEAS_SECTION---\nESTAB 0 0 10.0.0.1:22 203.0.113.10:50000\n---HIGHSEAS_SECTION---\nudp ESTAB 0 0 10.0.0.1:443 198.51.100.77:53000\n---HIGHSEAS_SECTION---\nudp 17 29 src=192.0.2.88 dst=10.0.0.1 sport=54000 dport=443 packets=4 bytes=1200\n---HIGHSEAS_SECTION---\n__HIGHSEAS_PROC_UDP4__\n---HIGHSEAS_SECTION---\n{\"connections\":[]}\n---HIGHSEAS_SECTION---\neth0: 3000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0\n";
  const merged = mergeNetworkMonitorOutput(systemOutput, networkOutput);
  assert.match(merged.split("---HIGHSEAS_SECTION---")[11] ?? "", /LISTEN/);
  assert.match(merged.split("---HIGHSEAS_SECTION---")[12] ?? "", /ESTAB/);
  assert.match(merged.split("---HIGHSEAS_SECTION---")[13] ?? "", /udp ESTAB/);
  assert.match(merged.split("---HIGHSEAS_SECTION---")[14] ?? "", /dport=443/);
  assert.match(merged.split("---HIGHSEAS_SECTION---")[15] ?? "", /PROC_UDP4/);
  assert.match(merged.split("---HIGHSEAS_SECTION---")[16] ?? "", /connections/);
  assert.match(merged.split("---HIGHSEAS_SECTION---")[17] ?? "", /eth0/);
});

test("interface rates use the same interval as connection counters", () => {
  const systemOutput = fixture(100, 200);
  const networkOutput = (received: number, sent: number) => [
    "", "", "", "", "", "",
    `eth0: ${received} 0 0 0 0 0 0 0 ${sent} 0 0 0 0 0 0 0`
  ].join("\n---HIGHSEAS_SECTION---\n");
  const first = parseMonitorOutput(mergeNetworkMonitorOutput(systemOutput, networkOutput(10_000, 20_000)), null, 1_000);
  assert.ok(first);
  const second = parseMonitorOutput(mergeNetworkMonitorOutput(systemOutput, networkOutput(16_000, 32_000)), first.snapshot, 4_000);
  assert.ok(second);
  assert.equal(second.metrics.network?.receiveBytesPerSecond, 2_000);
  assert.equal(second.metrics.network?.transmitBytesPerSecond, 4_000);
});

test("location enrichment includes the ISP from the batch provider", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? "");
    return Response.json([{
      status: "success",
      country: "中国",
      regionName: "香港",
      city: "香港",
      isp: "Example Telecom",
      query: "198.51.100.31"
    }]);
  };
  try {
    const ports = portsWithPeer("198.51.100.31");
    await enrichLocations(ports);
    assert.match(requestBody, /198\.51\.100\.31/);
    assert.equal(ports[0]?.connectedIps[0]?.region, "中国 香港 / Example Telecom");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("location enrichment falls back when the batch provider fails", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.startsWith("http://ip-api.com/")) return new Response("", { status: 429 });
    return Response.json({
      success: true,
      country: "美国",
      region: "加利福尼亚州",
      city: "洛杉矶",
      connection: { isp: "Fallback Network" }
    });
  };
  try {
    const ports = portsWithPeer("203.0.113.42");
    await enrichLocations(ports);
    assert.equal(requested.length, 2);
    assert.match(requested[1] ?? "", /ipwho\.is\/203\.0\.113\.42/);
    assert.equal(ports[0]?.connectedIps[0]?.region, "美国 加利福尼亚州 洛杉矶 / Fallback Network");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function portsWithPeer(ip: string): ListeningPort[] {
  return [{
    pid: 1,
    processName: "test",
    protocol: "tcp",
    listenIp: "0.0.0.0",
    listenPort: 22,
    ipCount: 1,
    connectionCount: 1,
    receiveBytesPerSecond: 0,
    transmitBytesPerSecond: 0,
    connectedIps: [{ ip, ports: [443], region: "", connectionCount: 1, receiveBytesPerSecond: 0, transmitBytesPerSecond: 0 }]
  }];
}

test("location batches leave unattempted peers pending and process them next time", async () => {
  const originalFetch = globalThis.fetch;
  let concurrent = 0;
  let maximum = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("http://ip-api.com/")) {
      const batch = JSON.parse(String(init?.body)) as Array<{ query: string }>;
      return Response.json(batch.map(({ query }) => ({ query, status: "success", country: "Test", isp: "Batch ISP" })));
    }
    concurrent++; maximum = Math.max(maximum, concurrent);
    await new Promise(done => setImmediate(done));
    concurrent--;
    return Response.json({ success: true, country: "Test", connection: { isp: "Fallback ISP" } });
  };
  try {
    const ports = Array.from({ length: 112 }, (_, i) => portsWithPeer(`198.51.100.${100 + i}`)[0]);
    await enrichLocations(ports);
    assert.equal(ports.filter(port => !port.connectedIps[0].region).length, 4);
    assert.ok(maximum <= 4);
    await enrichLocations(ports);
    assert.ok(ports.every(port => port.connectedIps[0].region.includes("ISP")));
  } finally { globalThis.fetch = originalFetch; }
});
