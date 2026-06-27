import { PlugZap } from "lucide-react";
import { useEffect, useRef } from "react";
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
    terminal.open(hostRef.current);
    fit.fit();
    terminalRef.current = terminal;

    const resize = () => {
      if (hostRef.current?.clientWidth && hostRef.current.clientHeight) fit.fit();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(hostRef.current);
    window.addEventListener("resize", resize);
    return () => {
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
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${protocol}://${window.location.host}/ws/terminal?profileId=${encodeURIComponent(profileId)}&language=${language}`
    );
    socketRef.current?.close();
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", profileId } satisfies TerminalMessage));
      socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows } satisfies TerminalMessage));
      onSocketChangeRef.current?.(socket);
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as TerminalMessage;
      if (message.type === "output") terminal.write(message.data);
      if (message.type === "metrics") onMetrics(message.metrics, message.processes);
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
      }
    };
    socket.addEventListener("close", handleClose);
    const inputDisposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data } satisfies TerminalMessage));
      if (data === "\r") window.setTimeout(() => onCommandSubmitted?.(), 300);
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols, rows } satisfies TerminalMessage));
    });

    return () => {
      if (socketRef.current === socket) {
        socketRef.current = null;
        onSocketChangeRef.current?.(null);
      }
      inputDisposable.dispose();
      resizeDisposable.dispose();
      socket.removeEventListener("close", handleClose);
      socket.close();
    };
  }, [connectingLabel, connectionAttempt, disconnectedLabel, language, onCommandSubmitted, onMetrics, profileId]);

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
