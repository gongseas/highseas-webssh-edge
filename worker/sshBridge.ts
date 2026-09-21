import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import { connect } from "cloudflare:sockets";
import { Client, type ClientChannel, type SFTPWrapper } from "ssh2";
import type { Language, RemoteFile, ServerProfile, TerminalMessage } from "../shared/types";
import { mergeNetworkMonitorOutput, MONITOR_COMMAND, NETWORK_MONITOR_COMMAND, parseMonitorOutput, type ConnectionSnapshot } from "./monitor";
import { createLocationUpdates } from "./locationUpdates";
import { captureMonitorExec } from "./monitorExec";
import { normalizePrivateKeyForSsh } from "./privateKey";

export type SshBridge = {
  handleClientMessage(message: TerminalMessage): void;
  close(): void;
  sftpSession: SFTPWrapper | null;
};

type SshBridgeOptions = {
  profile?: ServerProfile;
  language: Language;
  onCommand?: (command: string) => void;
};

type ShellSize = {
  cols: number;
  rows: number;
};

export function createSshBridge(socket: WebSocket, options: SshBridgeOptions): SshBridge {
  const copy = options.language === "en" ? terminalCopy.en : terminalCopy.zh;
  const send = (message: TerminalMessage) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  let conn: Client | null = null;
  let shell: ClientChannel | null = null;
  let sftpSession: SFTPWrapper | null = null;
  let tcpStream: CloudflareSocketDuplex | null = null;
  let currentLine = "";
  let shellSize: ShellSize = { cols: 80, rows: 24 };
  let metricsTimer: ReturnType<typeof setInterval> | null = null;
  let metricsRunning = false;
  let closed = false;
  const monitorAbort = new AbortController();
  let connectionSnapshot: ConnectionSnapshot | null = null;
  const locations = createLocationUpdates<NonNullable<ReturnType<typeof parseMonitorOutput>>["metrics"] & { processes: import("../shared/types").ProcessInfo[] }>(
    ({ processes, ...metrics }) => send({ type: "metrics", metrics, processes })
  );
  const uploadStreams = new Map<string, NodeJS.WritableStream>();

  const MAX_READ_SIZE = 2 * 1024 * 1024;
  const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024;

  if (!options.profile) {
    send({ type: "error", message: copy.noProfile });
  } else {
    void openSshSession(options.profile);
  }

  async function openSshSession(profile: ServerProfile) {
    send({ type: "status", state: "connecting" });
    send({ type: "output", data: "\r\nHighseas WebSSH\r\n" });
    send({ type: "output", data: `${copy.selected}${profile.name} (${profile.username}@${profile.host}:${profile.port})\r\n` });
    send({ type: "output", data: `${copy.connecting}\r\n` });

    try {
      const tcpSocket = connect({ hostname: profile.host, port: profile.port });
      tcpStream = new CloudflareSocketDuplex(tcpSocket);
      conn = new Client();

      conn
        .on("ready", () => {
          send({ type: "status", state: "connected" });
          send({ type: "output", data: `${copy.authenticated}\r\n` });
          conn?.shell(
            {
              term: "xterm-256color",
              cols: shellSize.cols,
              rows: shellSize.rows,
              width: shellSize.cols * 8,
              height: shellSize.rows * 16
            },
            (error, channel) => {
              if (error) {
                send({ type: "error", message: error.message });
                return;
              }
              shell = channel;
              channel.on("data", (data: Buffer | string) => send({ type: "output", data: data.toString() }));
              channel.stderr.on("data", (data: Buffer | string) => send({ type: "output", data: data.toString() }));
              channel.on("close", () => {
                send({ type: "status", state: "closed" });
                send({ type: "output", data: `\r\n${copy.sessionClosed}\r\n` });
                close();
              });
            }
          );
          conn?.sftp((err, sftp) => {
            if (err) return;
            sftpSession = sftp;
          });
          startMetricsCollection();
        })
        .on("banner", (message) => send({ type: "output", data: `${message}\r\n` }))
        .on("error", (error) => {
          send({ type: "error", message: `${copy.connectFailed}${error.message}` });
          close();
        })
        .on("close", () => {
          send({ type: "status", state: "closed" });
          send({ type: "output", data: `\r\n${copy.connectionClosed}\r\n` });
          close();
        });

      const privateKey = profile.credentialKind === "privateKey" && profile.privateKey
        ? normalizePrivateKeyForSsh(profile.privateKey, profile.passphrase)
        : undefined;
      conn.connect({
        sock: tcpStream,
        username: profile.username,
        password: profile.credentialKind === "password" ? profile.password : undefined,
        privateKey,
        passphrase: profile.credentialKind === "privateKey" ? profile.passphrase : undefined,
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostHash: "sha256",
        hostVerifier(keyHash: string) {
          const actual = normalizeFingerprint(keyHash);
          const expected = normalizeFingerprint(profile.hostFingerprint);
          const verified = Boolean(expected) && expected === actual;
          send({ type: "host-key", fingerprint: `SHA256:${keyHash}`, verified });
          return !expected || verified;
        },
        // Workers nodejs_compat does not currently support all authenticated
        // SSH ciphers. Keep modern CTR + SHA-2 algorithms and reject legacy CBC.
        algorithms: {
          cipher: ["aes128-ctr", "aes192-ctr", "aes256-ctr"],
          hmac: ["hmac-sha2-256", "hmac-sha2-512"]
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : copy.unknownError;
      send({ type: "error", message: `${copy.connectFailed}${message}` });
      close();
    }
  }

  function handleInput(data: string) {
    if (!shell) return;
    shell?.write(data);
    if (data === "\r") {
      const command = currentLine.trim();
      currentLine = "";
      if (command) options.onCommand?.(command);
      return;
    }
    if (data === "\u007f") {
      currentLine = currentLine.slice(0, -1);
      return;
    }
    if (data === "\u0003") {
      currentLine = "";
      return;
    }
    currentLine += data.replace(/\p{C}/gu, "");
  }

  function handleResize(cols: number, rows: number) {
    shellSize = { cols, rows };
    shell?.setWindow(rows, cols, rows * 16, cols * 8);
  }

  // ── Metrics collection ──────────────────────────────────────────────

  function startMetricsCollection() {
    collectMetrics();
    metricsTimer = setInterval(collectMetrics, 3000);
  }

  async function collectMetrics() {
    if (!conn || metricsRunning || closed) return;
    const activeConnection = conn;
    metricsRunning = true;
    try {
      const output = await captureMonitorExec(activeConnection, MONITOR_COMMAND, monitorAbort.signal);
      const networkOutput = await captureMonitorExec(activeConnection, NETWORK_MONITOR_COMMAND, monitorAbort.signal);
      if (closed || conn !== activeConnection) return;
      const result = parseMonitorOutput(mergeNetworkMonitorOutput(output, networkOutput), connectionSnapshot);
      if (!result) throw new Error("Incomplete monitor sample");
      connectionSnapshot = result.snapshot;
      locations.update({ ...result.metrics, processes: result.processes });
      send({ type: "monitor-status", state: "ok" });
    } catch (error) {
      if (!closed) {
        send({ type: "monitor-status", state: "retrying" });
        console.warn(JSON.stringify({ event: "monitor_sample_failed", reason: error instanceof Error ? error.message : "unknown" }));
      }
    } finally { metricsRunning = false; }
  }

  function handleProcessSignal(requestId: string, pid: number, signal: "TERM" | "KILL" | "HUP") {
    if (!conn || !Number.isSafeInteger(pid) || pid <= 1 || !["TERM", "KILL", "HUP"].includes(signal)) {
      send({ type: "process-signal-result", requestId, pid, ok: false, message: "Invalid process request" });
      return;
    }
    conn.exec(`kill -${signal} -- ${pid}`, (error, channel) => {
      if (error) {
        send({ type: "process-signal-result", requestId, pid, ok: false, message: error.message });
        return;
      }
      let stderr = "";
      channel.stderr.on("data", (data: Buffer | string) => { stderr += data.toString(); });
      channel.on("close", (code: number | null) => {
        const ok = code === 0;
        send({ type: "process-signal-result", requestId, pid, ok, message: ok ? "Signal sent" : stderr.trim() || `kill exited with ${code}` });
        if (ok) setTimeout(collectMetrics, 500);
      });
    });
  }

  // ── SFTP operations ─────────────────────────────────────────────────

  function handleSftpLs(requestId: string, path: string) {
    if (!sftpSession) return send({ type: "sftp-error", requestId, message: "SFTP 会话未就绪" });
    try {
      sftpSession.readdir(path, (err, list) => {
        if (err) return send({ type: "sftp-error", requestId, message: err.message });
        const files: RemoteFile[] = list
          .map((item) => {
            const parentPath = path.replace(/\/$/, "");
            return {
              name: item.filename,
              path: `${parentPath}/${item.filename}`,
              size: item.attrs.size,
              type: (item.attrs.isDirectory() ? "directory" : "file") as RemoteFile["type"],
              modifiedAt: new Date(item.attrs.mtime * 1000).toISOString()
            };
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        send({ type: "sftp-ls-result", requestId, files });
      });
    } catch (error) {
      send({ type: "sftp-error", requestId, message: error instanceof Error ? error.message : "列目录失败" });
    }
  }

  function handleSftpRead(requestId: string, path: string) {
    if (!sftpSession) return send({ type: "sftp-error", requestId, message: "SFTP 会话未就绪" });
    try {
      sftpSession.stat(path, (statErr, stats) => {
        if (statErr) return send({ type: "sftp-error", requestId, message: statErr.message });
        if (stats.size > MAX_READ_SIZE) {
          return send({ type: "sftp-error", requestId, message: "文件超过 2MB 限制，无法读取" });
        }
        sftpSession!.readFile(path, { encoding: "utf8" }, (err, content) => {
          if (err) return send({ type: "sftp-error", requestId, message: err.message });
          send({ type: "sftp-read-result", requestId, path, content: content as unknown as string });
        });
      });
    } catch (error) {
      send({ type: "sftp-error", requestId, message: error instanceof Error ? error.message : "读取文件失败" });
    }
  }

  function handleSftpWrite(requestId: string, path: string, content: string) {
    if (!sftpSession) return send({ type: "sftp-error", requestId, message: "SFTP 会话未就绪" });
    try {
      sftpSession.writeFile(path, content, { encoding: "utf8" }, (err) => {
        if (err) return send({ type: "sftp-error", requestId, message: err.message });
        send({ type: "sftp-write-result", requestId, ok: true });
      });
    } catch (error) {
      send({ type: "sftp-error", requestId, message: error instanceof Error ? error.message : "写入文件失败" });
    }
  }

  function handleSftpUpload(requestId: string, path: string, chunk: string, offset: number, done: boolean) {
    if (!sftpSession) return send({ type: "sftp-error", requestId, message: "SFTP 会话未就绪" });
    try {
      if (offset === 0) {
        const stream = sftpSession.createWriteStream(path);
        uploadStreams.set(requestId, stream);
        stream.on("error", (err: Error) => {
          send({ type: "sftp-error", requestId, message: err.message });
          uploadStreams.delete(requestId);
        });
      }
      const stream = uploadStreams.get(requestId);
      if (!stream) return send({ type: "sftp-error", requestId, message: "上传流未找到" });
      if (chunk) {
        const buf = Buffer.from(chunk, "base64");
        stream.write(buf);
      }
      if (done) {
        stream.end();
        uploadStreams.delete(requestId);
      }
      send({ type: "sftp-upload-progress", requestId, offset, done });
    } catch (error) {
      uploadStreams.delete(requestId);
      send({ type: "sftp-error", requestId, message: error instanceof Error ? error.message : "上传失败" });
    }
  }

  function handleSftpDownload(requestId: string, path: string) {
    if (!sftpSession) return send({ type: "sftp-error", requestId, message: "SFTP 会话未就绪" });
    try {
      sftpSession.stat(path, (statErr, stats) => {
        if (statErr) return send({ type: "sftp-error", requestId, message: statErr.message });
        if (stats.size > MAX_DOWNLOAD_SIZE) {
          return send({ type: "sftp-error", requestId, message: "文件超过 100MB 限制，无法下载" });
        }
        const stream = sftpSession!.createReadStream(path);
        stream.on("data", (data: Buffer) => {
          send({ type: "sftp-download-chunk", requestId, chunk: Buffer.from(data).toString("base64"), done: false });
        });
        stream.on("end", () => {
          send({ type: "sftp-download-chunk", requestId, chunk: "", done: true });
        });
        stream.on("error", (err: Error) => {
          send({ type: "sftp-error", requestId, message: err.message });
        });
      });
    } catch (error) {
      send({ type: "sftp-error", requestId, message: error instanceof Error ? error.message : "下载失败" });
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    monitorAbort.abort();
    locations.close();
    if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
    for (const stream of uploadStreams.values()) stream.end();
    uploadStreams.clear();
    sftpSession?.end();
    sftpSession = null;
    shell?.end();
    shell = null;
    conn?.end();
    conn = null;
    tcpStream?.destroy();
    tcpStream = null;
    if (socket.readyState === WebSocket.OPEN) {
      send({ type: "status", state: "closed" });
      socket.close(1000, "SSH session closed");
    }
  }

  return {
    handleClientMessage(message) {
      if (closed) return;
      if (message.type === "ping") send({ type: "pong" });
      if (message.type === "input") handleInput(message.data);
      if (message.type === "resize") handleResize(message.cols, message.rows);
      if (message.type === "sftp-ls") handleSftpLs(message.requestId, message.path);
      if (message.type === "sftp-read") handleSftpRead(message.requestId, message.path);
      if (message.type === "sftp-write") handleSftpWrite(message.requestId, message.path, message.content);
      if (message.type === "sftp-upload") handleSftpUpload(message.requestId, message.path, message.chunk, message.offset, message.done);
      if (message.type === "sftp-download") handleSftpDownload(message.requestId, message.path);
      if (message.type === "process-signal") handleProcessSignal(message.requestId, message.pid, message.signal);
    },
    close,
    get sftpSession() { return sftpSession; }
  };
}

function normalizeFingerprint(value = "") {
  return value.trim().replace(/^SHA256:/i, "").replace(/:/g, "").toLowerCase();
}

class CloudflareSocketDuplex extends Duplex {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private destroyedByClose = false;

  constructor(private readonly tcpSocket: ReturnType<typeof connect>) {
    super();
    this.reader = tcpSocket.readable.getReader();
    this.writer = tcpSocket.writable.getWriter();
    void this.pump();
  }

  _read() {
    // Data is pushed by pump().
  }

  _write(chunk: Buffer | Uint8Array | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : new Uint8Array(chunk);
    this.writer.write(bytes).then(() => callback(), callback);
  }

  _final(callback: (error?: Error | null) => void) {
    this.writer.close().then(() => callback(), callback);
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.destroyedByClose = true;
    Promise.allSettled([this.reader.cancel(), this.writer.abort(error ?? undefined)])
      .then(() => this.tcpSocket.close())
      .then(() => callback(error))
      .catch((closeError) => callback(closeError instanceof Error ? closeError : error));
  }

  private async pump() {
    try {
      while (!this.destroyedByClose) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.push(Buffer.from(value));
      }
      this.push(null);
    } catch (error) {
      if (!this.destroyedByClose) this.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

const terminalCopy = {
  zh: {
    title: "踏风 Tafeng WebSSH",
    selected: "已选择连接：",
    connecting: "正在建立真实 SSH 会话...",
    authenticated: "SSH 认证成功，正在打开终端...",
    sessionClosed: "SSH 会话已关闭",
    connectionClosed: "SSH 连接已断开",
    connectFailed: "连接失败：",
    noProfile: "没有找到要连接的 VPS 配置",
    unknownError: "未知错误"
  },
  en: {
    title: "Tafeng WebSSH",
    selected: "Selected connection: ",
    connecting: "Opening a real SSH session...",
    authenticated: "SSH authentication succeeded, opening terminal...",
    sessionClosed: "SSH session closed",
    connectionClosed: "SSH connection closed",
    connectFailed: "Connection failed: ",
    noProfile: "No VPS profile was found for this connection",
    unknownError: "Unknown error"
  }
} as const;
