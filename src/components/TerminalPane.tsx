import { PlugZap, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { Language, ProcessInfo, ServerMetrics, TerminalMessage, ThemeMode } from "../../shared/types";

type Props = {
  profileId?: string;
  connectionAttempt: number;
  language: Language;
  theme: ThemeMode;
  connectingLabel: string;
  disconnectedLabel: string;
  onMetrics: (metrics: ServerMetrics, processes: ProcessInfo[]) => void;
  onCommandSubmitted?: () => void;
  onSocketChange?: (socket: WebSocket | null) => void;
};

export function TerminalPane({ profileId, connectionAttempt, language, theme, connectingLabel, disconnectedLabel, onMetrics, onCommandSubmitted, onSocketChange }: Props) {
  const [retry, setRetry] = useState(0);
  const [connectionState, setConnectionState] = useState("connecting");
  const [monitorStale, setMonitorStale] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const themeRef = useRef(theme);
  const socketRef = useRef<WebSocket | null>(null);
  const onSocketChangeRef = useRef(onSocketChange);
  themeRef.current = theme;
  onSocketChangeRef.current = onSocketChange;

  useEffect(() => {
    if (!hostRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
      fontSize: 14,
      theme: terminalTheme(themeRef.current)
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminalRef.current = terminal;
    // React can dispose an effect before the browser has painted its host.
    const openFrame = requestAnimationFrame(() => {
      if (!hostRef.current) return;
      terminal.open(hostRef.current);
      resize();
    });

    const resize = () => {
      if (terminal.element && hostRef.current?.clientWidth && hostRef.current.clientHeight) fit.fit();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(hostRef.current);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(openFrame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
      socketRef.current?.close();
      terminal.dispose();
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (!profileId) {
      onSocketChangeRef.current?.(null);
      socketRef.current?.close();
      socketRef.current = null;
      terminal.clear();
      if (connectionAttempt > 0) terminal.writeln(disconnectedLabel);
      return;
    }

    terminal.clear();
    terminal.writeln(connectingLabel);
    setConnectionState("connecting");
    setMonitorStale(false);
    let lastMessage = Date.now();
    let lastMetrics = Date.now();
    let confirmedConnected = false;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${protocol}://${window.location.host}/ws/terminal?profileId=${encodeURIComponent(profileId)}&language=${language}`
    );
    socketRef.current?.close();
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      if (socketRef.current !== socket) { socket.close(); return; }
      socket.send(JSON.stringify({ type: "hello", profileId } satisfies TerminalMessage));
      socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows } satisfies TerminalMessage));
      onSocketChangeRef.current?.(socket);
    });
    socket.addEventListener("message", (event) => {
      if (socketRef.current !== socket) return;
      lastMessage = Date.now();
      const message = JSON.parse(String(event.data)) as TerminalMessage;
      if (message.type === "output") terminal.write(message.data);
      if (message.type === "metrics") {
        lastMetrics = Date.now();
        setMonitorStale(false);
        onMetrics(message.metrics, message.processes);
      }
      if (message.type === "monitor-status") setMonitorStale(message.state !== "ok");
      if (message.type === "status") {
        setConnectionState(message.state);
        confirmedConnected = message.state === "connected";
        if (message.state === "closed") { handleClose(); socket.close(); }
      }
      if (message.type === "error") terminal.writeln(`\r\n${message.message}`);
      if (message.type === "host-key") {
        const label = message.verified ? "SSH host key verified" : "SSH host key (save this fingerprint to verify future connections)";
        terminal.writeln(`\r\n\x1b[36m${label}: ${message.fingerprint}\x1b[0m\r\n`);
      }
    });
    const handleClose = () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
        onSocketChangeRef.current?.(null);
        setConnectionState("closed");
        terminal.writeln(`\r\n${disconnectedLabel}\r\n`);
      }
    };
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleClose);
    const heartbeat = window.setInterval(() => {
      if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMessage > 45_000) { handleClose(); socket.close(); return; }
      if (confirmedConnected && Date.now() - lastMetrics > 20_000) setMonitorStale(true);
      socket.send(JSON.stringify({ type: "ping" } satisfies TerminalMessage));
    }, 10_000);
    const inputDisposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data } satisfies TerminalMessage));
      if (data === "\r") window.setTimeout(() => onCommandSubmitted?.(), 300);
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows } satisfies TerminalMessage));
    });

    return () => {
      window.clearInterval(heartbeat);
      if (socketRef.current === socket) {
        socketRef.current = null;
        onSocketChangeRef.current?.(null);
      }
      inputDisposable.dispose();
      resizeDisposable.dispose();
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleClose);
      socket.close();
    };
  }, [connectingLabel, connectionAttempt, disconnectedLabel, language, onCommandSubmitted, onMetrics, profileId, retry]);

  return (
    <section className="terminal-wrap">
      <div className="terminal-toolbar">
        <div className="traffic-lights" aria-hidden="true">
          <span className="red" />
          <span className="yellow" />
          <span className="green" />
        </div>
        <div className="terminal-title">
          <PlugZap size={16} />
          highseas@edge
        </div>
        <span className={`terminal-health ${connectionState}`} role="status">{connectionState === "closed" ? (language === "zh" ? "连接已断开" : "Disconnected") : monitorStale ? (language === "zh" ? "监控未更新，正在重试" : "Monitoring delayed; retrying") : connectionState === "connected" ? (language === "zh" ? "已连接" : "Connected") : (language === "zh" ? "连接中" : "Connecting")}</span>
        {connectionState === "closed" ? <button className="terminal-reconnect" type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={13} />{language === "zh" ? "重新连接" : "Reconnect"}</button> : null}
      </div>
      <div ref={hostRef} className="terminal-host" />
    </section>
  );
}

function terminalTheme(theme: ThemeMode) {
  return {
    background: theme === "contrast" ? "#242424" : "#303030",
    foreground: "#f4f4f4",
    cursor: "#f4f4f4",
    selectionBackground: "#4e7092"
  };
}
