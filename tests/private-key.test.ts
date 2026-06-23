import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ssh2 from "ssh2";
import { normalizePrivateKeyForSsh } from "../worker/privateKey";

const fixtureUrl = new URL("../node_modules/ssh2/test/fixtures/keyParser/ppk_rsa", import.meta.url);

test("PPK v2 keys are converted into an ssh2-compatible private key", async () => {
  const ppk = await readFile(fixtureUrl, "utf8");
  const converted = normalizePrivateKeyForSsh(ppk);
  assert.match(converted, /BEGIN (?:OPENSSH |RSA )?PRIVATE KEY/);
  assert.equal(ssh2.utils.parseKey(converted) instanceof Error, false);
});

test("encrypted PPK v2 keys use the configured passphrase", async () => {
  const encrypted = await readFile(new URL("../node_modules/ssh2/test/fixtures/keyParser/ppk_rsa_enc", import.meta.url), "utf8");
  const converted = normalizePrivateKeyForSsh(encrypted, "node.js");
  assert.equal(ssh2.utils.parseKey(converted) instanceof Error, false);
  assert.throws(() => normalizePrivateKeyForSsh(encrypted, "wrong-passphrase"), /PPK 私钥解析失败/);
});

test("unencrypted PPK v3 keys are converted and encrypted v3 keys get a clear error", async () => {
  const ppk2 = await readFile(fixtureUrl, "utf8");
  const ppk3 = ppk2.replace("PuTTY-User-Key-File-2:", "PuTTY-User-Key-File-3:");
  const converted = normalizePrivateKeyForSsh(ppk3);
  assert.equal(ssh2.utils.parseKey(converted) instanceof Error, false);
  assert.throws(
    () => normalizePrivateKeyForSsh(ppk3.replace("Encryption: none", "Encryption: aes256-cbc"), "secret"),
    /PPK v3/
  );
});
