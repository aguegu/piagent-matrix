// Outbox: a spool directory the running bot watches, so other processes can
// post to Matrix without opening their own client.
//
// Why this exists: a second process opening the same crypto store loads the
// same Megolm outbound session and increments its own copy of the ratchet.
// The two writers then emit different plaintexts at the same message_index,
// which conservative clients (FluffyChat) reject as a replay and render as
// "undecryptable" — and which reuses keystream. One process must own the
// crypto store. Everything else hands work to it through here.
//
// Protocol for writers:
//   1. write the payload to a temp file OUTSIDE the spool dir (or as a dotfile)
//   2. rename() it into the spool dir
// rename() is atomic within a filesystem, so the bot never sees a partial file.
//
// Accepted files:
//   *.txt   body is the whole file, sent to the default room
//   *.json  { "room"?: "!id:server", "body": "...", "html"?: "..." }
//
// Files are processed in filename order, so a timestamp prefix preserves
// ordering. On success the file is deleted; on failure it is renamed to
// `<name>.failed` and left for inspection rather than retried forever.

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { LogService } from "matrix-bot-sdk";

const CLAIM_SUFFIX = ".sending";
const FAILED_SUFFIX = ".failed";

/**
 * @param {object} opts
 * @param {string} opts.dir  spool directory
 * @param {string|(() => string)} opts.defaultRoom  the main room for unaddressed
 *   drops. A function is read per send, so a main room adopted after startup
 *   takes effect without a restart.
 */
export function startOutbox(client, { dir, defaultRoom = "", pollMs = 10_000 } = {}) {
  const readDefaultRoom = () =>
    (typeof defaultRoom === "function" ? defaultRoom() : defaultRoom) || "";
  if (!dir) {
    LogService.info("outbox", "No outbox dir configured — outbox disabled.");
    return () => {};
  }

  mkdirSync(dir, { recursive: true });
  LogService.info(
    "outbox",
    `Watching ${dir}${readDefaultRoom() ? ` (main room ${readDefaultRoom()})` : " — no main room yet"}`,
  );

  // A file left claimed means we died mid-send. We cannot tell whether it
  // reached the server, and re-sending risks a duplicate, so park it.
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(CLAIM_SUFFIX)) continue;
    const from = join(dir, name);
    const to = join(dir, `${name.slice(0, -CLAIM_SUFFIX.length)}${FAILED_SUFFIX}`);
    try {
      renameSync(from, to);
      LogService.warn("outbox", `Found orphaned claim ${name}; parked as ${basename(to)} (may or may not have been sent).`);
    } catch (err) {
      LogService.warn("outbox", `Could not park ${name}: ${err?.message ?? err}`);
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
        const claimed = `${src}${CLAIM_SUFFIX}`;

        // Claim by rename. If this throws, another pass already took it.
        try {
          renameSync(src, claimed);
        } catch {
          continue;
        }

        try {
          const { room, body, html } = parsePayload(name, readFileSync(claimed, "utf8"), readDefaultRoom());
          if (!room) {
            throw new Error(
              "no room in the file and no main room established — name the room in a " +
                ".json drop, or invite the bot to a room that can be its main room",
            );
          }
          if (!body.trim()) throw new Error("empty body");

          const content = { msgtype: "m.notice", body };
          if (html) {
            content.format = "org.matrix.custom.html";
            content.formatted_body = html;
          }
          const eventId = await client.sendMessage(room, content);

          unlinkSync(claimed);
          LogService.info("outbox", `Sent ${name} to ${room} -> ${eventId}`);
        } catch (err) {
          const failed = `${src}${FAILED_SUFFIX}`;
          try {
            renameSync(claimed, failed);
          } catch { /* ignore */ }
          LogService.error("outbox", `Failed ${name}: ${err?.message ?? err} (kept as ${basename(failed)})`);
        }
      }
    } catch (err) {
      LogService.error("outbox", `scan failed: ${err?.message ?? err}`);
    } finally {
      scanning = false;
    }
  }

  // fs.watch is the fast path but misses events on some filesystems, so a slow
  // poll backstops it. Both funnel into the same guarded scan.
  let watcher = null;
  try {
    watcher = watch(dir, () => { scan().catch(() => {}); });
  } catch (err) {
    LogService.warn("outbox", `fs.watch unavailable (${err?.message ?? err}); relying on poll.`);
  }
  const timer = setInterval(() => { scan().catch(() => {}); }, pollMs);
  if (timer.unref) timer.unref();

  // Pick up anything spooled while the bot was down.
  scan().catch(() => {});

  return function stopOutbox() {
    stopped = true;
    clearInterval(timer);
    try { watcher?.close(); } catch { /* ignore */ }
  };
}

function parsePayload(name, raw, defaultRoom) {
  if (name.endsWith(".json")) {
    const obj = JSON.parse(raw);
    return { room: obj.room || defaultRoom, body: obj.body ?? "", html: obj.html };
  }
  return { room: defaultRoom, body: raw.replace(/\n$/, ""), html: undefined };
}
