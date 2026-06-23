import type { Env } from "./env";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new HttpError(415, "仅支持 JSON 请求");
  try {
    return await request.json<T>();
  } catch {
    throw new HttpError(400, "请求内容不是有效 JSON");
  }
}

export function getCookie(request: Request, name: string) {
  const cookie = request.headers.get("Cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function sessionCookie(env: Env, token: string, maxAge?: number) {
  const seconds = maxAge ?? Math.max(1, Number(env.SESSION_HOURS ?? "12")) * 3600;
  return `highseas_edge_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
}

export function clearSessionCookie() {
  return "highseas_edge_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}

export function requireSameOrigin(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) throw new HttpError(403, "请求来源验证失败");
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return json({ message: error.message, code: error.code }, error.status);
  console.error(error);
  return json({ message: "服务器内部错误" }, 500);
}
