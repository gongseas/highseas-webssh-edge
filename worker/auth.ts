import type { UserView } from "../shared/types";
import { decryptText, encryptText, hashPassword, randomToken, sha256, verifyPassword } from "./crypto";
import type { Env } from "./env";
import { getCookie, HttpError, sessionCookie } from "./http";
import { verifyTotp } from "./totp";

const SESSION_COOKIE = "highseas_edge_session";
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_BLOCK_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 5;

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  password_salt: string;
  totp_secret_enc: string | null;
  recovery_hashes: string;
};

export type AuthContext = { user: UserView; tokenHash: string };

function userView(row: UserRow): UserView {
  return { id: row.id, username: row.username, twoFactorEnabled: Boolean(row.totp_secret_enc) };
}

export async function needsSetup(env: Env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
  return Number(row?.count ?? 0) === 0;
}

export async function setupFirstUser(env: Env, username: string, password: string) {
  if (!(await needsSetup(env))) throw new HttpError(409, "系统已经完成初始化");
  validateCredentials(username, password);
  const id = crypto.randomUUID();
  const now = Date.now();
  const passwordValue = await hashPassword(env, password);
  try {
    await env.DB.prepare(
      "INSERT INTO users (id, username, password_hash, password_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, username.trim(), passwordValue.hash, passwordValue.salt, now, now).run();
  } catch {
    throw new HttpError(409, "系统已经完成初始化");
  }
  return createSession(env, { id, username: username.trim(), twoFactorEnabled: false }, "setup", "setup");
}

export async function login(env: Env, username: string, password: string, otp: string | undefined, ip: string, userAgent: string) {
  await assertLoginAllowed(env, ip);
  const row = await env.DB.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").bind(username.trim()).first<UserRow>();
  const validPassword = row ? await verifyPassword(env, password, row.password_salt, row.password_hash) : false;
  if (!row || !validPassword) {
    await recordLoginFailure(env, ip);
    throw new HttpError(401, "用户名、密码或动态验证码错误", "INVALID_CREDENTIALS");
  }

  if (row.totp_secret_enc) {
    if (!otp) throw new HttpError(401, "请输入六位动态验证码", "TOTP_REQUIRED");
    const secret = await decryptText(env, row.totp_secret_enc, `user:${row.id}:totp`);
    if (!(await verifyTotp(otp, secret))) {
      if (!(await consumeRecoveryCode(env, row, otp))) {
        await recordLoginFailure(env, ip);
        throw new HttpError(401, "用户名、密码或动态验证码错误", "INVALID_CREDENTIALS");
      }
    }
  }

  await clearLoginFailures(env, ip);
  return createSession(env, userView(row), ip, userAgent);
}

export async function createSession(env: Env, user: UserView, ip: string, userAgent: string) {
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const now = Date.now();
  const expiresAt = now + Math.max(1, Number(env.SESSION_HOURS ?? "12")) * 3_600_000;
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, ip_hash, user_agent_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(tokenHash, user.id, await sha256(ip), await sha256(userAgent), now, expiresAt).run();
  return { token, cookie: sessionCookie(env, token), user };
}

export async function authenticate(request: Request, env: Env): Promise<AuthContext | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.password_hash, u.password_salt, u.totp_secret_enc, u.recovery_hashes
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(tokenHash, Date.now()).first<UserRow>();
  return row ? { user: userView(row), tokenHash } : null;
}

export async function requireAuth(request: Request, env: Env) {
  const auth = await authenticate(request, env);
  if (!auth) throw new HttpError(401, "登录已过期，请重新登录", "UNAUTHORIZED");
  return auth;
}

export async function logout(env: Env, tokenHash: string) {
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export async function changePassword(env: Env, userId: string, current: string, next: string) {
  if (next.length < 12) throw new HttpError(400, "新密码至少需要 12 位");
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
  if (!row || !(await verifyPassword(env, current, row.password_salt, row.password_hash))) throw new HttpError(403, "当前密码错误");
  const value = await hashPassword(env, next);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?").bind(value.hash, value.salt, Date.now(), userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId)
  ]);
}

export async function savePendingTotp(env: Env, userId: string, secret: string) {
  const encrypted = await encryptText(env, secret, `user:${userId}:totp-pending`);
  await env.DB.prepare(
    "INSERT INTO totp_pending (user_id, secret_enc, expires_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET secret_enc=excluded.secret_enc, expires_at=excluded.expires_at"
  ).bind(userId, encrypted, Date.now() + 10 * 60_000).run();
}

export async function enableTotp(env: Env, userId: string, code: string) {
  const pending = await env.DB.prepare("SELECT secret_enc, expires_at FROM totp_pending WHERE user_id = ?").bind(userId).first<{ secret_enc: string; expires_at: number }>();
  if (!pending || pending.expires_at < Date.now()) throw new HttpError(400, "二维码已过期，请重新开始设置");
  const secret = await decryptText(env, pending.secret_enc, `user:${userId}:totp-pending`);
  if (!(await verifyTotp(code, secret))) throw new HttpError(400, "动态验证码错误，请确认设备时间准确");
  const recoveryCodes = Array.from({ length: 8 }, () => `${randomToken(4)}-${randomToken(4)}`);
  const recoveryHashes = await Promise.all(recoveryCodes.map((item) => sha256(normalizeRecoveryCode(item))));
  const encrypted = await encryptText(env, secret, `user:${userId}:totp`);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET totp_secret_enc = ?, recovery_hashes = ?, updated_at = ? WHERE id = ?").bind(encrypted, JSON.stringify(recoveryHashes), Date.now(), userId),
    env.DB.prepare("DELETE FROM totp_pending WHERE user_id = ?").bind(userId)
  ]);
  return recoveryCodes;
}

export async function disableTotp(env: Env, userId: string, password: string, code: string) {
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
  if (!row || !(await verifyPassword(env, password, row.password_salt, row.password_hash))) throw new HttpError(403, "密码错误");
  if (!row.totp_secret_enc) throw new HttpError(400, "尚未启用两步验证");
  const secret = await decryptText(env, row.totp_secret_enc, `user:${userId}:totp`);
  if (!(await verifyTotp(code, secret))) throw new HttpError(403, "动态验证码错误");
  await env.DB.prepare("UPDATE users SET totp_secret_enc = NULL, recovery_hashes = '[]', updated_at = ? WHERE id = ?").bind(Date.now(), userId).run();
}

async function consumeRecoveryCode(env: Env, row: UserRow, code: string) {
  if (!code.includes("-")) return false;
  const hash = await sha256(normalizeRecoveryCode(code));
  const hashes = JSON.parse(row.recovery_hashes || "[]") as string[];
  const index = hashes.indexOf(hash);
  if (index < 0) return false;
  hashes.splice(index, 1);
  await env.DB.prepare("UPDATE users SET recovery_hashes = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(hashes), Date.now(), row.id).run();
  return true;
}

function normalizeRecoveryCode(value: string) {
  return value.trim().toLowerCase().replace(/\s/g, "");
}

function validateCredentials(username: string, password: string) {
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username.trim())) throw new HttpError(400, "用户名仅支持字母、数字、下划线和连字符（3-32 位）");
  if (password.length < 12) throw new HttpError(400, "密码至少需要 12 位");
}

async function loginKey(ip: string) {
  return sha256(`login:${ip}`);
}

async function assertLoginAllowed(env: Env, ip: string) {
  const row = await env.DB.prepare("SELECT * FROM login_attempts WHERE key_hash = ?").bind(await loginKey(ip)).first<{ blocked_until: number }>();
  if (row && row.blocked_until > Date.now()) throw new HttpError(429, "登录尝试过多，请稍后再试", "RATE_LIMITED");
}

async function recordLoginFailure(env: Env, ip: string) {
  const key = await loginKey(ip);
  const now = Date.now();
  const row = await env.DB.prepare("SELECT failures, window_started FROM login_attempts WHERE key_hash = ?").bind(key).first<{ failures: number; window_started: number }>();
  const failures = !row || now - row.window_started > LOGIN_WINDOW_MS ? 1 : row.failures + 1;
  const windowStarted = !row || now - row.window_started > LOGIN_WINDOW_MS ? now : row.window_started;
  const blockedUntil = failures >= LOGIN_MAX_FAILURES ? now + LOGIN_BLOCK_MS : 0;
  await env.DB.prepare(
    "INSERT INTO login_attempts (key_hash, failures, window_started, blocked_until) VALUES (?, ?, ?, ?) ON CONFLICT(key_hash) DO UPDATE SET failures=excluded.failures, window_started=excluded.window_started, blocked_until=excluded.blocked_until"
  ).bind(key, failures, windowStarted, blockedUntil).run();
}

async function clearLoginFailures(env: Env, ip: string) {
  await env.DB.prepare("DELETE FROM login_attempts WHERE key_hash = ?").bind(await loginKey(ip)).run();
}
