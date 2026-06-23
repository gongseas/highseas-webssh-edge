import type { AppSettings, QuickCommand, ServerProfileInput, TerminalMessage } from "../shared/types";
import {
  authenticate,
  changePassword,
  disableTotp,
  enableTotp,
  login,
  logout,
  needsSetup,
  requireAuth,
  savePendingTotp,
  setupFirstUser
} from "./auth";
import type { Env } from "./env";
import { requireConfiguredEnv } from "./env";
import { clearSessionCookie, errorResponse, HttpError, json, readJson, requireSameOrigin } from "./http";
import { createSshBridge } from "./sshBridge";
import {
  appendCommandHistory,
  clearCommandHistory,
  createConnection,
  createQuickCommand,
  deleteConnection,
  deleteQuickCommand,
  getSettings,
  listCommandHistory,
  listConnections,
  listQuickCommands,
  resolveConnection,
  saveSettings,
  updateConnection,
  updateQuickCommand
} from "./store";
import { createOtpAuthUrl, generateTotpSecret } from "./totp";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) {
        requireConfiguredEnv(env);
        requireSameOrigin(request);
      }

      let response: Response;
      if (url.pathname === "/api/auth/state" && request.method === "GET") response = await authState(request, env);
      else if (url.pathname === "/api/auth/setup" && request.method === "POST") response = await authSetup(request, env);
      else if (url.pathname === "/api/auth/login" && request.method === "POST") response = await authLogin(request, env);
      else if (url.pathname === "/api/auth/logout" && request.method === "POST") response = await authLogout(request, env);
      else if (url.pathname === "/api/auth/change-password" && request.method === "POST") response = await authChangePassword(request, env);
      else if (url.pathname === "/api/totp/setup" && request.method === "POST") response = await totpSetup(request, env);
      else if (url.pathname === "/api/totp/verify" && request.method === "POST") response = await totpVerify(request, env);
      else if (url.pathname === "/api/totp/disable" && request.method === "POST") response = await totpDisable(request, env);
      else if (url.pathname === "/api/settings") response = await settingsRoute(request, env);
      else if (url.pathname === "/api/connections") response = await connectionsRoute(request, env);
      else if (url.pathname.startsWith("/api/connections/")) response = await connectionRoute(request, env, decodeURIComponent(url.pathname.slice(17)));
      else if (url.pathname === "/api/quick-commands") response = await quickCommandsRoute(request, env);
      else if (url.pathname.startsWith("/api/quick-commands/")) response = await quickCommandRoute(request, env, decodeURIComponent(url.pathname.slice(20)));
      else if (url.pathname === "/api/command-history") response = await commandHistoryRoute(request, env, url);
      else if (url.pathname === "/ws/terminal") response = await terminalSocket(request, env, ctx, url);
      else response = await env.ASSETS.fetch(request);

      return withSecurityHeaders(response);
    } catch (error) {
      return withSecurityHeaders(errorResponse(error));
    }
  }
};

async function authState(request: Request, env: Env) {
  const [setup, auth] = await Promise.all([needsSetup(env), authenticate(request, env)]);
  return json({ needsSetup: setup, authenticated: Boolean(auth), user: auth?.user });
}

async function authSetup(request: Request, env: Env) {
  const body = await readJson<{ username?: string; password?: string }>(request);
  const session = await setupFirstUser(env, body.username ?? "", body.password ?? "");
  return json({ authenticated: true, user: session.user }, 201, { "Set-Cookie": session.cookie });
}

async function authLogin(request: Request, env: Env) {
  const body = await readJson<{ username?: string; password?: string; otp?: string }>(request);
  if (!body.username || !body.password) throw new HttpError(400, "请输入用户名和密码");
  const session = await login(env, body.username, body.password, body.otp, clientIp(request), request.headers.get("User-Agent") ?? "");
  return json({ authenticated: true, user: session.user }, 200, { "Set-Cookie": session.cookie });
}

async function authLogout(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  await logout(env, auth.tokenHash);
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

async function authChangePassword(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  const body = await readJson<{ current?: string; next?: string }>(request);
  await changePassword(env, auth.user.id, body.current ?? "", body.next ?? "");
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

async function totpSetup(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  if (auth.user.twoFactorEnabled) throw new HttpError(409, "两步验证已经启用");
  const secret = generateTotpSecret();
  await savePendingTotp(env, auth.user.id, secret);
  return json({ secret, otpauthUrl: createOtpAuthUrl(secret, env.APP_NAME ?? "Highseas WebSSH", auth.user.username) });
}

async function totpVerify(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  const body = await readJson<{ code?: string }>(request);
  const recoveryCodes = await enableTotp(env, auth.user.id, body.code ?? "");
  return json({ ok: true, recoveryCodes });
}

async function totpDisable(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  const body = await readJson<{ password?: string; code?: string }>(request);
  await disableTotp(env, auth.user.id, body.password ?? "", body.code ?? "");
  return json({ ok: true });
}

async function settingsRoute(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  if (request.method === "GET") return json(await getSettings(env, auth.user.id, auth.user.twoFactorEnabled));
  if (request.method === "PUT") {
    const body = await readJson<Partial<AppSettings>>(request);
    return json(await saveSettings(env, auth.user.id, body, auth.user.twoFactorEnabled));
  }
  throw new HttpError(405, "不支持的请求方法");
}

async function connectionsRoute(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  if (request.method === "GET") return json(await listConnections(env, auth.user.id));
  if (request.method === "POST") return json(await createConnection(env, auth.user.id, await readJson<ServerProfileInput>(request)), 201);
  throw new HttpError(405, "不支持的请求方法");
}

async function connectionRoute(request: Request, env: Env, id: string) {
  const auth = await requireAuth(request, env);
  if (request.method === "PUT") return json(await updateConnection(env, auth.user.id, id, await readJson<ServerProfileInput>(request)));
  if (request.method === "DELETE") {
    await deleteConnection(env, auth.user.id, id);
    return json({ ok: true });
  }
  throw new HttpError(405, "不支持的请求方法");
}

async function quickCommandsRoute(request: Request, env: Env) {
  const auth = await requireAuth(request, env);
  if (request.method === "GET") return json(await listQuickCommands(env, auth.user.id));
  if (request.method === "POST") return json(await createQuickCommand(env, auth.user.id, await readJson<Partial<QuickCommand>>(request)), 201);
  throw new HttpError(405, "不支持的请求方法");
}

async function quickCommandRoute(request: Request, env: Env, id: string) {
  const auth = await requireAuth(request, env);
  if (request.method === "PUT") return json(await updateQuickCommand(env, auth.user.id, id, await readJson<Partial<QuickCommand>>(request)));
  if (request.method === "DELETE") {
    await deleteQuickCommand(env, auth.user.id, id);
    return json({ ok: true });
  }
  throw new HttpError(405, "不支持的请求方法");
}

async function commandHistoryRoute(request: Request, env: Env, url: URL) {
  const auth = await requireAuth(request, env);
  if (request.method === "GET") return json(await listCommandHistory(env, auth.user.id, Number(url.searchParams.get("limit") ?? 200)));
  if (request.method === "DELETE") {
    await clearCommandHistory(env, auth.user.id);
    return json({ ok: true });
  }
  throw new HttpError(405, "不支持的请求方法");
}

async function terminalSocket(request: Request, env: Env, ctx: ExecutionContext, url: URL) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "需要 WebSocket 连接");
  if (request.headers.get("Origin") !== url.origin) throw new HttpError(403, "WebSocket 来源验证失败");
  const auth = await requireAuth(request, env);
  const profileId = url.searchParams.get("profileId");
  if (!profileId) throw new HttpError(400, "缺少服务器连接 ID");
  const profile = await resolveConnection(env, auth.user.id, profileId);
  if (!profile) throw new HttpError(404, "服务器连接不存在");
  const settings = await getSettings(env, auth.user.id, auth.user.twoFactorEnabled);

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  const bridge = createSshBridge(server, {
    profile,
    language: url.searchParams.get("language") === "en" ? "en" : "zh",
    onCommand(command) {
      if (settings.commandHistoryEnabled) ctx.waitUntil(appendCommandHistory(env, auth.user.id, profileId, command));
    }
  });
  server.addEventListener("message", (event) => {
    try { bridge.handleClientMessage(JSON.parse(String(event.data)) as TerminalMessage); }
    catch { server.send(JSON.stringify({ type: "error", message: "终端消息格式错误" })); }
  });
  server.addEventListener("close", () => bridge.close());
  server.addEventListener("error", () => bridge.close());
  return new Response(null, { status: 101, webSocket: client });
}

function clientIp(request: Request) {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown";
}

function withSecurityHeaders(response: Response) {
  if (response.status === 101) return response;
  const next = new Response(response.body, response);
  next.headers.set("X-Content-Type-Options", "nosniff");
  next.headers.set("X-Frame-Options", "DENY");
  next.headers.set("Referrer-Policy", "no-referrer");
  next.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  next.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  return next;
}
