// Load config from .env (if present) and process.env, then validate.
// Run with: `node --env-file=.env src/index.js` (Node 20.6+).
// We support both --env-file and a manual loader for older setups.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function loadDotenv(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function loadConfig({ dotenvPath = ".env" } = {}) {
  loadDotenv(resolve(dotenvPath));

  const homeserver = required("MATRIX_HOMESERVER");
  const userId = required("MATRIX_USER_ID");
  const password = process.env.MATRIX_PASSWORD || "";
  const accessToken = process.env.MATRIX_ACCESS_TOKEN || "";

  if (!password && !accessToken) {
    throw new Error("Set either MATRIX_PASSWORD or MATRIX_ACCESS_TOKEN");
  }

  const allowedUsers = (process.env.MATRIX_ALLOWED_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const botCwd = resolve(process.env.BOT_CWD || PROJECT_ROOT);
  const dataDir = process.env.BOT_DATA_DIR
    ? resolve(process.env.BOT_DATA_DIR)
    : resolve(PROJECT_ROOT, "data");
  const recoveryKey = process.env.MATRIX_RECOVERY_KEY || "";

  return {
    homeserver,
    userId,
    password: password || undefined,
    accessToken: accessToken || undefined,
    recoveryKey: recoveryKey || undefined,
    allowedUsers,
    botCwd,
    dataDir,
    sessionDir: process.env.SESSION_DIR
      ? resolve(process.env.SESSION_DIR)
      : undefined,
    logLevel: process.env.LOG_LEVEL || "info",
  };
}

function required(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}
