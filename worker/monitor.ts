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

// Reads conntrack through Linux netlink when conntrack-tools and procfs exports are unavailable.
export const CONNTRACK_NETLINK_SCRIPT = String.raw`import glob, os, socket, struct, time

NLMSG_DONE = 3
NLMSG_ERROR = 2
NLM_F_REQUEST = 1
NLM_F_DUMP = 0x300
NETLINK_NETFILTER = 12
CT_GET = (1 << 8) | 1

def aligned(length):
    return (length + 3) & ~3

def attributes(data):
    offset = 0
    while offset + 4 <= len(data):
        length, kind = struct.unpack_from("=HH", data, offset)
        if length < 4 or offset + length > len(data):
            break
        yield kind & 0x3fff, data[offset + 4:offset + length]
        offset += aligned(length)

def tuple_data(data):
    nested = dict(attributes(data))
    addresses = dict(attributes(nested.get(1, b"")))
    protocol = dict(attributes(nested.get(2, b"")))
    number = protocol.get(1, b"\x00")
    if not number or number[0] != 17:
        return None
    if 1 in addresses and 2 in addresses:
        source = socket.inet_ntop(socket.AF_INET, addresses[1][:4])
        destination = socket.inet_ntop(socket.AF_INET, addresses[2][:4])
    elif 3 in addresses and 4 in addresses:
        source = socket.inet_ntop(socket.AF_INET6, addresses[3][:16])
        destination = socket.inet_ntop(socket.AF_INET6, addresses[4][:16])
    else:
        return None
    source_port = struct.unpack("!H", protocol.get(2, b"\x00\x00")[:2])[0]
    destination_port = struct.unpack("!H", protocol.get(3, b"\x00\x00")[:2])[0]
    return source, destination, source_port, destination_port

def byte_counter(data):
    value = dict(attributes(data)).get(2, b"")
    if len(value) >= 8:
        return struct.unpack("!Q", value[:8])[0]
    if len(value) >= 4:
        return struct.unpack("!I", value[:4])[0]
    return 0

def udp_socket_owners():
    inode_ports = {}
    for table in ("/proc/net/udp", "/proc/net/udp6"):
        try:
            with open(table, "r", encoding="ascii") as handle:
                for line in handle.readlines()[1:]:
                    fields = line.split()
                    if len(fields) < 10 or ":" not in fields[1]:
                        continue
                    port = int(fields[1].rsplit(":", 1)[1], 16)
                    inode = fields[9]
                    if port and inode != "0":
                        inode_ports.setdefault(inode, set()).add(port)
        except OSError:
            pass

    inode_owners = {}
    needed = set(inode_ports)
    for process_path in glob.glob("/proc/[0-9]*"):
        if not needed:
            break
        try:
            pid = int(process_path.rsplit("/", 1)[1])
            with open(process_path + "/comm", "r", encoding="utf-8", errors="replace") as handle:
                name = handle.read().strip().replace(" ", "_") or "udp"
            for descriptor in os.scandir(process_path + "/fd"):
                try:
                    target = os.readlink(descriptor.path)
                except OSError:
                    continue
                if target.startswith("socket:[") and target.endswith("]"):
                    inode = target[8:-1]
                    if inode in needed:
                        inode_owners[inode] = (pid, name)
                        needed.discard(inode)
        except (OSError, ValueError):
            continue

    by_port = {}
    for inode, ports in inode_ports.items():
        owner = inode_owners.get(inode)
        if owner:
            for port in ports:
                by_port.setdefault(port, owner)
    return by_port

UDP_OWNERS = udp_socket_owners()

def dump(family):
    connection = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_NETFILTER)
    connection.bind((0, 0))
    connection.settimeout(2)
    sequence = int(time.time() * 1000) & 0xffffffff
    request = struct.pack("=IHHII", 20, CT_GET, NLM_F_REQUEST | NLM_F_DUMP, sequence, 0)
    request += struct.pack("=BBH", family, 0, 0)
    connection.sendto(request, (0, 0))
    finished = False
    while not finished:
        packet = connection.recv(1048576)
        offset = 0
        while offset + 16 <= len(packet):
            length, kind, flags, reply_sequence, sender = struct.unpack_from("=IHHII", packet, offset)
            if length < 16 or offset + length > len(packet):
                break
            payload = packet[offset + 16:offset + length]
            if kind == NLMSG_DONE:
                finished = True
            elif kind == NLMSG_ERROR:
                error = struct.unpack_from("=i", payload, 0)[0] if len(payload) >= 4 else -1
                if error:
                    raise OSError(-error, "conntrack netlink request failed")
                finished = True
            elif kind >> 8 == 1 and len(payload) >= 4:
                top = dict(attributes(payload[4:]))
                original = tuple_data(top.get(1, b""))
                reply = tuple_data(top.get(2, b""))
                if original and reply:
                    source_owner = UDP_OWNERS.get(original[2])
                    destination_owner = UDP_OWNERS.get(original[3])
                    owner = None
                    local_side = ""
                    if source_owner and not destination_owner:
                        owner, local_side = source_owner, "src"
                    elif destination_owner and not source_owner:
                        owner, local_side = destination_owner, "dst"
                    elif source_owner and destination_owner and source_owner == destination_owner:
                        owner, local_side = source_owner, "src"
                    owner_suffix = " local_side=%s pid=%d pname=%s" % (local_side, owner[0], owner[1]) if owner else ""
                    print(("udp src=%s dst=%s sport=%d dport=%d bytes=%d src=%s dst=%s sport=%d dport=%d bytes=%d" % (
                        original[0], original[1], original[2], original[3], byte_counter(top.get(9, b"")),
                        reply[0], reply[1], reply[2], reply[3], byte_counter(top.get(10, b"")))) + owner_suffix)
            offset += aligned(length)
    connection.close()

for address_family in (socket.AF_INET, socket.AF_INET6):
    try:
        dump(address_family)
    except Exception:
        pass`;

const HIGHSEAS_MONITOR_COMMAND = String.raw`/usr/local/sbin/highseas-monitor snapshot --json 2>/dev/null || /usr/local/bin/highseas-monitor snapshot --json 2>/dev/null || sudo -n /usr/local/sbin/highseas-monitor snapshot --json 2>/dev/null || true`;

const CONNTRACK_UDP_COMMAND = String.raw`if /usr/local/sbin/highseas-monitor snapshot --json >/dev/null 2>&1 || /usr/local/bin/highseas-monitor snapshot --json >/dev/null 2>&1; then
  :
else
ct_output="$(
  conntrack -L -p udp 2>/dev/null ||
  /usr/sbin/conntrack -L -p udp 2>/dev/null ||
  /sbin/conntrack -L -p udp 2>/dev/null ||
  sudo -n /usr/sbin/conntrack -L -p udp 2>/dev/null ||
  sudo -n /sbin/conntrack -L -p udp 2>/dev/null ||
  true
  (cat /proc/net/nf_conntrack /proc/net/ip_conntrack 2>/dev/null || sudo -n cat /proc/net/nf_conntrack /proc/net/ip_conntrack 2>/dev/null || true) | grep -w udp || true
)"
if [ -n "$ct_output" ]; then
  printf '%s\n' "$ct_output"
elif command -v python3 >/dev/null 2>&1; then
  python_runner="python3"
  [ "$(id -u)" = "0" ] || python_runner="sudo -n python3"
  $python_runner - <<'HIGHSEAS_NETLINK_PY'
${CONNTRACK_NETLINK_SCRIPT}
HIGHSEAS_NETLINK_PY
fi
fi`;

export const NETWORK_MONITOR_COMMAND = [
  "(ss -H -tulnp 2>/dev/null || netstat -tulnp 2>/dev/null || true)",
  "(ss -H -tnpi 2>/dev/null || netstat -tnp 2>/dev/null || true)",
  "(ss -H -uanpe 2>/dev/null || ss -H -unpa 2>/dev/null || netstat -unp 2>/dev/null || true)",
  CONNTRACK_UDP_COMMAND,
  "(printf '__HIGHSEAS_PROC_UDP4__\\n'; cat /proc/net/udp 2>/dev/null || true; printf '__HIGHSEAS_PROC_UDP6__\\n'; cat /proc/net/udp6 2>/dev/null || true)",
  `(${HIGHSEAS_MONITOR_COMMAND})`,
  "cat /proc/net/dev 2>/dev/null || true"
].map((command) => `{ ${command}; } 2>/dev/null; printf '\n---HIGHSEAS_SECTION---\n';`).join(" ");

export function mergeNetworkMonitorOutput(systemOutput: string, networkOutput: string) {
  const systemSections = systemOutput.split("---HIGHSEAS_SECTION---");
  const networkSections = networkOutput.split("---HIGHSEAS_SECTION---");
  systemSections[11] = networkSections[0] ?? "";
  systemSections[12] = networkSections[1] ?? "";
  systemSections[13] = networkSections[2] ?? "";
  systemSections[14] = networkSections[3] ?? "";
  systemSections[15] = networkSections[4] ?? "";
  systemSections[16] = networkSections[5] ?? "";
  systemSections[17] = networkSections[6] ?? "";
  return systemSections.join("---HIGHSEAS_SECTION---");
}

type ConnectionCounter = { sent: number; received: number };
export type ConnectionSnapshot = { timestamp: number; counters: Map<string, ConnectionCounter>; network?: ConnectionCounter };

type RawConnection = {
  protocol: string;
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

type UdpSocketOwner = {
  localIp: string;
  localPort: number;
  pid: number | null;
  processName: string;
  listening: boolean;
};

export function parseMonitorOutput(raw: string, previous: ConnectionSnapshot | null, now = Date.now()) {
  const sections = raw.split("---HIGHSEAS_SECTION---").map((section) => section.trim());
  if (sections.length < 13) return null;

  const listening = parseListeningPorts(sections[11]);
  const udpOwners = parseUdpSocketOwners(sections[13] ?? "", listening);
  const parsedConnections = dedupeConnections([
    ...parseHighseasMonitorConnections(sections[16] ?? ""),
    ...parseConnections(sections[12], "tcp"),
    ...parseConnections(sections[13] ?? "", "udp"),
    ...parseConntrackUdpConnections(sections[14] ?? "", udpOwners),
    ...parseProcUdpConnections(sections[15] ?? "")
  ]);
  const networkTotals = parseNetworkTotals(sections[17] || sections[3]);
  const snapshot = buildSnapshot(parsedConnections, now, networkTotals);
  applyConnectionRates(parsedConnections, previous, now);

  const metrics: ServerMetrics = {
    cpuPercent: parseCpuDelta(sections[0], sections[2]),
    network: parseNetworkRate(sections[1], sections[3], networkTotals, previous, now),
    memory: parseMeminfo(sections[4], "MemTotal", "MemAvailable"),
    swap: parseMeminfo(sections[4], "SwapTotal", "SwapFree"),
    disk: parseDf(sections[5]),
    uptimeSeconds: Number(sections[6].split(/\s+/)[0]) || 0,
    loadAverage: parseLoad(sections[7]),
    hostname: sections[8] || "-",
    kernel: sections[9] || "-",
    listeningPorts: aggregateListeningPorts(listening, parsedConnections),
    udpMonitorVersion: readMonitorVersion(sections[16] ?? ""),
    updatedAt: new Date(now).toISOString()
  };

  return { metrics, processes: parseProcesses(sections[10]), snapshot };
}

export async function enrichLocations(ports: ListeningPort[]) {
  const publicIps = [...new Set(ports.flatMap((port) => port.connectedIps.map((peer) => peer.ip)).filter((ip) => !isPrivateIp(ip)))];
  const locations = await lookupLocationsWithFallback(publicIps);
  for (const port of ports) {
    for (const peer of port.connectedIps) {
      peer.region = isPrivateIp(peer.ip) ? "局域网" : locations.get(peer.ip) ?? "";
    }
  }
}

export function applyCachedLocations(ports: ListeningPort[]) {
  for (const port of ports) for (const peer of port.connectedIps) {
    const cached = locationCache.get(peer.ip);
    peer.region = isPrivateIp(peer.ip) ? "局域网" : cached && cached.expiresAt > Date.now() ? cached.value : "";
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
  const before = parseNetworkTotals(first);
  const after = parseNetworkTotals(second);
  return {
    receiveBytesPerSecond: Math.max(0, after.received - before.received),
    transmitBytesPerSecond: Math.max(0, after.sent - before.sent)
  };
}

function parseNetworkTotals(value: string): ConnectionCounter {
  return value.split("\n").reduce((sum, line) => {
    const match = line.match(/^\s*([^:]+):\s*(.+)$/);
    if (!match || match[1].trim() === "lo") return sum;
    const fields = match[2].trim().split(/\s+/).map(Number);
    sum.received += fields[0] || 0;
    sum.sent += fields[8] || 0;
    return sum;
  }, { received: 0, sent: 0 });
}

function parseNetworkRate(first: string, second: string, current: ConnectionCounter, previous: ConnectionSnapshot | null, now: number) {
  if (!previous?.network) return parseNetworkDelta(first, second);
  const seconds = Math.max(0.5, (now - previous.timestamp) / 1000);
  return {
    receiveBytesPerSecond: Math.max(0, (current.received - previous.network.received) / seconds),
    transmitBytesPerSecond: Math.max(0, (current.sent - previous.network.sent) / seconds)
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

function parseConnections(raw: string, fallbackProtocol: "tcp" | "udp"): RawConnection[] {
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
    if (!local || !peer || !local.port || !peer.ip || isWildcardIp(peer.ip)) continue;
    const protocol = fields[0]?.startsWith("tcp") || fields[0]?.startsWith("udp")
      ? fields[0].replace(/\d+$/, "")
      : fallbackProtocol;
    const processText = line.match(/users:\(\(.+$/)?.[0] ?? fields.slice(5).join(" ");
    const pidText = processText.match(/pid=(\d+)/)?.[1] ?? processText.match(/(\d+)\/[^\s]+/)?.[1];
    const processName = processText.match(/\("([^"]+)"/)?.[1] ?? processText.match(/\d+\/([^\s]+)/)?.[1] ?? "";
    current = {
      protocol,
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

function parseUdpSocketOwners(raw: string, listening: ListeningPort[]): UdpSocketOwner[] {
  const owners: UdpSocketOwner[] = listening
    .filter((port) => baseProtocol(port.protocol) === "udp")
    .map((port) => ({
      localIp: normalizeIp(port.listenIp),
      localPort: port.listenPort,
      pid: port.pid,
      processName: port.processName === "-" ? "" : port.processName,
      listening: true
    }));

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    const endpoints = findEndpointPair(fields);
    const local = endpoints?.[0];
    const peer = endpoints?.[1];
    if (!local?.port) continue;
    const processText = line.match(/users:\(\(.+$/)?.[0] ?? fields.slice(5).join(" ");
    const pidText = processText.match(/pid=(\d+)/)?.[1] ?? processText.match(/(\d+)\/[^\s]+/)?.[1];
    const processName = processText.match(/\("([^"]+)"/)?.[1] ?? processText.match(/\d+\/([^\s]+)/)?.[1] ?? "";
    owners.push({
      localIp: normalizeIp(local.ip),
      localPort: local.port,
      pid: pidText ? Number(pidText) : null,
      processName,
      listening: Boolean(peer && isWildcardIp(peer.ip))
    });
  }

  const unique = new Map<string, UdpSocketOwner>();
  for (const owner of owners) {
    const key = `${owner.localIp}|${owner.localPort}|${owner.pid ?? "-"}`;
    const current = unique.get(key);
    if (!current || (!current.processName && owner.processName)) unique.set(key, owner);
  }
  return [...unique.values()];
}

function parseConntrackUdpConnections(raw: string, owners: UdpSocketOwner[]): RawConnection[] {
  const connections: RawConnection[] = [];
  for (const line of raw.split("\n")) {
    if (!/\budp\b/.test(line)) continue;
    const src = valuesForConntrackKey(line, "src");
    const dst = valuesForConntrackKey(line, "dst");
    const sport = valuesForConntrackKey(line, "sport").map(Number);
    const dport = valuesForConntrackKey(line, "dport").map(Number);
    const bytes = valuesForConntrackKey(line, "bytes").map(Number);
    if (!src[0] || !dst[0] || !sport[0] || !dport[0]) continue;
    const firstBytes = Number.isFinite(bytes[0]) ? bytes[0] : 0;
    const replyBytes = Number.isFinite(bytes[1]) ? bytes[1] : 0;
    const sourceOwner = findUdpSocketOwner(owners, src[0], sport[0]);
    const destinationOwner = findUdpSocketOwner(owners, dst[0], dport[0]);
    const trackedSide = valuesForConntrackKey(line, "local_side")[0];
    const trackedPid = Number(valuesForConntrackKey(line, "pid")[0]);
    const trackedProcessName = valuesForConntrackKey(line, "pname")[0] ?? "";
    const localIsSource = trackedSide === "src" || trackedSide === "dst"
      ? trackedSide === "src"
      : chooseConntrackLocalDirection(sourceOwner, destinationOwner, src[0], dst[0]);
    const owner = localIsSource ? sourceOwner : destinationOwner;
    const localIp = localIsSource ? src[0] : dst[0];
    const localPort = localIsSource ? sport[0] : dport[0];
    const peerIp = localIsSource ? dst[0] : src[0];
    const peerPort = localIsSource ? dport[0] : sport[0];

    connections.push({
      protocol: "udp",
      pid: owner?.pid ?? (Number.isSafeInteger(trackedPid) && trackedPid > 0 ? trackedPid : null),
      processName: owner?.processName || trackedProcessName || "udp connection",
      localIp: normalizeIp(localIp),
      localPort,
      peerIp: normalizeIp(peerIp),
      peerPort,
      sent: localIsSource ? firstBytes : replyBytes,
      received: localIsSource ? replyBytes : firstBytes,
      transmitRate: 0,
      receiveRate: 0
    });
  }
  return connections;
}

function findUdpSocketOwner(owners: UdpSocketOwner[], ip: string, port: number) {
  const normalizedIp = normalizeIp(ip);
  return owners
    .filter((owner) => owner.localPort === port)
    .map((owner) => ({ owner, score: socketOwnerScore(owner, normalizedIp) }))
    .sort((left, right) => right.score - left.score)[0]?.owner ?? null;
}

function socketOwnerScore(owner: UdpSocketOwner, ip: string) {
  let score = owner.pid === null ? 0 : 2;
  if (owner.localIp === ip) score += 6;
  else if (isWildcardIp(owner.localIp) && sameAddressFamily(owner.localIp, ip)) score += 4;
  else if (isWildcardIp(owner.localIp)) score += 1;
  if (!owner.listening) score += 1;
  return score;
}

function chooseConntrackLocalDirection(source: UdpSocketOwner | null, destination: UdpSocketOwner | null, sourceIp: string, destinationIp: string) {
  if (source && !destination) return true;
  if (destination && !source) return false;
  if (source && destination) {
    if (source.localIp === normalizeIp(sourceIp) && destination.localIp !== normalizeIp(destinationIp)) return true;
    if (destination.localIp === normalizeIp(destinationIp) && source.localIp !== normalizeIp(sourceIp)) return false;
    if (source.listening !== destination.listening) return !source.listening;
  }
  if (isPrivateIp(sourceIp) !== isPrivateIp(destinationIp)) return isPrivateIp(sourceIp);
  return true;
}

function parseProcUdpConnections(raw: string): RawConnection[] {
  const connections: RawConnection[] = [];
  let family: "udp4" | "udp6" = "udp4";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("sl")) continue;
    if (trimmed === "__HIGHSEAS_PROC_UDP4__") {
      family = "udp4";
      continue;
    }
    if (trimmed === "__HIGHSEAS_PROC_UDP6__") {
      family = "udp6";
      continue;
    }
    const fields = trimmed.split(/\s+/);
    const local = parseProcEndpoint(fields[1] ?? "", family);
    const peer = parseProcEndpoint(fields[2] ?? "", family);
    if (!local || !peer || !local.port || !peer.port || isWildcardIp(peer.ip)) continue;
    connections.push({
      protocol: "udp",
      pid: null,
      processName: "udp socket",
      localIp: normalizeIp(local.ip),
      localPort: local.port,
      peerIp: normalizeIp(peer.ip),
      peerPort: peer.port,
      sent: 0,
      received: 0,
      transmitRate: 0,
      receiveRate: 0
    });
  }
  return connections;
}

function readMonitorVersion(raw: string): string | undefined {
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data.connections) && typeof data.version === "string" && /^\d+\.\d+\.\d+$/.test(data.version) ? data.version : undefined;
  } catch { return undefined; }
}

function parseHighseasMonitorConnections(raw: string): RawConnection[] {
  if (!raw.trim()) return [];
  try {
    const snapshot = JSON.parse(raw) as {
      connections?: Array<{
        protocol?: unknown;
        pid?: unknown;
        processName?: unknown;
        localIp?: unknown;
        localPort?: unknown;
        peerIp?: unknown;
        peerPort?: unknown;
        sentBytes?: unknown;
        receivedBytes?: unknown;
        transmitBytesPerSecond?: unknown;
        receiveBytesPerSecond?: unknown;
      }>;
    };
    if (!Array.isArray(snapshot.connections)) return [];
    return snapshot.connections.flatMap((connection): RawConnection[] => {
      const localIp = typeof connection.localIp === "string" ? normalizeIp(connection.localIp) : "";
      const peerIp = typeof connection.peerIp === "string" ? normalizeIp(connection.peerIp) : "";
      const localPort = Number(connection.localPort);
      const peerPort = Number(connection.peerPort);
      const pid = Number(connection.pid);
      if (!localIp || !peerIp || isWildcardIp(peerIp) || !Number.isInteger(localPort) || localPort <= 0 || !Number.isInteger(peerPort) || peerPort <= 0) {
        return [];
      }
      return [{
        protocol: connection.protocol === "udp6" ? "udp6" : "udp",
        pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
        processName: typeof connection.processName === "string" ? connection.processName : "udp",
        localIp,
        localPort,
        peerIp,
        peerPort,
        sent: finiteCounter(connection.sentBytes),
        received: finiteCounter(connection.receivedBytes),
        transmitRate: finiteCounter(connection.transmitBytesPerSecond),
        receiveRate: finiteCounter(connection.receiveBytesPerSecond)
      }];
    });
  } catch {
    return [];
  }
}

function finiteCounter(value: unknown) {
  const counter = Number(value);
  return Number.isFinite(counter) && counter >= 0 ? counter : 0;
}

function parseProcEndpoint(value: string, family: "udp4" | "udp6") {
  const [ipHex, portHex] = value.split(":");
  const port = Number.parseInt(portHex ?? "", 16) || 0;
  const ip = family === "udp6" ? decodeProcIpv6(ipHex ?? "") : decodeProcIpv4(ipHex ?? "");
  return ip ? { ip, port } : null;
}

function decodeProcIpv4(hex: string) {
  if (!/^[0-9a-f]{8}$/i.test(hex)) return "";
  return (hex.match(/../g) ?? []).reverse().map((part) => Number.parseInt(part, 16)).join(".");
}

function decodeProcIpv6(hex: string) {
  if (!/^[0-9a-f]{32}$/i.test(hex)) return "";
  const bytes = hex.match(/../g) ?? [];
  const ordered = [];
  for (let index = 0; index < bytes.length; index += 4) ordered.push(...bytes.slice(index, index + 4).reverse());
  const groups = [];
  for (let index = 0; index < ordered.length; index += 2) groups.push(Number.parseInt(`${ordered[index]}${ordered[index + 1]}`, 16).toString(16));
  return compressIpv6(groups);
}

function compressIpv6(groups: string[]) {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== "0") {
      index += 1;
      continue;
    }
    const start = index;
    while (groups[index] === "0") index += 1;
    const length = index - start;
    if (length > bestLength) {
      bestStart = start;
      bestLength = length;
    }
  }
  if (bestLength < 2) return groups.join(":");
  const before = groups.slice(0, bestStart).join(":");
  const after = groups.slice(bestStart + bestLength).join(":");
  return `${before}::${after}`.replace(/^:/, "::").replace(/:$/, "::");
}

function valuesForConntrackKey(line: string, key: string) {
  return [...line.matchAll(new RegExp(`\\b${key}=([^\\s]+)`, "g"))].map((match) => match[1] ?? "");
}

function dedupeConnections(connections: RawConnection[]) {
  const byKey = new Map<string, RawConnection>();
  for (const connection of connections) {
    const key = connectionKey(connection);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, connection);
      continue;
    }
    byKey.set(key, {
      ...current,
      pid: current.pid ?? connection.pid,
      processName: current.processName || connection.processName,
      sent: Math.max(current.sent, connection.sent),
      received: Math.max(current.received, connection.received)
    });
  }
  return [...byKey.values()];
}

function findEndpointPair(fields: string[]) {
  for (let index = 0; index < fields.length - 1; index += 1) {
    const local = splitEndpoint(fields[index] ?? "");
    const peer = splitEndpoint(fields[index + 1] ?? "");
    if (local?.port && peer?.ip && isSocketAddress(local.ip) && isSocketAddress(peer.ip) && (peer.port || isWildcardIp(peer.ip))) {
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

function buildSnapshot(connections: RawConnection[], timestamp: number, network?: ConnectionCounter): ConnectionSnapshot {
  const counters = new Map<string, ConnectionCounter>();
  for (const connection of connections) counters.set(connectionKey(connection), { sent: connection.sent, received: connection.received });
  return { timestamp, counters, network };
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
  return `${baseProtocol(connection.protocol)}|${connection.localIp}|${connection.localPort}|${connection.peerIp}|${connection.peerPort}`;
}

function aggregateListeningPorts(ports: ListeningPort[], connections: RawConnection[]) {
  const buckets = ports.map((port) => ({ port, connections: [] as RawConnection[] }));
  for (const connection of connections) {
    const direct = buckets.filter(({ port }) => sameProtocol(port.protocol, connection.protocol) && port.listenPort === connection.localPort);
    const process = connection.pid === null ? [] : buckets.filter(({ port }) => sameProtocol(port.protocol, connection.protocol) && port.pid === connection.pid);
    const bucket = selectConnectionBucket(direct.length ? direct : process, connection);
    if (bucket) {
      bucket.connections.push(connection);
    } else {
      buckets.push({ port: {
        pid: connection.pid,
        processName: connection.processName || "active connection",
        protocol: baseProtocol(connection.protocol),
        listenIp: connection.localIp,
        listenPort: connection.localPort,
        ipCount: 0,
        connectionCount: 0,
        receiveBytesPerSecond: 0,
        transmitBytesPerSecond: 0,
        connectedIps: []
      }, connections: [connection] });
    }
  }
  return buckets.map(({ port, connections: matches }) => {
    const peers = new Map<string, ConnectedIp>();
    for (const connection of matches) {
      if (!connection.peerIp || isWildcardIp(connection.peerIp)) continue;
      const peer = peers.get(connection.peerIp) ?? {
        ip: connection.peerIp,
        ports: [],
        region: "",
        connectionCount: 0,
        receiveBytesPerSecond: 0,
        transmitBytesPerSecond: 0
      };
      if (connection.peerPort && !peer.ports.includes(connection.peerPort)) peer.ports.push(connection.peerPort);
      peer.connectionCount += 1;
      peer.receiveBytesPerSecond += connection.receiveRate;
      peer.transmitBytesPerSecond += connection.transmitRate;
      peers.set(connection.peerIp, peer);
    }
    const connectedIps = [...peers.values()]
      .map((peer) => ({ ...peer, ports: peer.ports.sort((a, b) => a - b) }))
      .sort((a, b) => b.receiveBytesPerSecond + b.transmitBytesPerSecond - a.receiveBytesPerSecond - a.transmitBytesPerSecond || b.connectionCount - a.connectionCount);
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

function selectConnectionBucket(buckets: Array<{ port: ListeningPort; connections: RawConnection[] }>, connection: RawConnection) {
  return buckets
    .map((bucket) => ({ bucket, score: listeningPortScore(bucket.port, connection) }))
    .sort((left, right) => right.score - left.score || left.bucket.port.listenPort - right.bucket.port.listenPort)[0]?.bucket ?? null;
}

function listeningPortScore(port: ListeningPort, connection: RawConnection) {
  let score = port.listenPort === connection.localPort ? 8 : 0;
  if (port.pid !== null && port.pid === connection.pid) score += 4;
  const listenIp = normalizeIp(port.listenIp);
  if (listenIp === connection.localIp) score += 4;
  else if (isWildcardIp(listenIp) && sameAddressFamily(listenIp, connection.localIp)) score += 2;
  return score;
}

function baseProtocol(protocol: string) {
  return protocol.toLowerCase().startsWith("udp") ? "udp" : "tcp";
}

function sameProtocol(left: string, right: string) {
  return baseProtocol(left) === baseProtocol(right);
}

function normalizeIp(ip: string) {
  return ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : ip;
}

function sameAddressFamily(left: string, right: string) {
  const normalizedLeft = normalizeIp(left);
  const normalizedRight = normalizeIp(right);
  if (normalizedLeft === "*" || normalizedRight === "*") return true;
  const leftIsV6 = normalizedLeft.includes(":") && normalizedLeft !== "*";
  const rightIsV6 = normalizedRight.includes(":") && normalizedRight !== "*";
  return leftIsV6 === rightIsV6;
}

function isWildcardIp(ip: string) {
  return ["*", "0.0.0.0", "::"].includes(normalizeIp(ip));
}

function isPrivateIp(ip: string) {
  const value = normalizeIp(ip).toLowerCase();
  return value === "::1" || value === "127.0.0.1" || value.startsWith("10.") || value.startsWith("192.168.")
    || /^172\.(1[6-9]|2\d|3[01])\./.test(value) || value.startsWith("169.254.") || value.startsWith("fe80:")
    || value.startsWith("fc") || value.startsWith("fd");
}

const LOCATION_TTL = 24 * 60 * 60 * 1000;
const LOCATION_FAILURE_TTL = 15 * 1000;
const locationCache = new Map<string, { value: string; expiresAt: number }>();

async function lookupLocationsWithFallback(ips: string[]) {
  const result = new Map<string, string>();
  const missing: string[] = [];
  for (const ip of ips) {
    const cached = locationCache.get(ip);
    if (cached && cached.expiresAt > Date.now()) result.set(ip, cached.value);
    else missing.push(ip);
  }

  await lookupWithIpApi(missing.slice(0, 100), result);
  const unresolved = missing.filter((ip) => !result.has(ip)).slice(0, 8);
  // Bound provider concurrency and leave unattempted IPs pending for the next sample.
  for (let offset = 0; offset < unresolved.length; offset += 4) {
    await Promise.allSettled(unresolved.slice(offset, offset + 4).map((ip) => lookupWithIpWho(ip, result)));
  }

  for (const ip of unresolved) {
    if (result.has(ip)) continue;
    cacheLocation(ip, "未知", LOCATION_FAILURE_TTL);
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
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) return;
    const rows = await response.json<Array<{ status: string; query: string; country?: string; regionName?: string; city?: string; isp?: string; org?: string }>>();
    for (const row of rows) {
      if (row.status !== "success" || !ips.includes(row.query)) continue;
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
      signal: AbortSignal.timeout(2500)
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
  cacheLocation(ip, label, label === "未知" ? LOCATION_FAILURE_TTL : LOCATION_TTL);
  result.set(ip, label);
}

function cacheLocation(ip: string, value: string, ttl: number) {
  locationCache.delete(ip);
  locationCache.set(ip, { value, expiresAt: Date.now() + ttl });
  while (locationCache.size > 4096) locationCache.delete(locationCache.keys().next().value!);
}
