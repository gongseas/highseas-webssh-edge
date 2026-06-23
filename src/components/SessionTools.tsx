import { Clock3, FileText, ListTree, Network, TerminalSquare } from "lucide-react";
import { useState } from "react";
import type { AppSettings, ProcessInfo, ServerMetrics } from "../../shared/types";
import type { TFunction } from "../lib/i18n";
import { CommandHistoryPanel } from "./CommandHistoryPanel";
import { FileEditor } from "./FileEditor";
import { NetworkPanel } from "./NetworkPanel";
import { ProcessPanel } from "./ProcessPanel";
import { QuickCommandsPanel } from "./QuickCommandsPanel";

type ToolTab = "files" | "commands" | "network" | "processes" | "history";
type Props = { socket: WebSocket | null; metrics?: ServerMetrics; processes: ProcessInfo[]; settings: AppSettings; historyRefreshKey: number; t: TFunction };

export function SessionTools({ socket, metrics, processes, settings, historyRefreshKey, t }: Props) {
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
    <nav className="tool-tabs">{tabs.map((tab) => <button className={active === tab.id ? "active" : ""} onClick={() => setActive(tab.id)} key={tab.id} type="button"><tab.icon size={14} />{tab.label}</button>)}</nav>
    <div className="tool-body">
      {active === "files" ? <FileEditor socket={socket} t={t} /> : null}
      {active === "commands" ? <QuickCommandsPanel socket={socket} t={t} /> : null}
      {active === "network" ? <NetworkPanel ports={metrics?.listeningPorts ?? []} connected={socket?.readyState === WebSocket.OPEN} updatedAt={metrics?.updatedAt} language={settings.language} /> : null}
      {active === "processes" ? <ProcessPanel processes={processes} socket={socket} language={settings.language} /> : null}
      {active === "history" ? <CommandHistoryPanel refreshKey={historyRefreshKey} t={t} /> : null}
    </div>
  </section>;
}
