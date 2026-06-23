import { FileKey2, KeyRound, Pencil, Plug, Plus, Server, Trash2, X } from "lucide-react";
import { ChangeEvent, FormEvent, useMemo, useState } from "react";
import type { ServerProfile, ServerProfileInput } from "../../shared/types";
import type { TFunction } from "../lib/i18n";
import { emptyProfile } from "../lib/sample";

type Props = {
  profiles: ServerProfile[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onCreate: (profile: ServerProfileInput) => Promise<void>;
  onUpdate: (id: string, profile: ServerProfileInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  t: TFunction;
};

export function ConnectionPanel({ profiles, selectedId, onSelect, onDisconnect, onCreate, onUpdate, onDelete, t }: Props) {
  const [draft, setDraft] = useState<ServerProfileInput>({ ...emptyProfile });
  const [editingId, setEditingId] = useState<string>();
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [keyFileName, setKeyFileName] = useState("");
  const groups = useMemo(() => [...new Set(profiles.map((item) => item.groupName || "默认分组"))], [profiles]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (editingId) await onUpdate(editingId, draft); else await onCreate(draft);
      resetForm();
    } catch (err) { setError(err instanceof Error ? err.message : "保存失败"); }
    finally { setBusy(false); }
  }

  function startEdit(profile: ServerProfile) {
    setEditingId(profile.id); setFormOpen(true); setError("");
    setDraft({ name: profile.name, groupName: profile.groupName, host: profile.host, port: profile.port, username: profile.username,
      credentialKind: profile.credentialKind, password: "", privateKey: "", passphrase: "", hostFingerprint: profile.hostFingerprint });
  }

  function resetForm() { setEditingId(undefined); setFormOpen(false); setDraft({ ...emptyProfile }); setError(""); setKeyFileName(""); }
  function loadPem(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    event.target.value = "";
    if (file.size > 64 * 1024) { setError("私钥文件不能超过 64KB"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? "").trim();
      const isPpk = /^PuTTY-User-Key-File-\d+:/m.test(content);
      const isStandardPrivateKey = /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(content);
      if (!isPpk && !isStandardPrivateKey) {
        setError("无法识别私钥格式，请选择 PEM、OpenSSH、PKCS 或 PuTTY PPK 文件");
        return;
      }
      if (/^PuTTY-User-Key-File-3:/m.test(content) && !/^Encryption:\s*none\s*$/mi.test(content)) {
        setError("加密 PPK v3 暂不支持，请用 PuTTYgen 导出为 PPK v2 或 OpenSSH 格式");
        return;
      }
      setError("");
      setKeyFileName(file.name);
      setDraft((current) => ({ ...current, privateKey: content, credentialKind: "privateKey" }));
    };
    reader.onerror = () => setError("无法读取私钥文件"); reader.readAsText(file);
  }

  return (
    <aside className="side-panel">
      <div className="panel-title panel-title-actions"><span><Server size={18} />{t("connections")}</span><button className="icon-button" title={t("saveVps")} onClick={() => { resetForm(); setFormOpen(true); }}><Plus size={17} /></button></div>
      <div className="connection-list">
        {groups.map((group) => <section className="connection-group" key={group}><h3>{group}</h3>
          {profiles.filter((profile) => (profile.groupName || "默认分组") === group).map((profile) => (
            <div key={profile.id} className={profile.id === selectedId ? "connection-item active" : "connection-item"}>
              <button className="connection-main" onClick={() => onSelect(profile.id)} type="button"><span>{profile.name}</span><small>{profile.username}@{profile.host}:{profile.port}</small></button>
              <span className="connection-actions">
                <button title={profile.id === selectedId ? t("disconnect") : t("connect")} onClick={() => profile.id === selectedId ? onDisconnect(profile.id) : onSelect(profile.id)}><Plug size={15} /></button>
                <button title={t("editConnection")} onClick={() => startEdit(profile)}><Pencil size={15} /></button>
                <button title={t("deleteConnection")} onClick={() => void onDelete(profile.id)}><Trash2 size={15} /></button>
              </span>
            </div>))}
        </section>)}
      </div>
      {formOpen ? <div className="form-overlay"><form className="connection-form" onSubmit={submit}>
        <div className="panel-title panel-title-actions"><span>{editingId ? t("editConnection") : t("saveVps")}</span><button className="icon-button" type="button" onClick={resetForm}><X size={16} /></button></div>
        <input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("name")} />
        <input value={draft.groupName} onChange={(e) => setDraft({ ...draft, groupName: e.target.value })} placeholder={t("group")} />
        <input required value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} placeholder={t("host")} />
        <div className="split-inputs"><input value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} type="number" min={1} max={65535} /><input required value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} placeholder={t("username")} /></div>
        <select value={draft.credentialKind} onChange={(e) => setDraft({ ...draft, credentialKind: e.target.value as ServerProfile["credentialKind"] })}><option value="password">{t("password")}</option><option value="privateKey">{t("privateKey")}</option></select>
        {draft.credentialKind === "password" ? <input value={draft.password ?? ""} onChange={(e) => setDraft({ ...draft, password: e.target.value })} placeholder={editingId ? "留空则保持原密码" : t("sshPassword")} type="password" /> : <>
          <textarea value={draft.privateKey ?? ""} onChange={(e) => setDraft({ ...draft, privateKey: e.target.value })} placeholder={editingId ? "留空则保持原私钥" : t("pastePrivateKey")} rows={5} />
          <label className="file-button"><FileKey2 size={16} />上传私钥（PEM / PPK / OpenSSH）<input type="file" accept=".pem,.key,.ppk,.openssh,application/x-putty-key,text/plain" onChange={loadPem} /></label>
          {keyFileName ? <small className="key-file-status">已载入：{keyFileName}</small> : null}
          <input value={draft.passphrase ?? ""} onChange={(e) => setDraft({ ...draft, passphrase: e.target.value })} placeholder="私钥口令（可选）" type="password" />
        </>}
        <input value={draft.hostFingerprint} onChange={(e) => setDraft({ ...draft, hostFingerprint: e.target.value })} placeholder={t("hostFingerprint")} />
        {error ? <p className="form-error">{error}</p> : null}
        <button className="secondary-button" disabled={busy} type="submit"><KeyRound size={16} />{editingId ? t("updateConnection") : t("saveConnection")}</button>
      </form></div> : null}
    </aside>
  );
}
