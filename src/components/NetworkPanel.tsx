import { ChevronDown, ChevronRight, CornerDownRight, Network, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { CSSProperties, Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import type { ConnectedIp, Language, ListeningPort } from "../../shared/types";

type NetworkRate = { receiveBytesPerSecond: number; transmitBytesPerSecond: number };
type Props = { ports: ListeningPort[]; language: Language; connected: boolean; updatedAt?: string; interfaceRate?: NetworkRate; udpMonitorVersion?: string };
export type NetworkProcessGroup = { key: string; pid: number | null; processName: string; ports: ListeningPort[]; summary: ListeningPort };

const DEFAULT_MAIN_WIDTHS = [86, 180, 78, 150, 76, 62, 72, 94, 94];
const MIN_MAIN_WIDTHS = [66, 110, 62, 100, 62, 52, 58, 76, 76];
const DEFAULT_PEER_WIDTHS = [300, 190, 92, 72, 100, 100];
const MIN_PEER_WIDTHS = [180, 130, 66, 58, 76, 76];

export function NetworkPanel({ ports, language, connected, updatedAt, interfaceRate, udpMonitorVersion }: Props) {
  const [query, setQuery] = useState("");
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const check = () => setStale(!connected || Boolean(updatedAt && Date.now() - Date.parse(updatedAt) > 20_000));
    check();
    const timer = window.setInterval(check, 5_000);
    return () => window.clearInterval(timer);
  }, [connected, updatedAt]);
  const [protocol, setProtocol] = useState("all");
  const [sort, setSort] = useState("pid");
  const [split, setSplit] = useState(58);
  const [selectedKey, setSelectedKey] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [mainWidths, setMainWidths] = useState(() => loadWidths("highseas.network.mainWidths", DEFAULT_MAIN_WIDTHS, MIN_MAIN_WIDTHS));
  const [peerWidths, setPeerWidths] = useState(() => loadWidths("highseas.network.peerWidths", DEFAULT_PEER_WIDTHS, MIN_PEER_WIDTHS));
  const isZh = language === "zh";
  const mainGridStyle = gridStyle(mainWidths);
  const peerGridStyle = gridStyle(peerWidths);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return ports.filter(port => protocol === "all" || baseProtocol(port.protocol) === protocol).filter((port) => !keyword || [
      port.pid, port.processName, port.protocol, port.listenIp, port.listenPort,
      ...port.connectedIps.flatMap((peer) => [peer.ip, peer.region, ...peer.ports])
    ].some((value) => String(value ?? "").toLowerCase().includes(keyword)));
  }, [ports, query, protocol]);
  const groups = useMemo(() => groupNetworkPorts(filtered).sort((a, b) => {
    const unknown = Number(a.pid === null) - Number(b.pid === null);
    if (unknown) return unknown;
    if (sort === "up") return b.summary.transmitBytesPerSecond - a.summary.transmitBytesPerSecond;
    if (sort === "down") return b.summary.receiveBytesPerSecond - a.summary.receiveBytesPerSecond;
    if (sort === "connections") return b.summary.connectionCount - a.summary.connectionCount;
    return (a.pid ?? 0) - (b.pid ?? 0);
  }), [filtered, sort]);
  const trackedRate = useMemo(() => ({
    transmitBytesPerSecond: ports.reduce((sum, port) => sum + port.transmitBytesPerSecond, 0),
    receiveBytesPerSecond: ports.reduce((sum, port) => sum + port.receiveBytesPerSecond, 0)
  }), [ports]);

  useEffect(() => { window.localStorage.setItem("highseas.network.mainWidths", JSON.stringify(mainWidths)); }, [mainWidths]);
  useEffect(() => { window.localStorage.setItem("highseas.network.peerWidths", JSON.stringify(peerWidths)); }, [peerWidths]);
  useEffect(() => {
    if (groups.some((group) => groupSelectionKey(group) === selectedKey || group.ports.some((port) => portSelectionKey(group, port) === selectedKey))) return;
    const next = groups.find((group) => group.pid !== null && group.summary.connectedIps.length > 0)
      ?? groups.find((group) => group.summary.connectedIps.length > 0)
      ?? groups[0];
    setSelectedKey(next ? groupSelectionKey(next) : "");
  }, [groups, selectedKey]);

  const selectedGroup = groups.find((group) => groupSelectionKey(group) === selectedKey);
  const selectedChild = groups.flatMap((group) => group.ports.map((port) => ({ group, port }))).find(({ group, port }) => portSelectionKey(group, port) === selectedKey);
  const selectedPort = selectedGroup?.summary ?? selectedChild?.port ?? null;
  const selectedLabel = selectedGroup
    ? `${selectedGroup.pid === null ? "" : `${selectedGroup.pid} - `}${displayProcessName(selectedGroup, isZh)} · ${isZh ? "全部连接" : "All connections"}`
    : selectedChild ? `${selectedChild.port.pid ?? "-"} - ${selectedChild.port.processName} · ${selectedChild.port.protocol.toUpperCase()}:${selectedChild.port.listenPort || "-"}` : "";

  function beginResize(event: ReactPointerEvent<HTMLElement>, index: number, widths: number[], minimums: number[], update: Dispatch<SetStateAction<number[]>>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widths[index] ?? minimums[index] ?? 40;
    document.body.classList.add("is-resizing", "is-resizing-columns");
    const move = (nextEvent: PointerEvent) => {
      const nextWidth = Math.max(minimums[index] ?? 40, Math.round(startWidth + nextEvent.clientX - startX));
      update((current) => current.map((width, column) => column === index ? nextWidth : width));
    };
    const stop = () => {
      document.body.classList.remove("is-resizing", "is-resizing-columns");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function toggleGroup(group: NetworkProcessGroup) {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(group.key)) next.delete(group.key);
      else next.add(group.key);
      return next;
    });
    setSelectedKey(groupSelectionKey(group));
  }

  const mainHeaders = ["PID", isZh ? "名称" : "Process", isZh ? "协议" : "Proto", isZh ? "监听 IP" : "Listen IP", isZh ? "端口" : "Port", isZh ? "IP 数" : "IPs", isZh ? "连接数" : "Conn", isZh ? "上行" : "Up", isZh ? "下行" : "Down"];
  const peerHeaders = [isZh ? "归属地 / 运营商" : "Location / ISP", isZh ? "连接 IP" : "Remote IP", isZh ? "端口" : "Port", isZh ? "连接数" : "Conn", isZh ? "上行" : "Up", isZh ? "下行" : "Down"];

  return <section className="network-panel tool-panel">
    <div className="tool-panel-bar">
      <span><Network size={15} />{isZh ? "网络连接" : "Network connections"}{updatedAt ? <small className="sample-time">{new Date(updatedAt).toLocaleTimeString()}</small> : null}
        <small className="network-rate-audit"><b>{isZh ? "总" : "Total"}</b> ↑{formatRate(interfaceRate?.transmitBytesPerSecond ?? 0)} ↓{formatRate(interfaceRate?.receiveBytesPerSecond ?? 0)}<i /><b>{isZh ? "连接" : "Flows"}</b> ↑{formatRate(trackedRate.transmitBytesPerSecond)} ↓{formatRate(trackedRate.receiveBytesPerSecond)}</small>
      </span>
      <div className="network-controls">
        {stale ? <small className="network-stale" role="status">{connected ? (isZh ? "数据未更新" : "Data stale") : (isZh ? "已断开" : "Disconnected")}</small> : null}
        <small className="udp-source" title={udpMonitorVersion ? (isZh ? "UDP 采集器已连接" : "UDP collector connected") : (isZh ? "未读到采集器，仅显示系统可提供的 UDP 数据" : "Collector unavailable; system UDP data only")}>{udpMonitorVersion ? `UDP v${udpMonitorVersion}` : (isZh ? "UDP 系统采样" : "UDP system")}</small>
        <div className="protocol-switch" role="group" aria-label={isZh ? "协议筛选" : "Protocol filter"}>{["all", "tcp", "udp"].map(value => <button key={value} type="button" aria-pressed={protocol === value} onClick={() => setProtocol(value)}>{value === "all" ? (isZh ? "全部" : "All") : value.toUpperCase()}</button>)}</div>
        <select aria-label={isZh ? "排序" : "Sort"} value={sort} onChange={event => setSort(event.target.value)}><option value="pid">PID</option><option value="connections">{isZh ? "连接数" : "Connections"}</option><option value="up">{isZh ? "上行速率" : "Upload"}</option><option value="down">{isZh ? "下行速率" : "Download"}</option></select>
        <label className="compact-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={isZh ? "搜索端口、进程或 IP" : "Search port, process or IP"} /></label>
      </div>
    </div>
    <div className="data-table network-table" style={{ gridTemplateRows: `minmax(60px, ${split}fr) 6px minmax(60px, ${100 - split}fr)` }}>
      <div className="network-summary">
        <div className="data-row data-head network-row resizable-head" style={mainGridStyle}>
          {mainHeaders.map((label, index) => <span key={`${label}-${index}`}><b>{label}</b>{index < mainHeaders.length - 1 ? <i role="separator" aria-orientation="vertical" title={isZh ? "拖动调整列宽，双击恢复" : "Drag to resize; double-click to reset"} onPointerDown={(event) => beginResize(event, index, mainWidths, MIN_MAIN_WIDTHS, setMainWidths)} onDoubleClick={() => setMainWidths(DEFAULT_MAIN_WIDTHS)} /> : null}</span>)}
        </div>
        {groups.map((group) => {
          const groupKey = groupSelectionKey(group);
          const expanded = expandedKeys.has(group.key) || Boolean(query.trim());
          const addresses = [...new Set(group.ports.map((port) => port.listenIp))];
          return <Fragment key={group.key}>
            <button className={`data-row network-row network-main-row network-group-row${selectedKey === groupKey ? " selected" : ""}`} style={mainGridStyle} onClick={() => toggleGroup(group)} type="button" aria-expanded={expanded}>
              <span className="network-group-pid">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{group.pid ?? "-"}</span>
              <span title={displayProcessName(group, isZh)}>{displayProcessName(group, isZh)}</span>
              <span>{group.summary.protocol.toUpperCase()}</span>
              <span title={addresses.join(", ")}>{addresses.length === 1 ? addresses[0] : (isZh ? `${addresses.length} 个地址` : `${addresses.length} addresses`)}</span>
              <span>{group.ports.length === 1 ? (group.ports[0].listenPort || "-") : (isZh ? `${group.ports.length} 个` : `${group.ports.length}`)}</span>
              <span>{group.summary.ipCount}</span><span>{group.summary.connectionCount}</span><span>{formatRate(group.summary.transmitBytesPerSecond)}</span><span>{formatRate(group.summary.receiveBytesPerSecond)}</span>
            </button>
            {expanded ? group.ports.map((port) => {
              const childKey = portSelectionKey(group, port);
              return <button className={`data-row network-row network-main-row network-child-row${selectedKey === childKey ? " selected" : ""}`} style={mainGridStyle} onClick={() => setSelectedKey(childKey)} type="button" key={childKey}>
                <span /><span title={port.processName}><CornerDownRight size={13} />{port.processName}</span><span>{port.protocol.toUpperCase()}</span><span title={port.listenIp}>{port.listenIp}</span><span>{port.listenPort || "-"}</span><span>{port.ipCount}</span><span>{port.connectionCount}</span><span>{formatRate(port.transmitBytesPerSecond)}</span><span>{formatRate(port.receiveBytesPerSecond)}</span>
              </button>;
            }) : null}
          </Fragment>;
        })}
        {!groups.length ? <div className="empty-table network-empty">{connected
          ? (isZh ? "等待网络采样；若持续为空，请确认服务器已安装 iproute2（ss 命令）" : "Waiting for network sampling; install iproute2 if this remains empty")
          : (isZh ? "SSH 尚未连接，无法读取监听端口、连接 IP、归属地和流量" : "SSH is not connected, so network details are unavailable")}</div> : null}
      </div>
      <div className="splitter splitter-horizontal network-divider" role="separator" tabIndex={0} aria-orientation="horizontal" aria-valuenow={split} aria-valuemin={20} aria-valuemax={80} aria-label={isZh ? "调整连接详情高度" : "Resize connection details"}
        onKeyDown={event => { if (["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); setSplit(value => Math.min(80, Math.max(20, value + (event.key === "ArrowUp" ? -5 : 5)))); } }}
        onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = event.currentTarget.parentElement!.getBoundingClientRect(); setSplit(Math.min(80, Math.max(20, (event.clientY - bounds.top) / bounds.height * 100))); }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
      <div className="network-detail">
        <div className="network-detail-tab">{selectedPort ? selectedLabel : (isZh ? "连接详情" : "Connection details")}</div>
        {selectedPort?.connectedIps.length ? <div className="peer-table" style={{ width: peerGridStyle.width }}>
          <div className="data-row peer-row data-head resizable-head" style={peerGridStyle}>{peerHeaders.map((label, column) => <span key={label}><b>{label}</b>{column < peerHeaders.length - 1 ? <i role="separator" aria-orientation="vertical" title={isZh ? "拖动调整列宽，双击恢复" : "Drag to resize; double-click to reset"} onPointerDown={(event) => beginResize(event, column, peerWidths, MIN_PEER_WIDTHS, setPeerWidths)} onDoubleClick={() => setPeerWidths(DEFAULT_PEER_WIDTHS)} /> : null}</span>)}</div>
          {selectedPort.connectedIps.map((peer) => <div className="data-row peer-row" style={peerGridStyle} key={peer.ip}><span title={peer.region}>{peer.region || (isZh ? "查询中" : "Resolving")}</span><span>{peer.ip}</span><span title={peer.ports.join(", ")}>{peer.ports.join(", ") || "-"}</span><span>{peer.connectionCount}</span><span>{formatRate(peer.transmitBytesPerSecond)}</span><span>{formatRate(peer.receiveBytesPerSecond)}</span></div>)}
        </div> : <div className="network-detail-empty">{selectedPort
          ? (selectedPort.protocol.toLowerCase().includes("udp")
            ? (isZh ? "当前未采集到 UDP 对端；活动流量出现后会显示 IP、端口和归属地" : "No UDP peer sampled yet; IP, port and location appear when traffic is active")
            : (isZh ? "当前没有活动连接" : "No active connections"))
          : (isZh ? "选择上方项目查看连接详情" : "Select an item above to view details")}</div>}
      </div>
    </div>
  </section>;
}

export function groupNetworkPorts(ports: ListeningPort[]): NetworkProcessGroup[] {
  const grouped = new Map<string, ListeningPort[]>();
  for (const port of ports) {
    const key = port.pid !== null ? `pid:${port.pid}` : `unresolved:${baseProtocol(port.protocol)}:${normalizedProcessName(port.processName)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), port]);
  }
  return [...grouped.entries()].map(([key, processPorts]) => {
    const sortedPorts = [...processPorts].sort((left, right) => baseProtocol(left.protocol).localeCompare(baseProtocol(right.protocol)) || left.listenPort - right.listenPort);
    const named = sortedPorts.find((port) => !isGenericProcessName(port.processName));
    const processName = named?.processName ?? sortedPorts[0]?.processName ?? "-";
    return { key, pid: sortedPorts[0]?.pid ?? null, processName, ports: sortedPorts, summary: summarizePorts(sortedPorts, processName) };
  }).sort((left, right) => Number(left.pid === null) - Number(right.pid === null)
    || right.summary.connectionCount - left.summary.connectionCount
    || right.summary.transmitBytesPerSecond + right.summary.receiveBytesPerSecond - left.summary.transmitBytesPerSecond - left.summary.receiveBytesPerSecond
    || (left.pid ?? Number.MAX_SAFE_INTEGER) - (right.pid ?? Number.MAX_SAFE_INTEGER));
}

function summarizePorts(ports: ListeningPort[], processName: string): ListeningPort {
  const peers = new Map<string, ConnectedIp>();
  for (const port of ports) {
    for (const current of port.connectedIps) {
      const peer = peers.get(current.ip) ?? { ip: current.ip, ports: [], region: current.region, connectionCount: 0, receiveBytesPerSecond: 0, transmitBytesPerSecond: 0 };
      for (const remotePort of current.ports) if (!peer.ports.includes(remotePort)) peer.ports.push(remotePort);
      if (!peer.region && current.region) peer.region = current.region;
      peer.connectionCount += current.connectionCount;
      peer.receiveBytesPerSecond += current.receiveBytesPerSecond;
      peer.transmitBytesPerSecond += current.transmitBytesPerSecond;
      peers.set(current.ip, peer);
    }
  }
  const protocols = [...new Set(ports.map((port) => baseProtocol(port.protocol)))];
  const connectedIps = [...peers.values()].map((peer) => ({ ...peer, ports: peer.ports.sort((left, right) => left - right) }))
    .sort((left, right) => right.receiveBytesPerSecond + right.transmitBytesPerSecond - left.receiveBytesPerSecond - left.transmitBytesPerSecond || right.connectionCount - left.connectionCount);
  return {
    pid: ports[0]?.pid ?? null,
    processName,
    protocol: protocols.join("/"),
    listenIp: ports[0]?.listenIp ?? "-",
    listenPort: ports.length === 1 ? ports[0].listenPort : 0,
    ipCount: connectedIps.length,
    connectionCount: ports.reduce((sum, port) => sum + port.connectionCount, 0),
    receiveBytesPerSecond: ports.reduce((sum, port) => sum + port.receiveBytesPerSecond, 0),
    transmitBytesPerSecond: ports.reduce((sum, port) => sum + port.transmitBytesPerSecond, 0),
    connectedIps
  };
}

function displayProcessName(group: NetworkProcessGroup, isZh: boolean) {
  if (group.pid === null && isGenericProcessName(group.processName)) return `${isZh ? "未识别" : "Unresolved"} ${group.summary.protocol.toUpperCase()}`;
  return group.processName;
}

function isGenericProcessName(name: string) {
  return ["", "-", "udp", "udp connection", "udp socket", "active connection"].includes(normalizedProcessName(name));
}

function normalizedProcessName(name: string) {
  return name.trim().toLowerCase();
}

function baseProtocol(protocol: string) {
  return protocol.toLowerCase().startsWith("udp") ? "udp" : "tcp";
}

function groupSelectionKey(group: NetworkProcessGroup) {
  return `group:${group.key}`;
}

function portSelectionKey(group: NetworkProcessGroup, port: ListeningPort) {
  return `port:${group.key}:${port.protocol}:${port.listenIp}:${port.listenPort}:${port.processName}`;
}

function gridStyle(widths: number[]): CSSProperties {
  return { gridTemplateColumns: widths.map((width) => `${width}px`).join(" "), width: `${widths.reduce((sum, width) => sum + width, 0)}px` };
}

function loadWidths(key: string, defaults: number[], minimums: number[]) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(key) ?? "null") as unknown;
    if (Array.isArray(stored) && stored.length === defaults.length && stored.every((width, index) => typeof width === "number" && Number.isFinite(width) && width >= (minimums[index] ?? 0))) return stored;
  } catch { /* Ignore invalid local preferences. */ }
  return defaults;
}

export function formatRate(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 B/s";
  if (bytes < 1024) return `${Math.round(bytes)} B/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
}
