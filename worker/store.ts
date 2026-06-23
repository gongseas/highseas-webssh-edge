import type {
  AppSettings,
  CommandHistoryEntry,
  QuickCommand,
  ServerProfile,
  ServerProfileInput
} from "../shared/types";
import { decryptText, encryptText } from "./crypto";
import type { Env } from "./env";
import { HttpError } from "./http";

const DEFAULT_SETTINGS: AppSettings = {
  twoFactorEnabled: false,
  theme: "light",
  language: "zh",
  commandHistoryEnabled: false
};

type ConnectionRow = {
  id: string;
  user_id: string;
  name: string;
  group_name: string;
  host: string;
  port: number;
  username: string;
  credential_kind: "password" | "privateKey";
  credential_enc: string;
  passphrase_enc: string | null;
  host_fingerprint: string;
  created_at: number;
  updated_at: number;
};

type QuickCommandRow = {
  id: string;
  category: string;
  name: string;
  command: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

export async function getSettings(env: Env, userId: string, twoFactorEnabled = false) {
  const row = await env.DB.prepare("SELECT data_json FROM settings WHERE user_id = ?").bind(userId).first<{ data_json: string }>();
  let stored: Partial<AppSettings> = {};
  try { stored = row ? JSON.parse(row.data_json) : {}; } catch { stored = {}; }
  return { ...DEFAULT_SETTINGS, ...stored, twoFactorEnabled } satisfies AppSettings;
}

export async function saveSettings(env: Env, userId: string, input: Partial<AppSettings>, twoFactorEnabled: boolean) {
  const current = await getSettings(env, userId, twoFactorEnabled);
  const next: AppSettings = {
    ...current,
    theme: input.theme === "contrast" ? "contrast" : "light",
    language: input.language === "en" ? "en" : "zh",
    commandHistoryEnabled: input.commandHistoryEnabled === true,
    twoFactorEnabled
  };
  await env.DB.prepare(
    "INSERT INTO settings (user_id, data_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at"
  ).bind(userId, JSON.stringify(next), Date.now()).run();
  return next;
}

export async function listConnections(env: Env, userId: string) {
  const result = await env.DB.prepare("SELECT * FROM connections WHERE user_id = ? ORDER BY group_name, name").bind(userId).all<ConnectionRow>();
  return (result.results ?? []).map(connectionView);
}

export async function createConnection(env: Env, userId: string, input: ServerProfileInput) {
  validateConnection(input, true);
  const id = crypto.randomUUID();
  const now = Date.now();
  const credential = input.credentialKind === "password" ? input.password ?? "" : input.privateKey ?? "";
  await env.DB.prepare(
    `INSERT INTO connections
      (id, user_id, name, group_name, host, port, username, credential_kind, credential_enc, passphrase_enc, host_fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    userId,
    input.name.trim(),
    input.groupName?.trim() || "默认分组",
    input.host.trim(),
    input.port,
    input.username.trim(),
    input.credentialKind,
    await encryptText(env, credential, `connection:${id}:credential`),
    input.passphrase ? await encryptText(env, input.passphrase, `connection:${id}:passphrase`) : null,
    normalizeFingerprint(input.hostFingerprint),
    now,
    now
  ).run();
  return getConnectionView(env, userId, id);
}

export async function updateConnection(env: Env, userId: string, id: string, input: ServerProfileInput) {
  const current = await getConnectionRow(env, userId, id);
  if (!current) throw new HttpError(404, "服务器连接不存在");
  const suppliedCredential = input.credentialKind === "password" ? input.password : input.privateKey;
  validateConnection(input, !current.credential_enc || Boolean(suppliedCredential));
  const credentialEnc = suppliedCredential
    ? await encryptText(env, suppliedCredential, `connection:${id}:credential`)
    : current.credential_enc;
  let passphraseEnc = current.passphrase_enc;
  if (input.credentialKind !== current.credential_kind && !input.passphrase) passphraseEnc = null;
  if (input.passphrase) passphraseEnc = await encryptText(env, input.passphrase, `connection:${id}:passphrase`);

  await env.DB.prepare(
    `UPDATE connections SET name=?, group_name=?, host=?, port=?, username=?, credential_kind=?, credential_enc=?, passphrase_enc=?, host_fingerprint=?, updated_at=?
      WHERE id=? AND user_id=?`
  ).bind(
    input.name.trim(), input.groupName?.trim() || "默认分组", input.host.trim(), input.port, input.username.trim(),
    input.credentialKind, credentialEnc, passphraseEnc, normalizeFingerprint(input.hostFingerprint), Date.now(), id, userId
  ).run();
  return getConnectionView(env, userId, id);
}

export async function deleteConnection(env: Env, userId: string, id: string) {
  await env.DB.prepare("DELETE FROM connections WHERE id = ? AND user_id = ?").bind(id, userId).run();
}

export async function resolveConnection(env: Env, userId: string, id: string): Promise<ServerProfile | null> {
  const row = await getConnectionRow(env, userId, id);
  if (!row) return null;
  const credential = await decryptText(env, row.credential_enc, `connection:${id}:credential`);
  const passphrase = await decryptText(env, row.passphrase_enc, `connection:${id}:passphrase`);
  return {
    ...connectionView(row),
    password: row.credential_kind === "password" ? credential : undefined,
    privateKey: row.credential_kind === "privateKey" ? credential : undefined,
    passphrase: passphrase || undefined
  };
}

export async function listQuickCommands(env: Env, userId: string) {
  const result = await env.DB.prepare("SELECT * FROM quick_commands WHERE user_id = ? ORDER BY category, sort_order, name").bind(userId).all<QuickCommandRow>();
  return (result.results ?? []).map(quickCommandView);
}

export async function createQuickCommand(env: Env, userId: string, input: Partial<QuickCommand>) {
  validateQuickCommand(input);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO quick_commands (id, user_id, category, name, command, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, userId, input.category!.trim(), input.name!.trim(), input.command!, Number(input.sortOrder ?? 0), now, now).run();
  return { id, category: input.category!.trim(), name: input.name!.trim(), command: input.command!, sortOrder: Number(input.sortOrder ?? 0), createdAt: iso(now), updatedAt: iso(now) };
}

export async function updateQuickCommand(env: Env, userId: string, id: string, input: Partial<QuickCommand>) {
  validateQuickCommand(input);
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE quick_commands SET category=?, name=?, command=?, sort_order=?, updated_at=? WHERE id=? AND user_id=?"
  ).bind(input.category!.trim(), input.name!.trim(), input.command!, Number(input.sortOrder ?? 0), now, id, userId).run();
  if (!result.meta.changes) throw new HttpError(404, "快捷命令不存在");
  return { id, category: input.category!.trim(), name: input.name!.trim(), command: input.command!, sortOrder: Number(input.sortOrder ?? 0), createdAt: iso(now), updatedAt: iso(now) };
}

export async function deleteQuickCommand(env: Env, userId: string, id: string) {
  await env.DB.prepare("DELETE FROM quick_commands WHERE id=? AND user_id=?").bind(id, userId).run();
}

export async function appendCommandHistory(env: Env, userId: string, connectionId: string | null, command: string) {
  const sanitized = command.trim().slice(0, 4_096);
  if (!sanitized || looksSensitive(sanitized)) return;
  await env.DB.prepare("INSERT INTO command_history (id, user_id, connection_id, command, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, connectionId, sanitized, Date.now()).run();
  await env.DB.prepare(
    "DELETE FROM command_history WHERE user_id=? AND id NOT IN (SELECT id FROM command_history WHERE user_id=? ORDER BY created_at DESC LIMIT 1000)"
  ).bind(userId, userId).run();
}

export async function listCommandHistory(env: Env, userId: string, limit = 200): Promise<{ items: CommandHistoryEntry[]; total: number }> {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const result = await env.DB.prepare(
    `SELECT h.id, h.command, h.connection_id, h.created_at, c.name, c.host, c.username
       FROM command_history h LEFT JOIN connections c ON c.id=h.connection_id
      WHERE h.user_id=? ORDER BY h.created_at DESC LIMIT ?`
  ).bind(userId, safeLimit).all<Record<string, unknown>>();
  const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM command_history WHERE user_id=?").bind(userId).first<{ count: number }>();
  return {
    items: (result.results ?? []).map((row) => ({
      id: String(row.id), command: String(row.command), profileId: row.connection_id ? String(row.connection_id) : null,
      profileName: row.name ? String(row.name) : "已删除的连接", host: row.host ? String(row.host) : null,
      username: row.username ? String(row.username) : null, createdAt: iso(Number(row.created_at))
    })),
    total: Number(total?.count ?? 0)
  };
}

export async function clearCommandHistory(env: Env, userId: string) {
  await env.DB.prepare("DELETE FROM command_history WHERE user_id=?").bind(userId).run();
}

async function getConnectionView(env: Env, userId: string, id: string) {
  const row = await getConnectionRow(env, userId, id);
  if (!row) throw new HttpError(404, "服务器连接不存在");
  return connectionView(row);
}

async function getConnectionRow(env: Env, userId: string, id: string) {
  return env.DB.prepare("SELECT * FROM connections WHERE id=? AND user_id=?").bind(id, userId).first<ConnectionRow>();
}

function connectionView(row: ConnectionRow): ServerProfile {
  return {
    id: row.id, name: row.name, groupName: row.group_name, host: row.host, port: row.port, username: row.username,
    credentialKind: row.credential_kind, hasCredential: Boolean(row.credential_enc), hostFingerprint: row.host_fingerprint,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function quickCommandView(row: QuickCommandRow): QuickCommand {
  return {
    id: row.id, category: row.category, name: row.name, command: row.command, sortOrder: row.sort_order,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function validateConnection(input: ServerProfileInput, credentialRequired: boolean) {
  if (!input.name?.trim() || input.name.length > 80) throw new HttpError(400, "连接名称无效");
  if (!input.host?.trim() || /[\s/]/.test(input.host) || input.host.length > 253) throw new HttpError(400, "服务器地址无效");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new HttpError(400, "SSH 端口无效");
  if (!input.username?.trim() || input.username.length > 64) throw new HttpError(400, "SSH 用户名无效");
  if (!(["password", "privateKey"] as const).includes(input.credentialKind)) throw new HttpError(400, "认证方式无效");
  const credential = input.credentialKind === "password" ? input.password : input.privateKey;
  if (credentialRequired && !credential) throw new HttpError(400, input.credentialKind === "password" ? "请输入 SSH 密码" : "请上传或粘贴私钥");
  if ((credential?.length ?? 0) > 64 * 1024) throw new HttpError(400, "凭据内容过大");
}

function validateQuickCommand(input: Partial<QuickCommand>) {
  if (!input.category?.trim() || input.category.length > 40) throw new HttpError(400, "命令分类无效");
  if (!input.name?.trim() || input.name.length > 80) throw new HttpError(400, "命令名称无效");
  if (!input.command?.trim() || input.command.length > 8_192) throw new HttpError(400, "命令内容无效");
}

function normalizeFingerprint(value = "") {
  return value.trim().replace(/^SHA256:/i, "").replace(/:/g, "").toLowerCase();
}

function looksSensitive(command: string) {
  return /(?:password|passwd|token|secret|api[_-]?key|private[_-]?key)\s*[=:]/i.test(command);
}

function iso(timestamp: number) {
  return new Date(timestamp).toISOString();
}
