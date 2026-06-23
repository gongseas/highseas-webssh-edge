import type { AppSettings, AuthState, CommandHistoryEntry, QuickCommand, ServerProfile, ServerProfileInput } from "../../shared/types";

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new ApiError(error.message ?? "请求失败", response.status, error.code);
  }
  return response.json() as Promise<T>;
}

export const api = {
  authState: () => request<AuthState>("/api/auth/state"),
  setup: (username: string, password: string) => request<{ authenticated: boolean }>("/api/auth/setup", {
    method: "POST", body: JSON.stringify({ username, password })
  }),
  login: (username: string, password: string, otp?: string) => request<{ authenticated: boolean }>("/api/auth/login", {
    method: "POST", body: JSON.stringify({ username, password, otp })
  }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST", body: "{}" }),
  changePassword: (current: string, next: string) => request<{ ok: boolean }>("/api/auth/change-password", {
    method: "POST", body: JSON.stringify({ current, next })
  }),
  settings: () => request<AppSettings>("/api/settings"),
  saveSettings: (settings: AppSettings) => request<AppSettings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),
  setupTotp: () => request<{ secret: string; otpauthUrl: string }>("/api/totp/setup", { method: "POST", body: "{}" }),
  verifyTotp: (code: string) => request<{ ok: boolean; recoveryCodes: string[] }>("/api/totp/verify", { method: "POST", body: JSON.stringify({ code }) }),
  disableTotp: (password: string, code: string) => request<{ ok: boolean }>("/api/totp/disable", { method: "POST", body: JSON.stringify({ password, code }) }),
  connections: () => request<ServerProfile[]>("/api/connections"),
  createConnection: (profile: ServerProfileInput) => request<ServerProfile>("/api/connections", { method: "POST", body: JSON.stringify(profile) }),
  updateConnection: (id: string, profile: ServerProfileInput) => request<ServerProfile>(`/api/connections/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(profile) }),
  deleteConnection: (id: string) => request<{ ok: boolean }>(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" }),
  quickCommands: () => request<QuickCommand[]>("/api/quick-commands"),
  createQuickCommand: (command: Partial<QuickCommand>) => request<QuickCommand>("/api/quick-commands", { method: "POST", body: JSON.stringify(command) }),
  updateQuickCommand: (command: QuickCommand) => request<QuickCommand>(`/api/quick-commands/${encodeURIComponent(command.id)}`, { method: "PUT", body: JSON.stringify(command) }),
  deleteQuickCommand: (id: string) => request<{ ok: boolean }>(`/api/quick-commands/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" }),
  commandHistory: (limit = 200) => request<{ items: CommandHistoryEntry[]; total: number }>(`/api/command-history?limit=${limit}`),
  clearCommandHistory: () => request<{ ok: boolean }>("/api/command-history", { method: "DELETE", body: "{}" })
};
