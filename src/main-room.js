// The main room: the bot's control channel, normally the first room it was
// invited to and typically holding just the bot and its admin.
//
// It is recorded rather than configured. "First room invited" cannot be
// recovered after the fact — getJoinedRooms() has no meaningful order — so it
// is observed at join time and written down. Recording also means a bot that
// starts before being invited picks the room up as soon as it joins, rather
// than staying unset until the next restart.
//
// Adoption is a 0 -> 1 transition, and only that. The bot takes its control
// channel from the room it is invited to while it is in no others; it does not
// take it from whichever room it happens to join next. A bot already sitting in
// several rooms that has lost its record adopts nothing, because the next
// arrival is an arbitrary room and adopting it would hand the control channel
// to whoever sent that invite — quietly.
//
// Precedence: MATRIX_MAIN_ROOM (explicit override) > recorded > adopted on the
// 0 -> 1 join, or at startup when exactly one room is joined > none.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LogService } from "matrix-bot-sdk";

export class MainRoom {
  #path;
  #configured;
  #roomId = "";

  /**
   * @param {string} dataDir  where the record lives, beside the bot's other state
   * @param {string} configured  MATRIX_MAIN_ROOM, or "" to use the recorded value
   */
  constructor(dataDir, configured = "") {
    this.#path = join(dataDir, "main-room.json");
    this.#configured = configured;
    if (configured) {
      this.#roomId = configured;
      return;
    }
    try {
      const saved = JSON.parse(readFileSync(this.#path, "utf8"));
      if (typeof saved?.roomId === "string") this.#roomId = saved.roomId;
    } catch {
      /* not recorded yet */
    }
  }

  /** The main room id, or "" if not established. */
  get roomId() {
    return this.#roomId;
  }

  /** True when MATRIX_MAIN_ROOM pins it, so nothing observed can change it. */
  get isPinned() {
    return Boolean(this.#configured);
  }

  /**
   * Consider a join for adoption.
   *
   * @param {string} roomId  the room just joined
   * @param {number} [joinedCount]  rooms the bot is now in, this one included.
   *   Anything but exactly 1 declines: adoption is the 0 -> 1 transition. An
   *   unknown count declines too — not adopting is the recoverable outcome.
   * @returns {boolean} true if this call set the main room
   */
  adoptOnJoin(roomId, joinedCount) {
    if (this.#roomId) return false;
    if (joinedCount === 1) return this.#record(roomId, "first room joined");
    LogService.warn(
      "bot",
      `Joined ${roomId}, but the bot is in ${joinedCount ?? "an unknown number of"} rooms with no ` +
        "main room recorded, and adoption is a bot's first room only — nothing was adopted. " +
        `Set MATRIX_MAIN_ROOM, or write the room id into ${this.#path}.`,
    );
    return false;
  }

  /**
   * Record a room as the main room unless one is already established.
   * Returns true if this call set it.
   */
  #record(roomId, why) {
    if (this.#roomId) return false;
    this.#roomId = roomId;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      // Write-then-rename so a crash cannot leave a half-written record.
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ roomId, recordedBecause: why }, null, 2)}\n`);
      renameSync(tmp, this.#path);
      LogService.info("bot", `Main room set to ${roomId} (${why}). Recorded in ${this.#path}.`);
    } catch (err) {
      // Losing the record is not fatal: it will be re-adopted next time.
      LogService.warn("bot", `Could not record the main room: ${err?.message ?? err}`);
    }
    return true;
  }

  /**
   * Settle the main room at startup for a bot that predates this record.
   * One joined room is unambiguous; several are not, and guessing would send
   * reports to an arbitrary room while appearing to work.
   *
   * @returns {string} the room id if this call adopted one, else ""
   */
  settleOnStartup(joined) {
    if (this.#roomId) {
      LogService.info(
        "bot",
        `Main room is ${this.#roomId}${this.isPinned ? " (pinned by MATRIX_MAIN_ROOM)" : ""}.`,
      );
      return "";
    }
    if (joined.length === 1) {
      return this.#record(joined[0], "only joined room at startup") ? joined[0] : "";
    }
    if (joined.length === 0) {
      LogService.info("bot", "No main room yet — the first room this bot joins becomes it.");
      return "";
    }
    LogService.warn(
      "bot",
      `No main room recorded and the bot is already in ${joined.length} rooms, so there is no ` +
        "safe guess. Unaddressed *.txt outbox drops will be parked as .failed until one is set: " +
        `set MATRIX_MAIN_ROOM, or write the room id into ${this.#path}.`,
    );
    return "";
  }

  /**
   * Check an established main room against what the server actually says.
   *
   * A recorded room used to be trusted on sight: the bot logged "Main room is
   * X" and carried on, so one it had been kicked from — or a mistyped
   * MATRIX_MAIN_ROOM — looked healthy right up until every command was refused
   * and the outbox filled with .failed drops.
   *
   * Warnings only. This never throws and never clears the record. The bot has
   * to stay up, because a kicked bot is fixed by re-inviting it and one that
   * refused to start could not accept the invite; and the record is what makes
   * that re-invite land back on the same room, so dropping it would trade a
   * one-click recovery for a manual one.
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
      out.problems.push(
        this.isPinned
          ? `MATRIX_MAIN_ROOM names ${roomId}, which this bot is not in. Check the room id, ` +
            "or invite the bot to that room."
          : `The bot is not in its main room ${roomId} — kicked, or it left. Commands run ` +
            "there and nowhere else, so it will take none until it is back. The record is " +
            "kept on purpose: re-inviting it to that same room restores it.",
      );
      // Nothing else is knowable from outside a room.
      for (const p of out.problems) LogService.warn("bot", p);
      return out;
    }

    if (Array.isArray(members)) {
      // With an empty allowlist everyone is an admin, so the question does not
      // arise — and there is no way to tell the bot's own membership apart
      // from a user's without asking who the bot is.
      if (allowedUsers.length) {
        out.admins = members.filter((m) => allowedUsers.includes(m));
        if (out.admins.length === 0) {
          out.problems.push(
            `Main room ${roomId} holds none of MATRIX_ALLOWED_USERS. Nobody who may run a ` +
              "command is in the room where commands run.",
          );
        }
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
      LogService.info("bot", `Main room ${roomId} verified: joined${allowedUsers.length ? `, ${out.admins.length} allowed user(s) present` : ""}.`);
    }
    return out;
  }

  /** True once a record exists on disk. */
  get isRecorded() {
    return existsSync(this.#path);
  }
}
