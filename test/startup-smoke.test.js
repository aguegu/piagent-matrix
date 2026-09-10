import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Boots the real entry point, because nothing else here does.
 *
 * A ReferenceError in main() once shipped past `node --check` and a green
 * suite, and the bot crash-looped on every restart: the unit tests cover the
 * pieces, and nothing assembled them. This starts the actual process and
 * waits for the one artefact that proves startup got past configuration,
 * the instance lock, the crypto store and resource installation — the
 * agent's own context file, written to disk.
 *
 * It never reaches a real homeserver: the token is fabricated so no login is
 * attempted, and the homeserver is a name that cannot resolve.
 */

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("the bot starts up", () => {
  it("gets as far as writing what the agent reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-"));
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    // A device it already "has", so startup skips the login branch entirely.
    writeFileSync(
      join(data, "token.json"),
      JSON.stringify({ accessToken: "not-a-token", deviceId: "SMOKETEST0", userId: "@smoke:invalid.example" }),
    );

    const bot = spawn(process.execPath, ["src/index.js"], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DATA_DIR: data,
        BOT_CWD: join(dir, "workspace"),
        SESSION_DIR: join(dir, "sessions"),
        INBOX_DIR: join(dir, "inbox"),
        OUTBOX_DIR: join(dir, "outbox"),
        CRONTAB_FILE: join(data, "crontab"),
        AGENT_PARTS: "living-in-container,scheduling-crontab",
        // Unresolvable, and no credentials: this must not touch anything real.
        MATRIX_HOMESERVER: "https://smoke.invalid",
        MATRIX_USER_ID: "@smoke:invalid.example",
        MATRIX_PASSWORD: "",
        MATRIX_RECOVERY_KEY: "",
        MATRIX_ALLOWED_USERS: "@nobody:invalid.example",
        LOG_LEVEL: "info",
      },
    });

    let output = "";
    bot.stdout.on("data", (d) => { output += d; });
    bot.stderr.on("data", (d) => { output += d; });
    let exited = null;
    bot.on("exit", (code) => { exited = code; });

    const installed = join(data, "pi", "AGENTS.md");
    try {
      // It is expected to die shortly after, at the first sync against a
      // homeserver that does not exist. That is not the failure being
      // watched for: what matters is whether it got far enough to write
      // anything, so the artefacts are the evidence rather than survival.
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline && !existsSync(installed)) {
        // Once it is gone, one last look — anything it wrote is already there.
        if (exited !== null) { await sleep(200); break; }
        await sleep(100);
      }

      assert.ok(
        existsSync(installed),
        `startup never reached resource installation (exit ${exited}):\n${output}`,
      );

      const agents = readFileSync(installed, "utf8");
      assert.doesNotMatch(agents, /\{\{/, "the agent must not be handed a placeholder");
      assert.match(agents, /## Where you are/, "the enabled sections are spliced in");

      // The startup-only side effects, which no unit test performs together.
      assert.ok(existsSync(join(data, "bot.lock")), "the instance lock is taken");
      // Seeded by the scheduler, so a deployment always has a file to edit —
      // even here, where supercronic is absent and startup only logs that.
      assert.ok(existsSync(join(data, "crontab")), "the crontab exists to be edited");
      assert.deepEqual(
        readdirSync(join(data, "parts-enabled")).sort(),
        ["10-living-in-container.md", "20-scheduling-crontab.md"],
        "a fresh deployment is seeded once",
      );
    } finally {
      bot.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
