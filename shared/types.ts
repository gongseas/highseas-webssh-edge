export type ThemeMode = "light" | "contrast";
export type Language = "zh" | "en";
export type CredentialKind = "password" | "privateKey";

export type UserView = {
  id: string;
  username: string;
  twoFactorEnabled: boolean;
};

export type AuthState = {
  needsSetup: boolean;
  authenticated: boolean;
  user?: UserView;
};

export type AppSettings = {
  twoFactorEnabled: boolean;
  theme: ThemeMode;
  language: Language;
  commandHistoryEnabled: boolean;
};

export type ServerProfile = {
  id: string;
  name: string;
  groupName: string;
  host: string;
  port: number;
  username: string;
  credentialKind: CredentialKind;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  hasCredential: boolean;
  hostFingerprint: string;
  createdAt: string;
  updatedAt: string;
};

export type ServerProfileInput = Omit<ServerProfile, "id" | "hasCredential" | "createdAt" | "updatedAt">;

export type QuickCommand = {
  id: string;
  category: string;
  name: string;
  command: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ServerMetrics = {
  cpuPercent: number;
  memory: UsageStat;
  swap: UsageStat;
  disk: UsageStat;
  network?: { receiveBytesPerSecond: number; transmitBytesPerSecond: number };
  hostname: string;
  kernel: string;
  uptimeSeconds: number;
  loadAverage: [number, number, number];
  listeningPorts: ListeningPort[];
  udpMonitorVersion?: string;
  updatedAt: string;
};

export type UsageStat = { used: number; total: number; percent: number };

export type ProcessInfo = {
  pid: number;
  user: string;
  cpu: number;
  memory: number;
  command: string;
};

export type ConnectedIp = {
  ip: string;
  ports: number[];
  region: string;
  connectionCount: number;
  receiveBytesPerSecond: number;
  transmitBytesPerSecond: number;
};

export type ListeningPort = {
  pid: number | null;
  processName: string;
  protocol: string;
  listenIp: string;
  listenPort: number;
  ipCount: number;
  connectionCount: number;
  receiveBytesPerSecond: number;
  transmitBytesPerSecond: number;
  connectedIps: ConnectedIp[];
};

export type CommandHistoryEntry = {
  id: string;
  command: string;
  profileId: string | null;
  profileName: string;
  host: string | null;
  username: string | null;
  createdAt: string;
};

export type RemoteFile = {
  name: string;
  path: string;
  size: number;
  type: "file" | "directory";
  modifiedAt: string;
};

export type TerminalMessage =
  | { type: "ping" }
  | { type: "pong" }
  | { type: "monitor-status"; state: "ok" | "retrying" }
  | { type: "hello"; profileId: string }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "output"; data: string }
  | { type: "status"; state: "connecting" | "connected" | "closed" }
  | { type: "host-key"; fingerprint: string; verified: boolean }
  | { type: "metrics"; metrics: ServerMetrics; processes: ProcessInfo[] }
  | { type: "process-signal"; requestId: string; pid: number; signal: "TERM" | "KILL" | "HUP" }
  | { type: "process-signal-result"; requestId: string; pid: number; ok: boolean; message: string }
  | { type: "error"; message: string }
  | { type: "sftp-ls"; requestId: string; path: string }
  | { type: "sftp-read"; requestId: string; path: string }
  | { type: "sftp-write"; requestId: string; path: string; content: string }
  | { type: "sftp-upload"; requestId: string; path: string; chunk: string; offset: number; done: boolean }
  | { type: "sftp-download"; requestId: string; path: string }
  | { type: "sftp-ls-result"; requestId: string; files: RemoteFile[] }
  | { type: "sftp-read-result"; requestId: string; path: string; content: string }
  | { type: "sftp-write-result"; requestId: string; ok: boolean }
  | { type: "sftp-upload-progress"; requestId: string; offset: number; done: boolean }
  | { type: "sftp-download-chunk"; requestId: string; chunk: string; done: boolean }
  | { type: "sftp-error"; requestId: string; message: string };
