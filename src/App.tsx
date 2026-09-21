import { FolderOpen, Plus, Server, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AppSettings, AuthState, Language, ProcessInfo, ServerMetrics, ServerProfile, ServerProfileInput } from "../shared/types";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { LoginGate } from "./components/LoginGate";
import { MonitorPanel } from "./components/MonitorPanel";
import { SessionTools } from "./components/SessionTools";
import { SettingsPanel } from "./components/SettingsPanel";
import { TerminalPane } from "./components/TerminalPane";
import { api } from "./lib/api";
import { createT, type TFunction } from "./lib/i18n";

const fallbackSettings: AppSettings = { twoFactorEnabled: false, theme: "light", language: "zh", commandHistoryEnabled: false };
type SessionRuntime = { metrics?: ServerMetrics; processes: ProcessInfo[]; socket: WebSocket | null };

export default function App() {
  const [loginLanguage, setLoginLanguage] = useState<Language>("zh");
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [settings, setSettings] = useState<AppSettings>(fallbackSettings);
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [recentConnections, setRecentConnections] = useState<string[]>([]);
  const recentConnectionsKey = `highseas.recentConnections.${auth?.user?.id ?? "anonymous"}`;
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(recentConnectionsKey) ?? "[]");
      setRecentConnections(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string").slice(0, 500) : []);
    } catch { setRecentConnections([]); }
  }, [recentConnectionsKey]);
  const quickConnectProfiles = useMemo(() => {
    const order = new Map(recentConnections.map((id, index) => [id, index]));
    return [...profiles].sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  }, [profiles, recentConnections]);
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [runtimes, setRuntimes] = useState<Record<string, SessionRuntime>>({});
  const [notice, setNotice] = useState("");
  const [serverBrowserOpen, setServerBrowserOpen] = useState(true);
  const [leftRailWidth, setLeftRailWidth] = useState(230);

  const refreshAuth = useCallback(() => api.authState().then(setAuth).catch((error: Error) => { setNotice(error.message); setAuth({ needsSetup: false, authenticated: false }); }), []);
  useEffect(() => { void refreshAuth(); }, [refreshAuth]);
  useEffect(() => {
    if (!auth?.authenticated) return;
    Promise.all([api.settings(), api.connections()]).then(([nextSettings, nextProfiles]) => { setSettings(nextSettings); setProfiles(nextProfiles); }).catch((error: Error) => setNotice(error.message));
  }, [auth?.authenticated]);

  const t = useMemo(() => createT(settings.language), [settings.language]);
  const activeRuntime = activeId ? runtimes[activeId] : undefined;
  const updateRuntime = useCallback((id: string, patch: Partial<SessionRuntime>) => {
    setRuntimes((current) => {
      const previous = current[id] ?? { processes: [], socket: null };
      return { ...current, [id]: { ...previous, ...patch } };
    });
  }, []);

  function openSession(id: string) {
    const recent = [id, ...recentConnections.filter(item => item !== id)].slice(0, 500);
    setRecentConnections(recent);
    try { localStorage.setItem(recentConnectionsKey, JSON.stringify(recent)); } catch { /* Session ordering still works when storage is disabled. */ }
    setSessionIds((current) => current.includes(id) ? current : [...current, id]);
    setActiveId(id);
  }
  function closeSession(id: string) {
    setSessionIds((current) => {
      const next = current.filter((item) => item !== id);
      setActiveId((active) => active === id ? next.at(-1) : active);
      if (!next.length) setServerBrowserOpen(true);
      return next;
    });
    setRuntimes((current) => { const next = { ...current }; delete next[id]; return next; });
  }
  async function createProfile(profile: ServerProfileInput) { const created = await api.createConnection(profile); setProfiles((current) => [...current, created]); openSession(created.id); setServerBrowserOpen(false); }
  async function updateProfile(id: string, profile: ServerProfileInput) { const updated = await api.updateConnection(id, profile); setProfiles((current) => current.map((item) => item.id === id ? updated : item)); }
  async function deleteProfile(id: string) { await api.deleteConnection(id); closeSession(id); setProfiles((current) => current.filter((item) => item.id !== id)); }
  async function saveSettings(next: AppSettings) { setSettings(next); try { setSettings(await api.saveSettings(next)); } catch (error) { setNotice(error instanceof Error ? error.message : "保存设置失败"); } }
  async function logout() { try { await api.logout(); } catch { /* A password change already revokes the session. */ } finally { setAuth({ needsSetup: false, authenticated: false }); setSessionIds([]); setRuntimes({}); } }

  function beginSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 700) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = leftRailWidth;
    document.body.classList.add("is-resizing", "is-resizing-columns");
    const move = (nextEvent: PointerEvent) => setLeftRailWidth(Math.min(380, Math.max(150, startWidth + nextEvent.clientX - startX)));
    const stop = () => {
      document.body.classList.remove("is-resizing", "is-resizing-columns");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  if (!auth) return <main className="loading-shell">Highseas WebSSH</main>;
  if (!auth.authenticated) return <LoginGate needsSetup={auth.needsSetup} language={loginLanguage} onLanguageChange={setLoginLanguage} onAuthenticated={refreshAuth} t={createT(loginLanguage)} />;

  return <div className={`app-shell ${settings.theme}`}>
    <header className="app-header"><div className="app-brand"><strong>{t("appName")}</strong><span>{t("productName")}</span></div><SettingsPanel settings={settings} onChange={saveSettings} onLogout={logout} onSecurityChanged={() => { void refreshAuth(); setSettings((value) => ({ ...value, twoFactorEnabled: !value.twoFactorEnabled })); }} t={t} /></header>
    {notice ? <button className="notice" onClick={() => setNotice("")}>{notice}</button> : null}
    <main className="workspace" style={{ gridTemplateColumns: `${leftRailWidth}px 5px minmax(560px, 1fr)` }}>
      <div className="left-rail">
        {serverBrowserOpen ? <ConnectionPanel profiles={profiles} selectedId={activeId} onSelect={(id) => { openSession(id); setServerBrowserOpen(false); }} onDisconnect={closeSession} onCreate={createProfile} onUpdate={updateProfile} onDelete={deleteProfile} t={t} /> : <MonitorPanel metrics={activeRuntime?.metrics} processes={activeRuntime?.processes ?? []} language={settings.language} />}
      </div>
      <div className="splitter splitter-vertical" role="separator" aria-orientation="vertical" title={settings.language === "zh" ? "拖动调整侧栏宽度" : "Drag to resize sidebar"} onPointerDown={beginSidebarResize} />
      <div className="center-stack">
        <div className="connection-bar">
          <button className={serverBrowserOpen ? "connection-browser-toggle active" : "connection-browser-toggle"} type="button" title={t("connections")} onClick={() => setServerBrowserOpen((value) => !value)}><FolderOpen size={20} /></button>
          <nav className="session-tabs">
          {sessionIds.map((id) => { const profile = profiles.find((item) => item.id === id); return profile ? <button className={id === activeId ? "session-tab active" : "session-tab"} key={id} onClick={() => setActiveId(id)}><Server size={14} /><span>{profile.name}</span><X size={14} onClick={(event) => { event.stopPropagation(); closeSession(id); }} /></button> : null; })}
          </nav>
          <button className="new-session-button" type="button" title={t("saveVps")} onClick={() => setServerBrowserOpen(true)}><Plus size={18} /></button>
        </div>
        {!sessionIds.length ? <section className="quick-connect-workspace">
          <div className="quick-connect-list"><header>{settings.language === "zh" ? "快速连接" : "Quick connect"}<span>{profiles.length}</span></header>
            {quickConnectProfiles.map(profile => <button key={profile.id} type="button" onClick={() => { openSession(profile.id); setServerBrowserOpen(false); }}><span><Server size={14} />{profile.name}</span><span title={profile.groupName}>{profile.groupName || "/"}</span><span>{profile.username}</span></button>)}
            {!profiles.length ? <button type="button" onClick={() => setServerBrowserOpen(true)}>{t("selectConnectionHint")}</button> : null}
          </div>
        </section> : null}
        {sessionIds.map((id) => { const profile = profiles.find((item) => item.id === id); return profile ? <SessionWorkspace key={id} profile={profile} active={id === activeId} settings={settings} runtime={runtimes[id]} t={t} updateRuntime={updateRuntime} /> : null; })}
      </div>
    </main>
  </div>;
}

function SessionWorkspace({ profile, active, settings, runtime, t, updateRuntime }: { profile: ServerProfile; active: boolean; settings: AppSettings; runtime?: SessionRuntime; t: TFunction; updateRuntime: (id: string, patch: Partial<SessionRuntime>) => void }) {
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [toolsHeight, setToolsHeight] = useState(340);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const onMetrics = useCallback((metrics: ServerMetrics, processes: ProcessInfo[]) => updateRuntime(profile.id, { metrics, processes }), [profile.id, updateRuntime]);
  const onSocketChange = useCallback((next: WebSocket | null) => { setSocket(next); updateRuntime(profile.id, { socket: next }); }, [profile.id, updateRuntime]);
  const onCommand = useCallback(() => setHistoryRefreshKey((key) => key + 1), []);

  function beginToolsResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = toolsHeight;
    const availableHeight = workspaceRef.current?.clientHeight ?? 700;
    document.body.classList.add("is-resizing", "is-resizing-rows");
    const move = (nextEvent: PointerEvent) => setToolsHeight(Math.min(availableHeight - 150, Math.max(150, startHeight + startY - nextEvent.clientY)));
    const stop = () => {
      document.body.classList.remove("is-resizing", "is-resizing-rows");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  return <section ref={workspaceRef} className={`${active ? "session-workspace active" : "session-workspace"}${toolsExpanded ? " tools-expanded" : ""}`} style={active ? { gridTemplateRows: toolsExpanded ? "24px 0px 0px minmax(0, 1fr)" : `24px minmax(120px, 1fr) 6px min(${toolsHeight}px, calc(100% - 150px))` } : undefined}>
    <div className="context-line"><span>{profile.username}@{profile.host}</span><small>{t("port")} {profile.port}</small></div>
    <TerminalPane profileId={profile.id} connectionAttempt={1} language={settings.language} theme={settings.theme} connectingLabel={t("connecting")} disconnectedLabel={t("disconnected")} onMetrics={onMetrics} onCommandSubmitted={onCommand} onSocketChange={onSocketChange} />
    <div className="splitter splitter-horizontal" role="separator" aria-orientation="horizontal" title={settings.language === "zh" ? "拖动调整终端和工具区高度" : "Drag to resize terminal and tools"} onPointerDown={beginToolsResize} />
    <SessionTools socket={socket} metrics={runtime?.metrics} processes={runtime?.processes ?? []} settings={settings} historyRefreshKey={historyRefreshKey} t={t} expanded={toolsExpanded} onExpand={() => setToolsExpanded(value => !value)} />
  </section>;
}
