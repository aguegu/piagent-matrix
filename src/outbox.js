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
// The spool mechanics — claiming, ordering, parking, watching — are shared with
// the inbox; see src/spool.js. This file is only what makes a drop a message.

import { LogService } from "matrix-bot-sdk";
import { watchSpool } from "./spool.js";

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
  if (dir) {
    LogService.info(
      "outbox",
      `Watching ${dir}${readDefaultRoom() ? ` (main room ${readDefaultRoom()})` : " — no main room yet"}`,
    );
  }

  return watchSpool({
    dir,
    label: "outbox",
    pollMs,
    // Kept from before the spool was shared: a deployment's tooling may know
    // this suffix by name.
    claimSuffix: ".sending",
    async handle(name, contents) {
      const { room, body, html } = parsePayload(name, contents, readDefaultRoom());
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
      return `Sent ${name} to ${room} -> ${eventId}`;
    },
  });
}

function parsePayload(name, raw, defaultRoom) {
  if (name.endsWith(".json")) {
    const obj = JSON.parse(raw);
    return { room: obj.room || defaultRoom, body: obj.body ?? "", html: obj.html };
  }
  return { room: defaultRoom, body: raw.replace(/\n$/, ""), html: undefined };
}
