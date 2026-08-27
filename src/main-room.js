// The main room: the bot's control channel, normally the first room it was
// invited to and typically holding just the bot and its admin.
//
// It is recorded rather than configured. "First room invited" cannot be
// recovered after the fact — getJoinedRooms() has no meaningful order — so it
// is observed at join time and written down. Recording also means a bot that
// starts before being invited picks the room up as soon as it joins, rather
// than staying unset until the next restart.
//
// Precedence: MATRIX_MAIN_ROOM (explicit override) > recorded > adopted at
// startup when exactly one room is joined > none.

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
   * Record a room as the main room unless one is already established.
   * Returns true if this call set it.
   */
  adopt(roomId, why) {
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
   */
  settleOnStartup(joined) {
    if (this.#roomId) {
      LogService.info(
        "bot",
        `Main room is ${this.#roomId}${this.isPinned ? " (pinned by MATRIX_MAIN_ROOM)" : ""}.`,
      );
      return;
    }
    if (joined.length === 1) {
      this.adopt(joined[0], "only joined room at startup");
      return;
    }
    if (joined.length === 0) {
      LogService.info("bot", "No main room yet — the first room this bot joins becomes it.");
      return;
    }
    LogService.warn(
      "bot",
      `No main room recorded and the bot is already in ${joined.length} rooms, so there is no ` +
        "safe guess. Unaddressed *.txt outbox drops will be parked as .failed until one is set: " +
        `set MATRIX_MAIN_ROOM, or write the room id into ${this.#path}.`,
    );
  }

  /** Note when the main room does not look like a private admin channel. */
  checkMembership(roomId, memberCount) {
    if (roomId !== this.#roomId || typeof memberCount !== "number") return;
    if (memberCount > 2) {
      LogService.warn(
        "bot",
        `Main room ${roomId} has ${memberCount} members. It is meant to be the bot's control ` +
          "channel with its admin; operational output goes here.",
      );
    }
  }

  /** True once a record exists on disk. */
  get isRecorded() {
    return existsSync(this.#path);
  }
}
