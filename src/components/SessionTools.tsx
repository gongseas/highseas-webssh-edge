import { Clock3, FileText, ListTree, Network, TerminalSquare, Maximize2, Minimize2 } from "lucide-react";
import { useState } from "react";
import type { AppSettings, ProcessInfo, ServerMetrics } from "../../shared/types";
import type { TFunction } from "../lib/i18n";
import { CommandHistoryPanel } from "./CommandHistoryPanel";
import { FileEditor } from "./FileEditor";
import { NetworkPanel } from "./NetworkPanel";
import { ProcessPanel } from "./ProcessPanel";
import { QuickCommandsPanel } from "./QuickCommandsPanel";

type ToolTab = "files" | "commands" | "network" | "processes" | "history";
type Props = { socket: WebSocket | null; metrics?: ServerMetrics; processes: ProcessInfo[]; settings: AppSettings; historyRefreshKey: number; t: TFunction; expanded: boolean; onExpand: () => void };

export function SessionTools({ socket, metrics, processes, settings, historyRefreshKey, t, expanded, onExpand }: Props) {
  const [active, setActive] = useState<ToolTab>("commands");
  const isZh = settings.language === "zh";
  const tabs: Array<{ id: ToolTab; label: string; icon: typeof FileText }> = [
    { id: "files", label: isZh ? "文件" : "Files", icon: FileText },
    { id: "commands", label: isZh ? "命令" : "Commands", icon: TerminalSquare },
    { id: "network", label: isZh ? "网络" : "Network", icon: Network },
    { id: "processes", label: isZh ? "进程" : "Processes", icon: ListTree },
    { id: "history", label: isZh ? "历史" : "History", icon: Clock3 }
  ];
  return <section className="session-tools">
    <nav className="tool-tabs">{tabs.map((tab) => <button className={active === tab.id ? "active" : ""} onClick={() => setActive(tab.id)} key={tab.id} type="button"><tab.icon size={14} />{tab.label}</button>)}
      <button className="tool-expand" onClick={onExpand} type="button" title={expanded ? (isZh ? "恢复终端布局" : "Restore terminal layout") : (isZh ? "最大化工具面板" : "Maximize tools")} aria-pressed={expanded}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
    </nav>
    <div className="tool-body">
      {active === "files" ? <FileEditor socket={socket} t={t} /> : null}
      {active === "commands" ? <QuickCommandsPanel socket={socket} t={t} /> : null}
      {active === "network" ? <NetworkPanel ports={metrics?.listeningPorts ?? []} connected={socket?.readyState === WebSocket.OPEN} updatedAt={metrics?.updatedAt} interfaceRate={metrics?.network} udpMonitorVersion={metrics?.udpMonitorVersion} language={settings.language} /> : null}
      {active === "processes" ? <ProcessPanel processes={processes} socket={socket} language={settings.language} /> : null}
      {active === "history" ? <CommandHistoryPanel refreshKey={historyRefreshKey} t={t} /> : null}
    </div>
  </section>;
}
