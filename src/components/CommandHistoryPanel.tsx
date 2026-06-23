import { Clock3, Eraser, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CommandHistoryEntry } from "../../shared/types";
import { api } from "../lib/api";
import type { TFunction } from "../lib/i18n";

export function CommandHistoryPanel({ refreshKey, t }: { refreshKey: number; t: TFunction }) {
  const [items, setItems] = useState<CommandHistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");

  async function load() {
    try { const result = await api.commandHistory(300); setItems(result.items); setTotal(result.total); setStatus(""); }
    catch (error) { setStatus(error instanceof Error ? error.message : t("historyLoadFailed")); }
  }
  async function clear() { await api.clearCommandHistory(); setItems([]); setTotal(0); }
  useEffect(() => { void load(); }, [refreshKey]);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword ? items.filter((item) => [item.command, item.profileName, item.host, item.username].some((value) => value?.toLowerCase().includes(keyword))) : items;
  }, [items, query]);

  return <section className="history-panel">
    <div className="history-toolbar"><div className="panel-title"><Clock3 size={18} /><span>{t("commandHistory")}</span><small>{total} / 1000</small></div>
      <div className="history-actions"><button title={t("refresh")} onClick={() => void load()}><RefreshCw size={15} /></button><button title={t("clearHistory")} onClick={() => void clear()}><Eraser size={15} /></button></div></div>
    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchHistory")} />
    <div className="history-list">{filtered.map((item) => <div className="history-item" key={item.id}><code>{item.command}</code><small>{item.profileName} · {item.username ?? "-"}@{item.host ?? "-"} · {new Date(item.createdAt).toLocaleString()}</small></div>)}
      {!filtered.length ? <p className="empty-history">{status || t("emptyHistory")}</p> : null}</div>
  </section>;
}
