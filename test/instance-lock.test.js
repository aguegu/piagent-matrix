import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { claimInstanceLock } from "../src/instance-lock.js";

/**
 * Two instances on one data directory is the fault this project exists around:
 * both advance their own copy of the Megolm ratchet and encrypt different
 * messages at the same index. It also lets a starting bot park a running bot's
 * in-flight spool claim, so finished work is reported as failed.
 */

describe("instance lock", () => {
  let dir;
  let release;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lock-")); });
  afterEach(() => { release?.(); rmSync(dir, { recursive: true, force: true }); });

  it("records the holder, and gives it up on release", () => {
    release = claimInstanceLock(dir);
    const path = join(dir, "bot.lock");

    assert.equal(readFileSync(path, "utf8").trim(), String(process.pid));
    release();
    assert.ok(!existsSync(path), "a clean shutdown leaves nothing to break");
  });

  it("takes over from a live pid that is not this bot", async () => {
    // A real process that outlives the assertion, standing in for the other bot.
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"]);
    try {
      // The lock only refuses when the holder looks like this bot, so the
      // stand-in has to be named like one where /proc can be read.
      writeFileSync(join(dir, "bot.lock"), `${other.pid}\n`);
      const canInspect = existsSync(`/proc/${other.pid}/cmdline`);
      if (!canInspect) return; // elsewhere the pid alone is trusted; covered below

      // Its command line is `-e ...`, not index.js, so it is treated as a
      // stale pid rather than a second bot — a reused pid must not brick a start.
      release = claimInstanceLock(dir);
      assert.equal(readFileSync(join(dir, "bot.lock"), "utf8").trim(), String(process.pid));
    } finally {
      other.kill();
    }
  });

  it("refuses when the holder is alive and looks like this bot", async () => {
    // Named index.js so the /proc check recognises it.
    const script = join(dir, "index.js");
    writeFileSync(script, "setTimeout(() => {}, 30_000);");
    const other = spawn(process.execPath, [script]);
    await new Promise((r) => setTimeout(r, 150)); // let it get a command line
    try {
      writeFileSync(join(dir, "bot.lock"), `${other.pid}\n`);
      assert.throws(
        () => { release = claimInstanceLock(dir); },
        /already running/,
        "a second bot on one data directory must not start",
      );
      assert.match(
        (() => { try { claimInstanceLock(dir); } catch (e) { return e.message; } return ""; })(),
        new RegExp(String(other.pid)),
        "and the message must name the pid holding it",
      );
    } finally {
      other.kill();
    }
  });

  it("takes over a lock whose writer is gone", () => {
    // What a SIGKILL leaves behind. Refusing here would mean the bot cannot
    // start again without someone deleting a file by hand.
    writeFileSync(join(dir, "bot.lock"), "999999\n");

    release = claimInstanceLock(dir);

    assert.equal(readFileSync(join(dir, "bot.lock"), "utf8").trim(), String(process.pid));
  });

  it("survives a lock file with nothing useful in it", () => {
    writeFileSync(join(dir, "bot.lock"), "not a pid\n");

    release = claimInstanceLock(dir);

    assert.equal(readFileSync(join(dir, "bot.lock"), "utf8").trim(), String(process.pid));
  });

  it("does not delete a lock another instance has taken over", () => {
    release = claimInstanceLock(dir);
    // Someone else took it while we were shutting down.
    writeFileSync(join(dir, "bot.lock"), "424242\n");

    release();

    assert.equal(readFileSync(join(dir, "bot.lock"), "utf8").trim(), "424242");
  });
});
