import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const wranglerCli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const tscCli = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const viteCli = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const workerBuildScript = fileURLToPath(new URL("../build-worker.mjs", import.meta.url));
const configPath = new URL("../wrangler.jsonc", import.meta.url);
const keyPath = new URL("../highseas-master-key.txt", import.meta.url);
const placeholderDatabaseId = "REPLACE_WITH_D1_DATABASE_ID";

function readConfig() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function getDatabaseBindings(config) {
  return Array.isArray(config.d1_databases) ? config.d1_databases : [];
}

function findDatabase(config) {
  return [...getDatabaseBindings(config)].reverse().find(
    (database) => database.binding === "DB" && database.database_id && database.database_id !== placeholderDatabaseId,
  );
}

function hasPlaceholder(config) {
  return getDatabaseBindings(config).some((database) => database.database_id === placeholderDatabaseId);
}

function normalizeDatabaseBinding(config) {
  const database = findDatabase(config);
  if (!database) return false;

  config.d1_databases = [
    ...getDatabaseBindings(config).filter((binding) => binding.binding !== "DB"),
    {
      ...database,
      binding: "DB",
      database_name: "highseas-edge",
      migrations_dir: "migrations",
    },
  ];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return true;
}

let config = readConfig();
const initialProvisioning = hasPlaceholder(config);
let database = findDatabase(config);

// Wrangler appends a new binding instead of replacing a placeholder. Recover
// cleanly when a previous setup run stopped immediately after D1 creation.
if (database && hasPlaceholder(config)) {
  console.log("==> Repairing duplicate D1 binding from the previous setup run");
  normalizeDatabaseBinding(config);
  config = readConfig();
  database = findDatabase(config);
}

function runNode(script, args = [], input) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: projectDir,
    stdio: input ? ["pipe", "inherit", "inherit"] : "inherit",
    input,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runWrangler(args, input) {
  runNode(wranglerCli, args, input);
}

console.log("==> Checking Cloudflare login");
runWrangler(["whoami"]);

if (!database) {
  if (!hasPlaceholder(config)) {
    console.error("No usable DB binding was found in wrangler.jsonc.");
    process.exit(1);
  }
  console.log("==> Creating D1 database in the Asia Pacific region");
  runWrangler(["d1", "create", "highseas-edge", "--location", "apac", "--binding", "DB", "--update-config"]);
  config = readConfig();
  if (!normalizeDatabaseBinding(config)) {
    console.error("D1 was created, but its database ID could not be found in wrangler.jsonc.");
    process.exit(1);
  }
  config = readConfig();
  database = findDatabase(config);
}

console.log("==> Applying D1 migrations");
runWrangler(["d1", "migrations", "apply", "highseas-edge", "--remote"]);

if (!existsSync(keyPath)) {
  if (!initialProvisioning) {
    console.error("Missing highseas-master-key.txt. Restore the original key before deploying; generating a new key would make saved SSH credentials unreadable.");
    process.exit(1);
  }
  writeFileSync(keyPath, randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  console.log("==> Generated highseas-master-key.txt. Store an offline backup and never commit it.");
}

console.log("==> Updating encrypted Worker secret");
const masterKeyValue = readFileSync(keyPath, "utf8").trim();
runWrangler(["secret", "put", "MASTER_KEY"], `${masterKeyValue}\n`);

console.log("==> Updating password pepper secret");
const passwordPepper = createHmac("sha256", Buffer.from(masterKeyValue, "base64"))
  .update("highseas-webssh-password-pepper-v2")
  .digest("base64");
runWrangler(["secret", "put", "PASSWORD_PEPPER"], `${passwordPepper}\n`);

console.log("==> Building and deploying Highseas WebSSH Edge");
runNode(tscCli, ["-b"]);
runNode(viteCli, ["build"]);
runNode(workerBuildScript);
runWrangler(["deploy"]);
console.log("==> Deployment complete");
