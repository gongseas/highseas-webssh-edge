import type { ConnectedIp, ListeningPort, ProcessInfo, ServerMetrics } from "../shared/types";

const MONITOR_SECTIONS = [
  "cat /proc/stat | head -1",
  "cat /proc/net/dev",
  "sleep 1 && cat /proc/stat | head -1",
  "cat /proc/net/dev",
  "cat /proc/meminfo",
  "df -B1 / | tail -1",
  "cat /proc/uptime",
  "cat /proc/loadavg",
  "hostname",
  "uname -sr",
  "ps -eo pid,user,%cpu,%mem,args --sort=-%mem --no-headers 2>/dev/null | head -40",
  "true",
  "true"
];

// A missing optional utility must not prevent later network sections from running.
export const MONITOR_COMMAND = MONITOR_SECTIONS
  .map((command) => `{ ${command}; } 2>/dev/null; printf '\n---HIGHSEAS_SECTION---\n';`)
  .join(" ");

export const NETWORK_MONITOR_COMMAND = [
  "(ss -H -tulnp 2>/dev/null || netstat -tulnp 2>/dev/null || true)",
  "(ss -H -tnpi 2>/dev/null || netstat -tnp 2>/dev/null || true)"
].map((command) => `{ ${command}; } 2>/dev/null; printf '\n---HIGHSEAS_SECTION---\n';`).join(" ");

export function mergeNetworkMonitorOutput(systemOutput: string, networkOutput: string) {
  const systemSections = systemOutput.split("---HIGHSEAS_SECTION---");
  const networkSections = networkOutput.split("---HIGHSEAS_SECTION---");
  systemSections[11] = networkSections[0] ?? "";
  systemSections[12] = networkSections[1] ?? "";
  return systemSections.join("---HIGHSEAS_SECTION---");
}

type ConnectionCounter = { sent: number; received: number };
export type ConnectionSnapshot = { timestamp: number; counters: Map<string, ConnectionCounter> };

type RawConnection = {
  pid: number | null;
  processName: string;
  localIp: string;
  localPort: number;
  peerIp: string;
  peerPort: number;
  sent: number;
  received: number;
  transmitRate: number;
  receiveRate: number;
};

export function parseMonitorOutput(raw: string, previous: ConnectionSnapshot | null, now = Date.now()) {
  const sections = raw.split("---HIGHSEAS_SECTION---").map((section) => section.trim());
  if (sections.length < 13) return null;

  const listening = parseListeningPorts(sections[11]);
  const parsedConnections = parseConnections(sections[12]);
  const snapshot = buildSnapshot(parsedConnections, now);
  applyConnectionRates(parsedConnections, previous, now);

  const metrics: ServerMetrics = {
    cpuPercent: parseCpuDelta(sections[0], sections[2]),
    network: parseNetworkDelta(sections[1], sections[3]),
    memory: parseMeminfo(sections[4], "MemTotal", "MemAvailable"),
    swap: parseMeminfo(sections[4], "SwapTotal", "SwapFree"),
    disk: parseDf(sections[5]),
    uptimeSeconds: Number(sections[6].split(/\s+/)[0]) || 0,
    loadAverage: parseLoad(sections[7]),
    hostname: sections[8] || "-",
    kernel: sections[9] || "-",
    listeningPorts: aggregateListeningPorts(listening, parsedConnections),
    updatedAt: new Date(now).toISOString()
  };

  return { metrics, processes: parseProcesses(sections[10]), snapshot };
}

export async function enrichLocations(ports: ListeningPort[]) {
  const publicIps = [...new Set(ports.flatMap((port) => port.connectedIps.map((peer) => peer.ip)).filter((ip) => !isPrivateIp(ip)))];
  const locations = await lookupLocationsWithFallback(publicIps);
  for (const port of ports) {
    for (const peer of port.connectedIps) {
      peer.region = isPrivateIp(peer.ip) ? "局域网" : locations.get(peer.ip) ?? "未知";
    }
  }
}

function parseCpuDelta(first: string, second: string) {
  const parse = (line: string) => {
    const values = line.replace(/^cpu\s+/, "").trim().split(/\s+/).map(Number);
    return { idle: (values[3] || 0) + (values[4] || 0), total: values.reduce((sum, value) => sum + value, 0) };
  };
  const before = parse(first);
  const after = parse(second);
  const total = after.total - before.total;
  return total > 0 ? Math.max(0, Math.min(100, Math.round(((total - (after.idle - before.idle)) / total) * 100))) : 0;
}

function parseNetworkDelta(first: string, second: string) {
  const totals = (value: string) => value.split("\n").reduce((sum, line) => {
    const match = line.match(/^\s*([^:]+):\s*(.+)$/);
    if (!match || match[1].trim() === "lo") return sum;
    const fields = match[2].trim().split(/\s+/).map(Number);
    sum.received += fields[0] || 0;
    sum.sent += fields[8] || 0;
    return sum;
  }, { received: 0, sent: 0 });
  const before = totals(first);
  const after = totals(second);
  return {
    receiveBytesPerSecond: Math.max(0, after.received - before.received),
    transmitBytesPerSecond: Math.max(0, after.sent - before.sent)
  };
}

function parseMeminfo(raw: string, totalKey: string, freeKey: string) {
  const read = (key: string) => Number(raw.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0) * 1024;
  const total = read(totalKey);
  const free = read(freeKey);
  const used = Math.max(0, total - free);
  return {
    used: +(used / 1073741824).toFixed(1),
    total: +(total / 1073741824).toFixed(1),
    percent: total > 0 ? Math.round((used / total) * 100) : 0
  };
}

function parseDf(line: string) {
  const fields = line.trim().split(/\s+/);
  const total = Number(fields[1]) || 0;
  const used = Number(fields[2]) || 0;
  return {
    used: +(used / 1073741824).toFixed(1),
    total: +(total / 1073741824).toFixed(1),
    percent: total > 0 ? Math.round((used / total) * 100) : 0
  };
}

function parseLoad(raw: string): [number, number, number] {
  const values = raw.split(/\s+/).slice(0, 3).map((value) => Number(value) || 0);
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
}

function parseProcesses(raw: string): ProcessInfo[] {
  return raw.split("\n").filter(Boolean).map((line) => {
    const fields = line.trim().split(/\s+/);
    return {
      pid: Number(fields[0]) || 0,
      user: fields[1] ?? "-",
      cpu: Number(fields[2]) || 0,
      memory: Number(fields[3]) || 0,
      command: fields.slice(4).join(" ")
    };
  }).filter((process) => process.pid > 0);
}

function parseListeningPorts(raw: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const line of raw.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const isSs = fields[1] === "LISTEN" || fields[1] === "UNCONN";
    const protocol = fields[0].replace(/\d+$/, "");
    const endpoint = splitEndpoint(fields[isSs ? 4 : 3] ?? "");
    if (!endpoint || !endpoint.port) continue;
    const processText = fields.slice(isSs ? 6 : 6).join(" ");
    const pidText = processText.match(/pid=(\d+)/)?.[1] ?? processText.match(/(\d+)\//)?.[1];
    const processName = processText.match(/\("([^"]+)"/)?.[1] ?? processText.match(/\d+\/([^\s]+)/)?.[1] ?? "-";
    ports.push({
      pid: pidText ? Number(pidText) : null,
      processName,
      protocol,
      listenIp: endpoint.ip,
      listenPort: endpoint.port,
      ipCount: 0,
      connectionCount: 0,
      receiveBytesPerSecond: 0,
      transmitBytesPerSecond: 0,
      connectedIps: []
    });
  }
  return ports;
}

function parseConnections(raw: string): RawConnection[] {
  const lines = raw.split("\n");
  const result: RawConnection[] = [];
  let current: RawConnection | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    const endpoints = findEndpointPair(fields);
    const local = endpoints?.[0] ?? null;
    const peer = endpoints?.[1] ?? null;
    const isConnectionLine = Boolean(local?.port && peer?.ip);
    if (/^\s/.test(line) && current && !isConnectionLine) {
      current.sent = Number(line.match(/bytes_sent:(\d+)/)?.[1] ?? current.sent);
      current.received = Number(line.match(/bytes_received:(\d+)/)?.[1] ?? current.received);
      continue;
    }
    if (current) result.push(current);
    current = null;
    if (!local || !peer || !local.port || !peer.ip) continue;
    const processText = line.match(/users:\(\(.+$/)?.[0] ?? fields.slice(5).join(" ");
    const pidText = processText.match(/pid=(\d+)/)?.[1] ?? processText.match(/(\d+)\/[^\s]+/)?.[1];
    const processName = processText.match(/\("([^"]+)"/)?.[1] ?? processText.match(/\d+\/([^\s]+)/)?.[1] ?? "";
    current = {
      pid: pidText ? Number(pidText) : null,
      processName,
      localIp: normalizeIp(local.ip),
      localPort: local.port,
      peerIp: normalizeIp(peer.ip),
      peerPort: peer.port,
      sent: Number(line.match(/bytes_sent:(\d+)/)?.[1] ?? 0),
      received: Number(line.match(/bytes_received:(\d+)/)?.[1] ?? 0),
      transmitRate: 0,
      receiveRate: 0
    };
  }
  if (current) result.push(current);
  return result;
}

function findEndpointPair(fields: string[]) {
  for (let index = 0; index < fields.length - 1; index += 1) {
    const local = splitEndpoint(fields[index] ?? "");
    const peer = splitEndpoint(fields[index + 1] ?? "");
    if (local?.port && peer?.ip && isSocketAddress(local.ip) && isSocketAddress(peer.ip) && (peer.port || peer.ip === "*")) {
      return [local, peer] as const;
    }
  }
  return null;
}

function isSocketAddress(value: string) {
  return value === "*" || value === "::" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || /^[0-9a-f:]+(?:%[\w.-]+)?$/i.test(value);
}

function splitEndpoint(value: string) {
  const bracketed = value.match(/^\[([^\]]+)]:(\d+|\*)$/);
  if (bracketed) return { ip: bracketed[1], port: Number(bracketed[2]) || 0 };
  const separator = value.lastIndexOf(":");
  if (separator < 0) return null;
  return { ip: value.slice(0, separator) || "*", port: Number(value.slice(separator + 1)) || 0 };
}

function buildSnapshot(connections: RawConnection[], timestamp: number): ConnectionSnapshot {
  const counters = new Map<string, ConnectionCounter>();
  for (const connection of connections) counters.set(connectionKey(connection), { sent: connection.sent, received: connection.received });
  return { timestamp, counters };
}

function applyConnectionRates(connections: RawConnection[], previous: ConnectionSnapshot | null, now: number) {
  if (!previous) return;
  const seconds = Math.max(0.5, (now - previous.timestamp) / 1000);
  for (const connection of connections) {
    const before = previous.counters.get(connectionKey(connection));
    if (!before) continue;
    connection.transmitRate = Math.max(0, (connection.sent - before.sent) / seconds);
    connection.receiveRate = Math.max(0, (connection.received - before.received) / seconds);
  }
}

function connectionKey(connection: RawConnection) {
  return `${connection.localIp}|${connection.localPort}|${connection.peerIp}|${connection.peerPort}`;
}

function aggregateListeningPorts(ports: ListeningPort[], connections: RawConnection[]) {
  const allPorts = [...ports];
  for (const connection of connections) {
    const alreadyRepresented = allPorts.some((port) => port.protocol.startsWith("tcp") && port.listenPort === connection.localPort);
    if (!alreadyRepresented) {
      allPorts.push({
        pid: connection.pid,
        processName: connection.processName || "active connection",
        protocol: "tcp",
        listenIp: connection.localIp,
        listenPort: connection.localPort,
        ipCount: 0,
        connectionCount: 0,
        receiveBytesPerSecond: 0,
        transmitBytesPerSecond: 0,
        connectedIps: []
      });
    }
  }
  return allPorts.map((port) => {
    const peers = new Map<string, ConnectedIp>();
    const matches = connections.filter((connection) => port.protocol.startsWith("tcp") && connection.localPort === port.listenPort);
    for (const connection of matches) {
      if (!connection.peerIp || ["*", "0.0.0.0", "::"].includes(connection.peerIp)) continue;
      const peer = peers.get(connection.peerIp) ?? {
        ip: connection.peerIp,
        region: "",
        connectionCount: 0,
        receiveBytesPerSecond: 0,
        transmitBytesPerSecond: 0
      };
      peer.connectionCount += 1;
      peer.receiveBytesPerSecond += connection.receiveRate;
      peer.transmitBytesPerSecond += connection.transmitRate;
      peers.set(connection.peerIp, peer);
    }
    const connectedIps = [...peers.values()].sort((a, b) =>
      b.receiveBytesPerSecond + b.transmitBytesPerSecond - a.receiveBytesPerSecond - a.transmitBytesPerSecond || b.connectionCount - a.connectionCount
    );
    return {
      ...port,
      ipCount: connectedIps.length,
      connectionCount: matches.length,
      receiveBytesPerSecond: connectedIps.reduce((sum, peer) => sum + peer.receiveBytesPerSecond, 0),
      transmitBytesPerSecond: connectedIps.reduce((sum, peer) => sum + peer.transmitBytesPerSecond, 0),
      connectedIps
    };
  }).sort((a, b) => b.connectionCount - a.connectionCount || a.listenPort - b.listenPort);
}

function normalizeIp(ip: string) {
  return ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : ip;
}

function isPrivateIp(ip: string) {
  const value = normalizeIp(ip).toLowerCase();
  return value === "::1" || value === "127.0.0.1" || value.startsWith("10.") || value.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./.test(value) || value.startsWith("169.254.") || value.startsWith("fe80:")
    || value.startsWith("fc") || value.startsWith("fd");
}

const LOCATION_TTL = 24 * 60 * 60 * 1000;
const LOCATION_FAILURE_TTL = 60 * 1000;
const locationCache = new Map<string, { value: string; expiresAt: number }>();

async function lookupLocationsWithFallback(ips: string[]) {
  const result = new Map<string, string>();
  const missing: string[] = [];
  for (const ip of ips) {
    const cached = locationCache.get(ip);
    if (cached && cached.expiresAt > Date.now()) result.set(ip, cached.value);
    else missing.push(ip);
  }

  await lookupWithIpApi(missing, result);
  const unresolved = missing.filter((ip) => !result.has(ip));
  await Promise.allSettled(unresolved.slice(0, 30).map((ip) => lookupWithIpWho(ip, result)));

  for (const ip of unresolved) {
    if (result.has(ip)) continue;
    locationCache.set(ip, { value: "未知", expiresAt: Date.now() + LOCATION_FAILURE_TTL });
    result.set(ip, "未知");
  }
  return result;
}

async function lookupWithIpApi(ips: string[], result: Map<string, string>) {
  if (!ips.length) return;
  try {
    const response = await fetch("http://ip-api.com/batch?fields=status,country,regionName,city,isp,org,query&lang=zh-CN", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(ips.slice(0, 100).map((query) => ({ query }))),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return;
    const rows = await response.json<Array<{ status: string; query: string; country?: string; regionName?: string; city?: string; isp?: string; org?: string }>>();
    for (const row of rows) {
      if (row.status !== "success") continue;
      setLocation(row.query, [row.country, row.regionName, row.city], row.isp || row.org, result);
    }
  } catch {
    // The HTTPS provider below remains available when this free batch API is throttled.
  }
}

async function lookupWithIpWho(ip: string, result: Map<string, string>) {
  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?lang=zh`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return;
    const row = await response.json<{ success: boolean; country?: string; region?: string; city?: string; connection?: { isp?: string; org?: string } }>();
    if (!row.success) return;
    setLocation(ip, [row.country, row.region, row.city], row.connection?.isp || row.connection?.org, result);
  } catch {
    // The caller records a short-lived negative cache entry.
  }
}

function setLocation(ip: string, parts: Array<string | undefined>, operator: string | undefined, result: Map<string, string>) {
  const location = parts.filter((value, index, all) => value && all.indexOf(value) === index).join(" ");
  const label = [location, operator].filter(Boolean).join(" / ") || "未知";
  locationCache.set(ip, { value: label, expiresAt: Date.now() + LOCATION_TTL });
  result.set(ip, label);
}
