import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { randomBytes, webcrypto } from "node:crypto";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { authenticate, login, needsSetup, setupFirstUser } from "../worker/auth";
import type { Env } from "../worker/env";
import { createConnection, createQuickCommand, listConnections, listQuickCommands, resolveConnection } from "../worker/store";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

class MockStatement {
  private values: unknown[] = [];
  constructor(private database: Database, private sql: string) {}
  bind(...values: unknown[]) { const next = new MockStatement(this.database, this.sql); next.values = values; return next; }
  async first<T>() {
    const statement = this.database.prepare(this.sql);
    try { statement.bind(this.values as never[]); return (statement.step() ? statement.getAsObject() : null) as T | null; }
    finally { statement.free(); }
  }
  async all<T>() {
    const statement = this.database.prepare(this.sql);
    const results: T[] = [];
    try { statement.bind(this.values as never[]); while (statement.step()) results.push(statement.getAsObject() as T); }
    finally { statement.free(); }
    return { success: true, results, meta: { changes: 0 } };
  }
  async run() {
    this.database.run(this.sql, this.values as never[]);
    return { success: true, results: [], meta: { changes: this.database.getRowsModified() } };
  }
}

class MockD1 {
  constructor(private database: Database) {}
  prepare(sql: string) { return new MockStatement(this.database, sql); }
  async batch(statements: MockStatement[]) {
    this.database.run("BEGIN");
    try { const result = []; for (const statement of statements) result.push(await statement.run()); this.database.run("COMMIT"); return result; }
    catch (error) { this.database.run("ROLLBACK"); throw error; }
  }
}

async function fixture(SQL: SqlJsStatic) {
  const database = new SQL.Database();
  database.run(await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  const env = {
    DB: new MockD1(database),
    MASTER_KEY: randomBytes(32).toString("base64"),
    PASSWORD_PEPPER: randomBytes(32).toString("base64"),
    SESSION_HOURS: "12",
    APP_NAME: "Highseas WebSSH"
  } as unknown as Env;
  return { database, env };
}

const SQL = await initSqlJs({ locateFile: (file) => fileURLToPath(new URL(`../node_modules/sql.js/dist/${file}`, import.meta.url)) });

test("initial setup hashes passwords and creates a usable session", async () => {
  const { database, env } = await fixture(SQL);
  assert.equal(await needsSetup(env), true);
  const session = await setupFirstUser(env, "admin", "correct horse battery staple");
  assert.equal(await needsSetup(env), false);
  const storedHash = String(database.exec("SELECT password_hash FROM users")[0].values[0][0]);
  assert.equal(storedHash.startsWith("v2."), true);
  assert.equal(storedHash.includes("correct horse battery staple"), false);
  const request = new Request("https://edge.example/api/auth/state", { headers: { Cookie: `highseas_edge_session=${session.token}` } });
  const auth = await authenticate(request, env);
  assert.equal(auth?.user.username, "admin");
  const wrongPepperEnv = { ...env, PASSWORD_PEPPER: randomBytes(32).toString("base64") } as Env;
  await assert.rejects(() => login(wrongPepperEnv, "admin", "correct horse battery staple", undefined, "203.0.113.1", "test"));
  await assert.rejects(() => setupFirstUser(env, "other", "another secure password"));
});

test("connection credentials are encrypted and never returned by list APIs", async () => {
  const { database, env } = await fixture(SQL);
  const session = await setupFirstUser(env, "admin", "correct horse battery staple");
  const created = await createConnection(env, session.user.id, {
    name: "Production", groupName: "Servers", host: "203.0.113.10", port: 22, username: "root",
    credentialKind: "password", password: "ssh-secret-value", privateKey: "", passphrase: "", hostFingerprint: "abc123"
  });
  assert.equal(created.password, undefined);
  const listed = await listConnections(env, session.user.id);
  assert.equal(listed[0].hasCredential, true);
  assert.equal(JSON.stringify(listed).includes("ssh-secret-value"), false);
  const raw = String(database.exec("SELECT credential_enc FROM connections")[0].values[0][0]);
  assert.equal(raw.includes("ssh-secret-value"), false);
  assert.equal((await resolveConnection(env, session.user.id, created.id))?.password, "ssh-secret-value");
});

test("quick commands are scoped to their owner", async () => {
  const { env } = await fixture(SQL);
  const session = await setupFirstUser(env, "admin", "correct horse battery staple");
  await createQuickCommand(env, session.user.id, { category: "System", name: "Disk", command: "df -h", sortOrder: 0 });
  assert.deepEqual((await listQuickCommands(env, session.user.id)).map((item) => item.command), ["df -h"]);
  assert.equal((await listQuickCommands(env, "another-user")).length, 0);
});

test("login failures are rate limited", async () => {
  const { env } = await fixture(SQL);
  await setupFirstUser(env, "admin", "correct horse battery staple");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(() => login(env, "admin", "wrong password", undefined, "198.51.100.20", "test"));
  }
  await assert.rejects(
    () => login(env, "admin", "correct horse battery staple", undefined, "198.51.100.20", "test"),
    (error: unknown) => error instanceof Error && error.message.includes("登录尝试过多")
  );
});
