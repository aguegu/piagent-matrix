// The main room: the bot's control channel, normally the first room it was
// invited to and typically holding just the bot and its admin.
//
// It is recorded rather than configured, in data/main-room.json. Recording
// means a bot that starts before being invited picks a room up as soon as it
// joins, rather than staying unset until the next restart.
//
// A room is adopted when there is no main room and the room *fits*: the bot is
// in it, it holds no more than two members, and — when MATRIX_ALLOWED_USERS is
// set — one of them may run commands. That last part is what makes adoption
// safe. A stranger cannot hand the bot a control channel by inviting it
// somewhere, and a busy working room cannot become one by accident. Fitting is
// checked against the room's shape rather than against join order, which is
// unrecoverable after the fact and said nothing about whether the room was
// suitable.
//
// The record is dropped as soon as it stops being usable — the bot is kicked
// from the main room, or starts to find itself no longer in it. A pointer to a
// room the bot cannot reach is worse than no pointer at all: commands run in
// the main room and nowhere else, so the bot goes silent while looking healthy,
// and every alternative is declined because a room is "already" recorded. An
// unset main room refills itself from the next room that fits.
//
// Strictly to adopt, leniently to keep: a main room that later grows past two
// members, or whose admin steps out, is warned about but not dropped. Only
// being outside the room is disqualifying, because only that stops it working.
//
// There is no way to configure it. An override existed while a wrong record
// could only be corrected on the host; now that kicking the bot out drops the
// record and the next fitting room takes over, a second source of truth would
// only be something to argue with.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LogService } from "matrix-bot-sdk";

/**
 * Whether a room is shaped like a control channel, and who its admin is.
 *
 * A fitting room has exactly one member besides the bot, and that member is
 * the admin — the person the control channel belongs to. It is returned so it
 * can be recorded alongside the room: a room id alone says where the bot takes
 * orders, not who from.
 *
 * @param {string[]|null} members  user ids in the room, null if unknown
 * @param {string[]} allowedUsers  MATRIX_ALLOWED_USERS; empty means everyone
 * @param {string} botUserId  the bot's own id, to tell it from its admin
 * @returns {{ ok: boolean, why: string, admin: string }}
 */
export function roomFits(members, allowedUsers = [], botUserId = "") {
  const no = (why) => ({ ok: false, why, admin: "" });
  if (!Array.isArray(members)) return no("its membership could not be read");
  if (members.length > 2) {
    return no(`it has ${members.length} members, so it is not a private admin channel`);
  }

  const others = members.filter((m) => m !== botUserId);
  // An empty allowlist means everyone may command the bot, so being allowed is
  // not a question — but there still has to be somebody there to be the admin.
  const admins = allowedUsers.length ? others.filter((m) => allowedUsers.includes(m)) : others;
  if (!admins.length) {
    return no(
      allowedUsers.length
        ? "it holds nobody from MATRIX_ALLOWED_USERS"
        : "the bot would be alone in it, with no admin",
    );
  }
  return { ok: true, why: "", admin: admins[0] };
}

export class MainRoom {
  #path;
  #roomId = "";
  #admin = "";

  /** @param {string} dataDir  where the record lives, beside the bot's other state */
  constructor(dataDir) {
    this.#path = join(dataDir, "main-room.json");
    try {
      const saved = JSON.parse(readFileSync(this.#path, "utf8"));
      if (typeof saved?.roomId === "string") this.#roomId = saved.roomId;
      // Records written before the admin was stored simply have none.
      if (typeof saved?.admin === "string") this.#admin = saved.admin;
    } catch {
      /* not recorded yet */
    }
  }

  /** The main room id, or "" if not established. */
  get roomId() {
    return this.#roomId;
  }

  /** The admin the room was adopted for, or "" if unrecorded. */
  get admin() {
    return this.#admin;
  }

  /** True once a record exists on disk. */
  get isRecorded() {
    return existsSync(this.#path);
  }

  /** One line for the startup log. */
  describe() {
    if (!this.#roomId) return "No main room yet — the first room that fits becomes it.";
    return `Main room is ${this.#roomId}${this.#admin ? `, admin ${this.#admin}` : ""}.`;
  }

  /**
   * Record a room as the main room, unless one is already established.
   *
   * Whether the room *fits* is the caller's business — see roomFits — because
   * that needs a membership lookup this class does not make. roomFits returns
   * the admin to pass in here.
   *
   * @returns {boolean} true if this call set it
   */
  adopt(roomId, why, admin = "") {
    if (this.#roomId) return false;
    this.#roomId = roomId;
    this.#admin = admin;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      // Write-then-rename so a crash cannot leave a half-written record.
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ roomId, admin, recordedBecause: why }, null, 2)}\n`);
      renameSync(tmp, this.#path);
      LogService.info(
        "bot",
        `Main room set to ${roomId}${admin ? ` for ${admin}` : ""} (${why}). Recorded in ${this.#path}.`,
      );
    } catch (err) {
      // Losing the record is not fatal: it will be re-adopted next time.
      LogService.warn("bot", `Could not record the main room: ${err?.message ?? err}`);
    }
    return true;
  }

  /**
   * Drop the record, so the next room that fits can take over.
   *
   * Called when the main room stops being usable — the bot is kicked from it,
   * or starts up outside it. Keeping the record in that state was the worse
   * failure: commands are refused everywhere else and unreachable there, so
   * the only fix was editing a file on the host.
   *
   * @returns {boolean} true if this call cleared it
   */
  unset(why) {
    if (!this.#roomId) return false;
    const was = this.#roomId;
    this.#roomId = "";
    this.#admin = "";
    try {
      rmSync(this.#path, { force: true });
    } catch (err) {
      // The in-memory state is what the bot acts on; a stale file only means
      // the old room comes back on the next restart, and is unset again.
      LogService.warn("bot", `Could not remove ${this.#path}: ${err?.message ?? err}`);
    }
    LogService.warn("bot", `Main room ${was} dropped: ${why}. The next room that fits becomes it.`);
    return true;
  }

  /**
   * Check an established main room against what the server actually says.
   *
   * A recorded room used to be trusted on sight, so one the bot had been
   * kicked from looked healthy right up until every command was refused and
   * the outbox filled with .failed drops.
   *
   * Only `present` is disqualifying; the caller unsets on it. The other two
   * are warnings about a room that still works.
   *
   * @param {string[]} joined  room ids the bot is in
   * @param {string[]|null} members  user ids in the main room, null if unknown
   * @param {string[]} allowedUsers  MATRIX_ALLOWED_USERS; empty means everyone
   * @returns {{ present: boolean, admins: string[], problems: string[] }}
   */
  verify(joined, members, allowedUsers = []) {
    const roomId = this.#roomId;
    const out = { present: false, admins: [], problems: [] };
    if (!roomId) return out;

    out.present = Array.isArray(joined) && joined.includes(roomId);
    if (!out.present) {
      out.problems.push(`The bot is not in its main room ${roomId} — kicked, or it left.`);
      // Nothing else is knowable from outside a room.
      for (const p of out.problems) LogService.warn("bot", p);
      return out;
    }

    if (Array.isArray(members)) {
      if (allowedUsers.length) {
        out.admins = members.filter((m) => allowedUsers.includes(m));
        if (out.admins.length === 0) {
          out.problems.push(
            `Main room ${roomId} holds none of MATRIX_ALLOWED_USERS. Nobody who may run a ` +
              "command is in the room where commands run.",
          );
        }
      }
      if (this.#admin && !members.includes(this.#admin)) {
        out.problems.push(
          `${this.#admin} adopted main room ${roomId} and is no longer in it.`,
        );
      }
      if (members.length > 2) {
        out.problems.push(
          `Main room ${roomId} has ${members.length} members. It is meant to be the bot's ` +
            "control channel with its admin; operational output goes here.",
        );
      }
    }

    for (const p of out.problems) LogService.warn("bot", p);
    if (!out.problems.length) {
      LogService.info(
        "bot",
        `Main room ${roomId} verified: joined${allowedUsers.length ? `, ${out.admins.length} allowed user(s) present` : ""}.`,
      );
    }
    return out;
  }
}
