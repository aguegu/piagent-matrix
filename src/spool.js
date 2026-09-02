// A watched directory that other processes drop files into.
//
// Shared by the outbox (files the bot posts) and the inbox (files the bot runs
// as prompts). The mechanics are the same either way, and the fiddly parts are
// the ones worth having in one place:
//
//   - a writer must rename() into the directory, never write in place, so the
//     bot cannot read half a file;
//   - files are claimed by hard link before being handled, so two passes cannot
//     take the same one — and neither can two files arriving under the same
//     name, which rename() would have allowed;
//   - a claim left behind means the bot died mid-handle. Whether the work
//     happened is unknowable, so it is parked rather than retried — a repeated
//     send is a duplicate message, a repeated prompt is a duplicate agent run;
//   - failures park as `.failed` and stay for inspection instead of retrying
//     forever;
//   - names are claimed in order, so a timestamp prefix means what it looks
//     like;
//   - fs.watch is the fast path and misses events on some filesystems, so a
//     poll backstops it.
//
// `concurrency` is how many handlers may be in flight. It defaults to 1, which
// also finishes them in name order — what the outbox wants, since two messages
// posted out of order is a visible fault. Above 1 the claiming stays ordered
// and only the waiting overlaps, which is what the inbox wants: its handler
// awaits a whole agent run, and at 1 a long run in one room stalled every other
// room's prompts behind it. The agent serializes per room by itself, so a
// second lock here bought nothing and cost that.

import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { LogService } from "matrix-bot-sdk";

const CLAIM_SUFFIX = ".working";
const FAILED_SUFFIX = ".failed";

/**
 * Take `src` as `claimed`, or throw if someone already has it.
 *
 * link()+unlink() is the atomic form: link refuses an existing destination,
 * where rename would replace it. Filesystems without hard links fall back to
 * rename, which is what this always used to do — weaker, but the alternative
 * is a spool that does not work there at all.
 */
function claim(src, claimed) {
  try {
    linkSync(src, claimed);
  } catch (err) {
    if (err?.code === "EEXIST") throw err;
    // EPERM/ENOSYS/EXDEV: no hard links here.
    renameSync(src, claimed);
    return;
  }
  unlinkSync(src);
}

/**
 * @param {object} opts
 * @param {string} opts.dir  the directory to watch
 * @param {string} opts.label  for log lines: "outbox", "inbox"
 * @param {(name: string, contents: string) => Promise<string>} opts.handle
 *   Resolves with a line for the log; throws to park the file.
 * @param {string} [opts.claimSuffix]  kept configurable so the outbox can go on
 *   using `.sending`, which anything watching a deployment may know by name.
 * @param {number} [opts.concurrency]  handlers in flight at once; 1 also means
 *   they finish in name order.
 * @returns {() => void} stop
 */
export function watchSpool({
  dir,
  label,
  handle,
  claimSuffix = CLAIM_SUFFIX,
  pollMs = 10_000,
  concurrency = 1,
}) {
  if (!dir) {
    LogService.info(label, `No ${label} dir configured — ${label} disabled.`);
    return () => {};
  }

  mkdirSync(dir, { recursive: true });

  // A file left claimed means we died mid-handle. We cannot tell whether the
  // work happened, and doing it again risks a duplicate, so park it.
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(claimSuffix)) continue;
    const from = join(dir, name);
    const to = join(dir, `${name.slice(0, -claimSuffix.length)}${FAILED_SUFFIX}`);
    try {
      renameSync(from, to);
      LogService.warn(
        label,
        `Found orphaned claim ${name}; parked as ${basename(to)} (may or may not have been handled).`,
      );
    } catch (err) {
      LogService.warn(label, `Could not park ${name}: ${err?.message ?? err}`);
    }
  }

  let scanning = false;
  let stopped = false;
  /** Handlers still running, so a full spool stops claiming. @type {Set<Promise<void>>} */
  const inflight = new Set();

  /** Run one already-claimed file: drop it on success, park it on failure. */
  async function handleClaimed(name, src, claimed) {
    try {
      const note = await handle(name, readFileSync(claimed, "utf8"));
      unlinkSync(claimed);
      LogService.info(label, note ?? `Handled ${name}`);
    } catch (err) {
      const failed = `${src}${FAILED_SUFFIX}`;
      try {
        renameSync(claimed, failed);
      } catch { /* ignore */ }
      LogService.error(
        label,
        `Failed ${name}: ${err?.message ?? err} (kept as ${basename(failed)})`,
      );
    }
  }

  async function scan() {
    if (scanning || stopped) return;
    scanning = true;
    try {
      const names = readdirSync(dir)
        .filter((n) => (n.endsWith(".txt") || n.endsWith(".json")) && !n.startsWith("."))
        .sort();

      for (const name of names) {
        if (stopped) break;
        // Every slot busy. Whichever handler finishes first scans again, so
        // the rest are picked up then — including anything that lands in the
        // meantime, which this pass's listing cannot see.
        if (inflight.size >= concurrency) break;

        const src = join(dir, name);
        const claimed = `${src}${claimSuffix}`;

        // Claim by hard link, not rename. rename() onto an existing path
        // succeeds silently, so a second drop arriving under the same name
        // would overwrite a claim already being handled: the running job's
        // content swapped underneath it, and a second handler started on the
        // same path — one prompt, two agent runs. link() fails with EEXIST
        // instead, and the new drop simply waits for the claim to clear.
        //
        // Writers do collide: a script naming drops by the second produces one
        // filename when it runs twice in a second, and three digest jobs
        // became one file that way.
        try {
          claim(src, claimed);
        } catch {
          continue;
        }

        const running = handleClaimed(name, src, claimed);
        inflight.add(running);
        running.finally(() => {
          inflight.delete(running);
          if (!stopped) scan().catch(() => {});
        });
        // Serial spools wait here, which is what keeps them in name order.
        if (concurrency === 1) await running;
      }
    } catch (err) {
      LogService.error(label, `scan failed: ${err?.message ?? err}`);
    } finally {
      scanning = false;
    }
  }

  let watcher = null;
  try {
    watcher = watch(dir, () => { scan().catch(() => {}); });
  } catch (err) {
    LogService.warn(label, `fs.watch unavailable (${err?.message ?? err}); relying on poll.`);
  }
  const timer = setInterval(() => { scan().catch(() => {}); }, pollMs);
  if (timer.unref) timer.unref();

  // Pick up anything spooled while the bot was down.
  scan().catch(() => {});

  return function stop() {
    stopped = true;
    clearInterval(timer);
    try { watcher?.close(); } catch { /* ignore */ }
  };
}
