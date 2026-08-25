// Persistent bot state: access token, device id, recovery key.
//
// Stored as JSON at BOT_DATA_DIR/bot-state.json with 0600 perms.
//
// The recovery key is the only thing that lets the bot read its own encrypted
// history on a new device. Without it, you lose the ability to read old
// messages after re-onboarding.

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

export class BotState {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.path = join(dataDir, "bot-state.json");
  }

  load() {
    if (!existsSync(this.path)) return null;
    try {
      const text = readFileSync(this.path, "utf8");
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`Failed to read bot state at ${this.path}: ${err.message}`);
    }
  }

  save(state) {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(state, null, 2), { mode: 0o600 });
    // chmodSync in case the file pre-existed with looser perms.
    try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
  }
}
