import { Search, Send, Skull } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Language, ProcessInfo, TerminalMessage } from "../../shared/types";

type Props = { processes: ProcessInfo[]; socket: WebSocket | null; language: Language };

export function ProcessPanel({ processes, socket, language }: Props) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const isZh = language === "zh";
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return processes.filter((process) => !keyword || [process.pid, process.user, process.command].some((value) => String(value).toLowerCase().includes(keyword)));
  }, [processes, query]);

  useEffect(() => {
    if (!socket) return;
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as TerminalMessage;
      if (message.type === "process-signal-result") setStatus(message.ok ? `${message.pid}: ${isZh ? "信号已发送" : "signal sent"}` : `${message.pid}: ${message.message}`);
    };
    socket.addEventListener("message", onMessage);
    return () => socket.removeEventListener("message", onMessage);
  }, [isZh, socket]);

  function signal(pid: number, kind: "TERM" | "KILL") {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const warning = kind === "KILL" ? (isZh ? `强制结束进程 ${pid}？` : `Force kill process ${pid}?`) : (isZh ? `终止进程 ${pid}？` : `Terminate process ${pid}?`);
    if (!window.confirm(warning)) return;
    socket.send(JSON.stringify({ type: "process-signal", requestId: crypto.randomUUID(), pid, signal: kind } satisfies TerminalMessage));
  }

  return <section className="process-panel tool-panel">
    <div className="tool-panel-bar">
      <span><Send size={15} />{isZh ? "进程管理" : "Process manager"}</span>
      <label className="compact-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={isZh ? "搜索 PID、用户或命令" : "Search PID, user or command"} /></label>
    </div>
    {status ? <button className="inline-status" type="button" onClick={() => setStatus("")}>{status}</button> : null}
    <div className="data-table process-manager-table">
      <div className="data-row data-head process-manager-row"><span>PID</span><span>{isZh ? "用户" : "User"}</span><span>CPU</span><span>{isZh ? "内存" : "Memory"}</span><span>{isZh ? "命令" : "Command"}</span><span>{isZh ? "操作" : "Action"}</span></div>
      {filtered.map((process) => <div className="data-row process-manager-row" key={process.pid}>
        <span>{process.pid}</span><span>{process.user}</span><span>{process.cpu.toFixed(1)}%</span><span>{process.memory.toFixed(1)}%</span><span title={process.command}>{process.command}</span>
        <span className="process-actions"><button type="button" disabled={!socket} onClick={() => signal(process.pid, "TERM")} title={isZh ? "正常终止" : "Terminate"}><Send size={13} /></button><button className="danger" type="button" disabled={!socket} onClick={() => signal(process.pid, "KILL")} title={isZh ? "强制结束" : "Force kill"}><Skull size={13} /></button></span>
      </div>)}
      {!filtered.length ? <div className="empty-table">{isZh ? "暂无进程数据" : "No process data"}</div> : null}
    </div>
  </section>;
}
