import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MainRoom, roomFits } from "../src/main-room.js";

const ROOM = "!main:example.org";
const ADMIN = "@agu:example.org";
const BOT = "@bot:example.org";

describe("what makes a room fit to be the main room", () => {
  it("accepts the bot alone with an allowed user", () => {
    assert.equal(roomFits([BOT, ADMIN], [ADMIN]).ok, true);
  });

  it("rejects a room holding nobody who may command the bot", () => {
    // This is what makes adoption safe: a stranger cannot hand the bot a
    // control channel by inviting it somewhere.
    const fit = roomFits([BOT, "@stranger:example.org"], [ADMIN]);
    assert.equal(fit.ok, false);
    assert.match(fit.why, /MATRIX_ALLOWED_USERS/);
  });

  it("rejects a room that is not private", () => {
    const fit = roomFits([BOT, ADMIN, "@third:example.org"], [ADMIN]);
    assert.equal(fit.ok, false);
    assert.match(fit.why, /3 members/);
  });

  it("does not ask who the admin is when the allowlist is empty", () => {
    // Empty means everyone may command it, so the question does not arise.
    assert.equal(roomFits([BOT, "@anyone:example.org"], []).ok, true);
  });

  it("rejects a room whose membership could not be read", () => {
    // Adopting on a failed lookup would pick a room nobody checked.
    assert.equal(roomFits(null, [ADMIN]).ok, false);
  });
});

describe("MainRoom", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mainroom-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("adopts a room and records it", () => {
    const mr = new MainRoom(dir);
    assert.equal(mr.roomId, "", "nothing until a room is adopted");

    assert.equal(mr.adopt(ROOM, "first room that fits"), true);
    assert.equal(mr.roomId, ROOM);

    const saved = JSON.parse(readFileSync(join(dir, "main-room.json"), "utf8"));
    assert.equal(saved.roomId, ROOM);
    assert.match(saved.recordedBecause, /first room that fits/);
  });

  it("ignores later rooms once one is established", () => {
    const mr = new MainRoom(dir);
    mr.adopt(ROOM, "first room that fits");
    assert.equal(mr.adopt("!second:example.org", "first room that fits"), false);
    assert.equal(mr.roomId, ROOM);
  });

  it("survives a restart", () => {
    new MainRoom(dir).adopt("!kept:example.org", "first room that fits");
    assert.equal(new MainRoom(dir).roomId, "!kept:example.org", "read back from disk");
  });

  it("lets MATRIX_MAIN_ROOM pin a different room than the recorded one", () => {
    new MainRoom(dir).adopt("!recorded:example.org", "first room that fits");

    const pinned = new MainRoom(dir, "!pinned:example.org");
    assert.equal(pinned.roomId, "!pinned:example.org");
    assert.equal(pinned.isPinned, true);
    assert.equal(pinned.adopt("!other:example.org", "first room that fits"), false);
    assert.equal(pinned.roomId, "!pinned:example.org");
  });

  it("tolerates an unreadable record rather than failing to start", () => {
    writeFileSync(join(dir, "main-room.json"), "{ not json");
    assert.equal(new MainRoom(dir).roomId, "");
  });

  describe("dropping a main room that stopped working", () => {
    it("clears the record and the file, so another room can take over", () => {
      // Keeping it was the worse failure: commands are refused everywhere else
      // and unreachable there, so the only fix was editing a file on the host.
      const mr = new MainRoom(dir);
      mr.adopt(ROOM, "first room that fits");

      assert.equal(mr.unset("the bot was kicked from it"), true);
      assert.equal(mr.roomId, "");
      assert.equal(existsSync(join(dir, "main-room.json")), false);
      assert.equal(mr.adopt("!next:example.org", "the main room was lost"), true, "a new room can fill it");
    });

    it("does not unset a room pinned by MATRIX_MAIN_ROOM", () => {
      // The record would come back from the environment on the next start, so
      // clearing it would leave the operator arguing with a file.
      const pinned = new MainRoom(dir, ROOM);
      assert.equal(pinned.unset("the bot is not in it"), false);
      assert.equal(pinned.roomId, ROOM);
    });

    it("is a no-op when there is nothing to drop", () => {
      assert.equal(new MainRoom(dir).unset("whatever"), false);
    });
  });

  describe("verifying an established main room", () => {
    const settled = () => {
      const mr = new MainRoom(dir);
      mr.adopt(ROOM, "first room that fits");
      return mr;
    };

    it("passes a room the bot is in with its admin", () => {
      const r = settled().verify([ROOM], [BOT, ADMIN], [ADMIN]);
      assert.deepEqual(r.problems, []);
      assert.equal(r.present, true);
      assert.deepEqual(r.admins, [ADMIN]);
    });

    it("reports a main room the bot is not in", () => {
      // Used to log "Main room is !main" and carry on, so a kicked bot looked
      // healthy until every command was refused.
      const r = settled().verify(["!elsewhere:example.org"], null, [ADMIN]);
      assert.equal(r.present, false);
      assert.equal(r.problems.length, 1);
      assert.match(r.problems[0], /not in its main room/);
    });

    it("names MATRIX_MAIN_ROOM when a pinned room is the one missing", () => {
      const pinned = new MainRoom(dir, "!typo:example.org");
      const r = pinned.verify([ROOM], null, [ADMIN]);
      assert.match(r.problems[0], /MATRIX_MAIN_ROOM/, "a mistyped id is the likelier cause");
    });

    it("warns about a control channel with no admin, but keeps it", () => {
      // Strict to adopt, lenient to keep: the room still works.
      const r = settled().verify([ROOM], [BOT, "@stranger:example.org"], [ADMIN]);
      assert.equal(r.present, true);
      assert.deepEqual(r.admins, []);
      assert.equal(r.problems.length, 1);
      assert.match(r.problems[0], /none of MATRIX_ALLOWED_USERS/);
    });

    it("warns about a main room that is no longer private, but keeps it", () => {
      const r = settled().verify([ROOM], [BOT, ADMIN, "@third:example.org"], [ADMIN]);
      assert.equal(r.problems.length, 1);
      assert.match(r.problems[0], /3 members/);
    });

    it("reports both problems at once", () => {
      const r = settled().verify([ROOM], [BOT, "@a:example.org", "@b:example.org"], [ADMIN]);
      assert.equal(r.problems.length, 2);
    });

    it("checks what it can when the member list is unavailable", () => {
      const r = settled().verify([ROOM], null, [ADMIN]);
      assert.equal(r.present, true);
      assert.deepEqual(r.problems, [], "being in the room is all that could be established");
    });

    it("says nothing when no main room is established", () => {
      const r = new MainRoom(dir).verify([ROOM], [BOT, ADMIN], [ADMIN]);
      assert.deepEqual(r.problems, []);
      assert.equal(r.present, false);
    });
  });
});
