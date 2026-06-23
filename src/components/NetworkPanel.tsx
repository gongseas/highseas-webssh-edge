import { ChevronDown, ChevronRight, Network, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import type { Language, ListeningPort } from "../../shared/types";

type Props = { ports: ListeningPort[]; language: Language; connected: boolean; updatedAt?: string };
const DEFAULT_MAIN_WIDTHS = [28, 62, 165, 58, 145, 68, 52, 60, 98, 98];
const MIN_MAIN_WIDTHS = [24, 52, 100, 52, 100, 58, 46, 54, 76, 76];
const DEFAULT_PEER_WIDTHS = [160, 420, 60, 80, 80];
const MIN_PEER_WIDTHS = [130, 220, 54, 70, 70];

export function NetworkPanel({ ports, language, connected, updatedAt }: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [mainWidths, setMainWidths] = useState(() => loadWidths("highseas.network.mainWidths", DEFAULT_MAIN_WIDTHS, MIN_MAIN_WIDTHS));
  const [peerWidths, setPeerWidths] = useState(() => loadWidths("highseas.network.peerWidths", DEFAULT_PEER_WIDTHS, MIN_PEER_WIDTHS));
  const isZh = language === "zh";
  const mainGridStyle = gridStyle(mainWidths);
  const peerGridStyle = gridStyle(peerWidths);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return ports;
    return ports.filter((port) => [
      port.pid, port.processName, port.protocol, port.listenIp, port.listenPort,
      ...port.connectedIps.flatMap((peer) => [peer.ip, peer.region])
    ].some((value) => String(value ?? "").toLowerCase().includes(keyword)));
  }, [ports, query]);
  useEffect(() => { window.localStorage.setItem("highseas.network.mainWidths", JSON.stringify(mainWidths)); }, [mainWidths]);
  useEffect(() => { window.localStorage.setItem("highseas.network.peerWidths", JSON.stringify(peerWidths)); }, [peerWidths]);

  function toggle(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

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

  const mainHeaders = ["", "PID", isZh ? "进程" : "Process", isZh ? "协议" : "Proto", isZh ? "监听 IP" : "Listen IP", isZh ? "端口" : "Port", "IP", isZh ? "连接" : "Conn", isZh ? "下行" : "Down", isZh ? "上行" : "Up"];
  const peerHeaders = [isZh ? "连接 IP" : "Remote IP", isZh ? "归属地 / 运营商" : "Location / ISP", isZh ? "连接" : "Conn", isZh ? "下行" : "Down", isZh ? "上行" : "Up"];

  return <section className="network-panel tool-panel">
    <div className="tool-panel-bar">
      <span><Network size={15} />{isZh ? "网络连接" : "Network connections"}{updatedAt ? <small className="sample-time">{new Date(updatedAt).toLocaleTimeString()}</small> : null}</span>
      <label className="compact-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={isZh ? "搜索端口、进程或 IP" : "Search port, process or IP"} /></label>
    </div>
    <div className="data-table network-table">
      <div className="data-row data-head network-row resizable-head" style={mainGridStyle}>
        {mainHeaders.map((label, index) => <span key={`${label}-${index}`}><b>{label}</b>{index < mainHeaders.length - 1 ? <i role="separator" aria-orientation="vertical" title={isZh ? "拖动调整列宽，双击恢复" : "Drag to resize; double-click to reset"} onPointerDown={(event) => beginResize(event, index, mainWidths, MIN_MAIN_WIDTHS, setMainWidths)} onDoubleClick={() => setMainWidths(DEFAULT_MAIN_WIDTHS)} /> : null}</span>)}
      </div>
      {filtered.map((port, index) => {
        const key = `${port.protocol}:${port.listenIp}:${port.listenPort}:${port.pid ?? index}`;
        const open = port.connectedIps.length > 0 && !collapsed.has(key);
        return <div className="network-entry" key={key} style={{ width: mainGridStyle.width }}>
          <button className="data-row network-row network-main-row" style={mainGridStyle} onClick={() => toggle(key)} type="button">
            <span>{port.connectedIps.length ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}</span>
            <span>{port.pid ?? "-"}</span><span title={port.processName}>{port.processName}</span><span>{port.protocol.toUpperCase()}</span><span title={port.listenIp}>{port.listenIp}</span><span>{port.listenPort}</span><span>{port.ipCount}</span><span>{port.connectionCount}</span><span>{formatRate(port.receiveBytesPerSecond)}</span><span>{formatRate(port.transmitBytesPerSecond)}</span>
          </button>
          {open ? <div className="peer-table" style={{ width: peerGridStyle.width }}>
            <div className="data-row peer-row data-head resizable-head" style={peerGridStyle}>{peerHeaders.map((label, column) => <span key={label}><b>{label}</b>{column < peerHeaders.length - 1 ? <i role="separator" aria-orientation="vertical" title={isZh ? "拖动调整列宽，双击恢复" : "Drag to resize; double-click to reset"} onPointerDown={(event) => beginResize(event, column, peerWidths, MIN_PEER_WIDTHS, setPeerWidths)} onDoubleClick={() => setPeerWidths(DEFAULT_PEER_WIDTHS)} /> : null}</span>)}</div>
            {port.connectedIps.map((peer) => <div className="data-row peer-row" style={peerGridStyle} key={peer.ip}><span>{peer.ip}</span><span title={peer.region}>{peer.region || (isZh ? "查询中" : "Resolving")}</span><span>{peer.connectionCount}</span><span>{formatRate(peer.receiveBytesPerSecond)}</span><span>{formatRate(peer.transmitBytesPerSecond)}</span></div>)}
          </div> : null}
        </div>;
      })}
      {!filtered.length ? <div className="empty-table network-empty">{connected
        ? (isZh ? "等待网络采样；若持续为空，请确认服务器已安装 iproute2（ss 命令）" : "Waiting for network sampling; install iproute2 if this remains empty")
        : (isZh ? "SSH 尚未连接，无法读取监听端口、连接 IP、归属地和流量" : "SSH is not connected, so network details are unavailable")}</div> : null}
    </div>
  </section>;
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
