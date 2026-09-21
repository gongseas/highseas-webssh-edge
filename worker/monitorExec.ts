import { Buffer } from "node:buffer";
import type { Client, ClientChannel } from "ssh2";

export function captureMonitorExec(client: Pick<Client, "exec">, command: string, signal: AbortSignal, timeoutMs = 12_000, maxBytes = 2 * 1024 * 1024) {
  return new Promise<string>((resolve, reject) => {
    let channel: ClientChannel | undefined;
    let settled = false;
    let bytes = 0;
    const chunks: string[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        try { channel?.close(); } catch { /* The channel may already be gone. */ }
        reject(error);
      } else resolve(chunks.join(""));
    };
    const abort = () => finish(new Error("Monitor cancelled"));
    const timer = setTimeout(() => finish(new Error("Monitor command timed out")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      client.exec(command, (error, stream) => {
        if (settled) {
          if (stream) { stream.on("error", () => {}); stream.close(); }
          return;
        }
        if (error) { finish(error); return; }
        channel = stream;
        stream.on("error", finish);
        stream.stderr.on("data", () => {});
        stream.on("data", (data: Buffer | string) => {
          if (settled) return;
          bytes += Buffer.byteLength(data);
          if (bytes > maxBytes) { finish(new Error("Monitor output exceeds limit")); return; }
          chunks.push(data.toString());
        });
        stream.on("close", (code: number | null) => finish(code ? new Error("Monitor command failed") : undefined));
      });
    } catch (error) { finish(error instanceof Error ? error : new Error("Monitor command failed")); }
  });
}
