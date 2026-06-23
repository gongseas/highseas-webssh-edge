import { Pencil, Play, Plus, Save, Settings2, TerminalSquare, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { QuickCommand } from "../../shared/types";
import { api } from "../lib/api";
import type { TFunction } from "../lib/i18n";

const emptyDraft = { category: "常用", name: "", command: "" };

export function QuickCommandsPanel({ socket, t }: { socket: WebSocket | null; t: TFunction }) {
  const [commands, setCommands] = useState<QuickCommand[]>([]);
  const [editing, setEditing] = useState<QuickCommand | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState("");
  useEffect(() => { api.quickCommands().then(setCommands).catch((nextError: Error) => setError(nextError.message)); }, []);
  const grouped = useMemo(() => commands.reduce((map, item) => {
    const entries = map.get(item.category) ?? [];
    entries.push(item);
    map.set(item.category, entries);
    return map;
  }, new Map<string, QuickCommand[]>()), [commands]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      if (editing) {
        const updated = await api.updateQuickCommand({ ...editing, ...draft });
        setCommands((items) => items.map((item) => item.id === updated.id ? updated : item));
      } else {
        const created = await api.createQuickCommand({ ...draft, sortOrder: commands.length });
        setCommands((items) => [...items, created]);
      }
      closeForm();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "保存失败");
    }
  }

  function openCreate() {
    setEditing(null);
    setDraft(emptyDraft);
    setFormOpen(true);
    setError("");
  }
  function openEdit(item: QuickCommand) {
    setEditing(item);
    setDraft({ category: item.category, name: item.name, command: item.command });
    setFormOpen(true);
    setError("");
  }
  function closeForm() {
    setFormOpen(false);
    setEditing(null);
    setDraft(emptyDraft);
  }
  function closeManager() {
    closeForm();
    setManageOpen(false);
    setError("");
  }
  async function remove(item: QuickCommand) {
    if (!window.confirm(`确认删除快捷命令“${item.name}”？`)) return;
    try {
      await api.deleteQuickCommand(item.id);
      setCommands((all) => all.filter((entry) => entry.id !== item.id));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "删除失败");
    }
  }
  function run(command: string) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data: `${command}\r` }));
  }
  const connected = socket?.readyState === WebSocket.OPEN;

  return <section className="quick-panel">
    <div className="panel-title panel-title-actions"><span><TerminalSquare size={17} />{t("quickCommands")}</span><button className="icon-button" title="统一管理快捷命令" onClick={() => setManageOpen(true)}><Settings2 size={16} /></button></div>
    {error && !manageOpen ? <p className="form-error">{error}</p> : null}
    {[...grouped.entries()].map(([category, items]) => <div className="quick-group" key={category}><h3>{category}</h3><div className="quick-list">
      {items.map((item) => <button className="quick-run" key={item.id} disabled={!connected} onClick={() => run(item.command)} title={item.command}><Play size={14} />{item.name}</button>)}
    </div></div>)}
    {!commands.length && !error ? <p className="empty-history">暂无快捷命令，请从右上角管理按钮添加。</p> : null}

    {manageOpen ? <div className="quick-manager-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeManager(); }}><section className="quick-manager" role="dialog" aria-modal="true" aria-label="快捷命令管理">
      <header className="quick-manager-header"><span><Settings2 size={16} />快捷命令管理</span><div><button className="secondary-button" type="button" onClick={openCreate}><Plus size={15} />{t("addCommand")}</button><button className="icon-button" type="button" title="关闭" onClick={closeManager}><X size={16} /></button></div></header>
      {error ? <p className="form-error quick-manager-error">{error}</p> : null}
      <div className="quick-manager-table"><div className="quick-manager-row quick-manager-head"><span>{t("category")}</span><span>{t("commandName")}</span><span>{t("commandText")}</span><span>管理</span></div>
        {commands.map((item) => <div className="quick-manager-row" key={item.id}><span>{item.category}</span><span>{item.name}</span><code title={item.command}>{item.command}</code><span className="quick-manager-actions"><button className="icon-button" type="button" title="编辑" onClick={() => openEdit(item)}><Pencil size={14} /></button><button className="icon-button danger" type="button" title={t("delete")} onClick={() => void remove(item)}><Trash2 size={14} /></button></span></div>)}
        {!commands.length ? <div className="empty-table">暂无快捷命令</div> : null}
      </div>
      {formOpen ? <form className="quick-manager-form" onSubmit={submit}><header><strong>{editing ? "编辑快捷命令" : "新增快捷命令"}</strong><button className="icon-button" type="button" onClick={closeForm}><X size={15} /></button></header>
        <label>{t("category")}<input required value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} /></label>
        <label>{t("commandName")}<input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>{t("commandText")}<textarea required value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} rows={5} /></label>
        <button className="secondary-button" type="submit"><Save size={15} />{t("save")}</button>
      </form> : null}
    </section></div> : null}
  </section>;
}
