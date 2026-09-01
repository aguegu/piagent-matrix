// One bot per data directory, enforced rather than asked for.
//
// Two instances sharing `data/` is the fault this project was built around:
// both load the same outbound Megolm session, each advances its own copy of the
// ratchet, and they encrypt different messages at the same index. Strict
// clients reject the duplicate as a replay and show "undecryptable", and the
// reuse means one keystream covered two plaintexts. The documentation has said
// "never run two instances against the same data/" ever since, and nothing
// checked.
//
// It costs elsewhere too. The spools park any claim they find at startup, on
// the reasoning that a leftover claim means the bot died mid-handle — sound
// with one instance, and wrong with two, where a starting bot renames a running
// bot's in-flight file out from under it. The running one then fails to delete
// what it finished, and a completed job is reported as a failure.
//
// The lock is a pid file. It is advisory and single-machine: enough to catch a
// second `npm start` in another terminal, which is how this actually happens.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LogService } from "matrix-bot-sdk";

/** Whether a pid is running at all. */
function alive(pid) {
  try {
    // Signal 0 checks for existence and permission without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else, which still counts.
    return err?.code === "EPERM";
  }
}

/**
 * Whether a live pid looks like another copy of this bot.
 *
 * A pid file outlives a SIGKILL, and pids are reused, so "something is running
 * with that number" is not enough to refuse a start on — that would leave the
 * bot unable to boot for a reason the operator cannot see. Linux exposes the
 * command line; where it does not, we fall back to trusting the pid, since a
 * false refusal is louder and more fixable than a silent second writer.
 */
function looksLikeThisBot(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes("index.js");
  } catch {
    return true;
  }
}

/**
 * Take the lock for `dataDir`, or throw explaining who holds it.
 *
 * @param {string} dataDir
 * @returns {() => void} release, safe to call more than once
 */
export function claimInstanceLock(dataDir) {
  const path = resolve(dataDir, "bot.lock");
  mkdirSync(dirname(path), { recursive: true });

  if (existsSync(path)) {
    const held = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    if (Number.isInteger(held) && held !== process.pid && alive(held) && looksLikeThisBot(held)) {
      throw new Error(
        `Another instance (pid ${held}) is already running against ${resolve(dataDir)}. ` +
          "Two bots on one data directory desynchronise the Megolm ratchet and produce " +
          "messages strict clients refuse to decrypt. Stop that one first, or point this " +
          `one at its own DATA_DIR. If pid ${held} is gone, delete ${path}.`,
      );
    }
    // Stale: the writer is gone, or the number belongs to something else now.
    LogService.warn("bot", `Taking over a stale lock from pid ${held} at ${path}.`);
  }

  writeFileSync(path, `${process.pid}\n`);

  let released = false;
  return function release() {
    if (released) return;
    released = true;
    try {
      // Only remove our own: a later instance may have taken over legitimately.
      const held = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      if (held === process.pid) unlinkSync(path);
    } catch {
      /* already gone, or never ours */
    }
  };
}
