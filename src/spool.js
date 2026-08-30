// A watched directory that other processes drop files into.
//
// Shared by the outbox (files the bot posts) and the inbox (files the bot runs
// as prompts). The mechanics are the same either way, and the fiddly parts are
// the ones worth having in one place:
//
//   - a writer must rename() into the directory, never write in place, so the
//     bot cannot read half a file;
//   - files are claimed by rename before being handled, so two passes cannot
//     take the same one;
//   - a claim left behind means the bot died mid-handle. Whether the work
//     happened is unknowable, so it is parked rather than retried — a repeated
//     send is a duplicate message, a repeated prompt is a duplicate agent run;
//   - failures park as `.failed` and stay for inspection instead of retrying
//     forever;
//   - names are processed in order, so a timestamp prefix means what it looks
//     like;
//   - fs.watch is the fast path and misses events on some filesystems, so a
//     poll backstops it.

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { LogService } from "matrix-bot-sdk";

const CLAIM_SUFFIX = ".working";
const FAILED_SUFFIX = ".failed";

/**
 * @param {object} opts
 * @param {string} opts.dir  the directory to watch
 * @param {string} opts.label  for log lines: "outbox", "inbox"
 * @param {(name: string, contents: string) => Promise<string>} opts.handle
 *   Resolves with a line for the log; throws to park the file.
 * @param {string} [opts.claimSuffix]  kept configurable so the outbox can go on
 *   using `.sending`, which anything watching a deployment may know by name.
 * @returns {() => void} stop
 */
export function watchSpool({ dir, label, handle, claimSuffix = CLAIM_SUFFIX, pollMs = 10_000 }) {
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

  async function scan() {
    if (scanning || stopped) return;
    scanning = true;
    try {
      const names = readdirSync(dir)
        .filter((n) => (n.endsWith(".txt") || n.endsWith(".json")) && !n.startsWith("."))
        .sort();

      for (const name of names) {
        if (stopped) break;
        const src = join(dir, name);
        const claimed = `${src}${claimSuffix}`;

        // Claim by rename. If this throws, another pass already took it.
        try {
          renameSync(src, claimed);
        } catch {
          continue;
        }

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
