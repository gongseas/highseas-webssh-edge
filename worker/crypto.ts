import { createHmac } from "node:crypto";
import type { Env } from "./env";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PASSWORD_HASH_VERSION = "v2";

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function randomToken(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

function passwordPepper(env: Env) {
  const raw = base64ToBytes(env.PASSWORD_PEPPER ?? "");
  if (raw.byteLength !== 32) throw new Error("PASSWORD_PEPPER must be a base64-encoded 32-byte key");
  return raw;
}

export async function hashPassword(env: Env, password: string, salt = randomToken(18)) {
  const signature = createHmac("sha256", passwordPepper(env))
    .update(`${PASSWORD_HASH_VERSION}\0${salt}\0${password}`, "utf8")
    .digest();
  return { salt, hash: `${PASSWORD_HASH_VERSION}.${toBase64Url(signature)}` };
}

export async function verifyPassword(env: Env, password: string, salt: string, expected: string) {
  if (!expected.startsWith(`${PASSWORD_HASH_VERSION}.`)) return false;
  const actual = (await hashPassword(env, password, salt)).hash;
  if (actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return mismatch === 0;
}

async function masterKey(env: Env) {
  const raw = base64ToBytes(env.MASTER_KEY ?? "");
  if (raw.byteLength !== 32) throw new Error("MASTER_KEY must be a base64-encoded 32-byte key");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptText(env: Env, value: string, context: string) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context), tagLength: 128 },
    await masterKey(env),
    encoder.encode(value)
  );
  return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptText(env: Env, value: string | null, context: string) {
  if (!value) return "";
  const [version, ivValue, cipherValue] = value.split(".");
  if (version !== "v1" || !ivValue || !cipherValue) throw new Error("Unsupported encrypted value");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivValue), additionalData: encoder.encode(context), tagLength: 128 },
    await masterKey(env),
    base64ToBytes(cipherValue)
  );
  return decoder.decode(decrypted);
}
