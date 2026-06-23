export type Env = {
  ASSETS: Fetcher;
  DB: D1Database;
  MASTER_KEY?: string;
  PASSWORD_PEPPER?: string;
  APP_NAME?: string;
  SESSION_HOURS?: string;
};

export function requireConfiguredEnv(env: Env) {
  if (!env.DB) throw new Error("D1 binding DB is not configured");
  if (!env.MASTER_KEY) throw new Error("MASTER_KEY secret is not configured");
  if (!env.PASSWORD_PEPPER) throw new Error("PASSWORD_PEPPER secret is not configured");
}
