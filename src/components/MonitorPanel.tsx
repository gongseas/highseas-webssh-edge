import { Activity, Cpu, HardDrive, MemoryStick, Network, Server } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { Language, ProcessInfo, ServerMetrics } from "../../shared/types";
import { formatRate } from "./NetworkPanel";

type Props = { metrics?: ServerMetrics; processes: ProcessInfo[]; language: Language };

export function MonitorPanel({ metrics, processes, language }: Props) {
  const isZh = language === "zh";
  const [networkHistory, setNetworkHistory] = useState<Array<{ at: string; receive: number; transmit: number }>>([]);
  useEffect(() => {
    if (!metrics?.network || !metrics.updatedAt) return;
    setNetworkHistory((current) => {
      if (current.at(-1)?.at === metrics.updatedAt) return current;
      return [...current, { at: metrics.updatedAt, receive: metrics.network?.receiveBytesPerSecond ?? 0, transmit: metrics.network?.transmitBytesPerSecond ?? 0 }].slice(-24);
    });
  }, [metrics?.network, metrics?.updatedAt]);
  const networkScale = useMemo(() => Math.max(1024, ...networkHistory.flatMap((point) => [point.receive, point.transmit])), [networkHistory]);
  return <aside className="monitor-panel">
    <div className="sync-line"><span>{isZh ? "同步状态" : "Sync status"}</span><i className={metrics ? "online-dot" : ""} /></div>
    <div className="host-address"><b>IP</b><span>{metrics?.hostname || (isZh ? "等待连接" : "Waiting")}</span></div>
    <button className="system-info-title" type="button"><Server size={14} />{isZh ? "系统信息" : "System info"}</button>
    <div className="system-copy"><span>{isZh ? "运行" : "Uptime"} {formatUptime(metrics?.uptimeSeconds ?? 0)}</span><span>{isZh ? "负载" : "Load"} {metrics?.loadAverage.map((value) => value.toFixed(2)).join(", ") || "0, 0, 0"}</span><small title={metrics?.kernel}>{metrics?.kernel || "-"}</small></div>
    <MetricRow icon={<Cpu size={14} />} label="CPU" percent={metrics?.cpuPercent ?? 0} detail={`${metrics?.cpuPercent ?? 0}%`} />
    <MetricRow icon={<MemoryStick size={14} />} label={isZh ? "内存" : "Memory"} percent={metrics?.memory.percent ?? 0} detail={formatUsage(metrics?.memory)} tone="warm" />
    <MetricRow icon={<MemoryStick size={14} />} label="Swap" percent={metrics?.swap.percent ?? 0} detail={formatUsage(metrics?.swap)} />
    <div className="mini-process-table">
      <div><span>{isZh ? "内存" : "MEM"}</span><span>CPU</span><span>{isZh ? "命令" : "Command"}</span></div>
      {processes.slice(0, 5).map((process) => <div key={process.pid}><span>{process.memory.toFixed(1)}%</span><span>{process.cpu.toFixed(1)}</span><span title={process.command}>{process.command}</span></div>)}
    </div>
    <div className="sidebar-network"><Network size={14} /><b className="down">↓ {formatRate(metrics?.network?.receiveBytesPerSecond ?? 0)}</b><b className="up">↑ {formatRate(metrics?.network?.transmitBytesPerSecond ?? 0)}</b></div>
    <div className="sidebar-graph" aria-label={isZh ? "实时网络速率趋势" : "Live network throughput history"}>{networkHistory.map((point) => <i key={point.at} title={`${formatRate(point.receive)} / ${formatRate(point.transmit)}`}><span className="receive" style={{ height: `${Math.max(2, point.receive / networkScale * 100)}%` }} /><span className="transmit" style={{ height: `${Math.max(2, point.transmit / networkScale * 100)}%` }} /></i>)}</div>
    <div className="disk-summary"><span><HardDrive size={14} /> /</span><b>{formatUsage(metrics?.disk)}</b></div>
    <MetricRow icon={<Activity size={14} />} label={isZh ? "磁盘" : "Disk"} percent={metrics?.disk.percent ?? 0} detail={`${metrics?.disk.percent ?? 0}%`} />
  </aside>;
}

function MetricRow({ icon, label, percent, detail, tone }: { icon: ReactNode; label: string; percent: number; detail: string; tone?: "warm" }) {
  return <div className={`metric-row ${tone ?? ""}`}><div className="metric-head"><span>{icon}{label}</span><small>{detail}</small></div><div className="meter"><span style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }} /></div></div>;
}

function formatUsage(stat?: { used: number; total: number; percent: number }) {
  if (!stat) return "0 / 0 GB";
  return `${stat.used} / ${stat.total} GB`;
}

function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days}d ${hours}h`;
}
