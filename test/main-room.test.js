import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MainRoom, chooseAdmin, roomFits } from "../src/main-room.js";

const ROOM = "!main:example.org";
const ADMIN = "@agu:example.org";
const BOT = "@bot:example.org";

describe("what makes a room fit to be the main room", () => {
  it("accepts the bot alone with an allowed user, and names them", () => {
    // The admin is returned so it can be recorded with the room: an id alone
    // says where the bot takes orders, not who from.
    assert.deepEqual(roomFits([BOT, ADMIN], [ADMIN], BOT), { ok: true, why: "", admin: ADMIN });
  });

  it("rejects a room holding nobody who may command the bot", () => {
    // This is what makes adoption safe: a stranger cannot hand the bot a
    // control channel by inviting it somewhere.
    const fit = roomFits([BOT, "@stranger:example.org"], [ADMIN], BOT);
    assert.equal(fit.ok, false);
    assert.equal(fit.admin, "");
    assert.match(fit.why, /MATRIX_ALLOWED_USERS/);
  });

  it("rejects a room that is not private", () => {
    const fit = roomFits([BOT, ADMIN, "@third:example.org"], [ADMIN], BOT);
    assert.equal(fit.ok, false);
    assert.match(fit.why, /3 members/);
  });

  it("names no admin when the allowlist is empty", () => {
    // Everyone may command it then, so the other member is merely the other
    // member — and in a room of two bots that would have recorded one of them
    // as the other's admin. The room still fits; who owns it comes from the
    // invite instead.
    const fit = roomFits([BOT, "@anyone:example.org"], [], BOT);
    assert.equal(fit.ok, true);
    assert.equal(fit.admin, "");
  });

  it("rejects a room the bot would be alone in", () => {
    // Nobody to answer to, whatever the allowlist says.
    assert.equal(roomFits([BOT], [], BOT).ok, false);
    assert.equal(roomFits([BOT], [ADMIN], BOT).ok, false);
  });

  it("rejects a room whose membership could not be read", () => {
    // Adopting on a failed lookup would pick a room nobody checked.
    assert.equal(roomFits(null, [ADMIN], BOT).ok, false);
  });
});

describe("who the main room belongs to", () => {
  it("is whoever invited the bot into it", () => {
    assert.equal(chooseAdmin(ADMIN, ""), ADMIN);
  });

  it("prefers the invite over the room's membership", () => {
    // With no allowlist the membership says nothing; with one it agrees anyway
    // in the ordinary case. The invite is the fact either way.
    assert.equal(chooseAdmin(ADMIN, "@someone-else:example.org"), ADMIN);
  });

  it("falls back to the allowlisted member when no invite was seen", () => {
    // A room adopted at startup, joined before this run.
    assert.equal(chooseAdmin(undefined, ADMIN), ADMIN);
  });

  it("records nobody when neither is known", () => {
    // Unrecorded reads as unknown, which is true; a guess reads as established.
    assert.equal(chooseAdmin(undefined, ""), "");
  });
});

describe("MainRoom", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mainroom-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("adopts a room and records it, with the admin it was adopted for", () => {
    const mr = new MainRoom(dir);
    assert.equal(mr.roomId, "", "nothing until a room is adopted");

    assert.equal(mr.adopt(ROOM, "first room that fits", ADMIN), true);
    assert.equal(mr.roomId, ROOM);
    assert.equal(mr.admin, ADMIN);

    const saved = JSON.parse(readFileSync(join(dir, "main-room.json"), "utf8"));
    assert.equal(saved.roomId, ROOM);
    assert.equal(saved.admin, ADMIN);
    assert.match(saved.recordedBecause, /first room that fits/);
  });

  it("reads the admin back after a restart", () => {
    new MainRoom(dir).adopt(ROOM, "first room that fits", ADMIN);
    assert.equal(new MainRoom(dir).admin, ADMIN);
  });

  it("copes with a record written before the admin was stored", () => {
    writeFileSync(join(dir, "main-room.json"), JSON.stringify({ roomId: ROOM }));
    const mr = new MainRoom(dir);
    assert.equal(mr.roomId, ROOM, "the room still works");
    assert.equal(mr.admin, "", "there simply is no admin recorded");
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

    it("comes back unset after a restart, since the file is gone", () => {
      const mr = new MainRoom(dir);
      mr.adopt(ROOM, "first room that fits");
      mr.unset("the bot was kicked from it");
      assert.equal(new MainRoom(dir).roomId, "", "nothing to argue with on the next start");
    });

    it("is a no-op when there is nothing to drop", () => {
      assert.equal(new MainRoom(dir).unset("whatever"), false);
    });
  });

  describe("verifying an established main room", () => {
    const settled = () => {
      const mr = new MainRoom(dir);
      mr.adopt(ROOM, "first room that fits", ADMIN);
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

    it("warns about a control channel with no admin, but keeps it", () => {
      // Strict to adopt, lenient to keep: the room still works.
      const r = settled().verify([ROOM], [BOT, "@stranger:example.org"], [ADMIN]);
      assert.equal(r.present, true);
      assert.deepEqual(r.admins, []);
      assert.equal(r.problems.length, 2);
      assert.match(r.problems[0], /none of MATRIX_ALLOWED_USERS/);
      assert.match(r.problems[1], /no longer in it/, "and names who is missing");
    });

    it("warns when the recorded admin has left, even if another allowed user is there", () => {
      const other = "@colleague:example.org";
      const r = settled().verify([ROOM], [BOT, other], [ADMIN, other]);
      assert.deepEqual(r.admins, [other], "the room still has someone who may command it");
      assert.equal(r.problems.length, 1);
      assert.match(r.problems[0], new RegExp(`${ADMIN} adopted`));
    });

    it("warns about a main room that is no longer private, but keeps it", () => {
      const r = settled().verify([ROOM], [BOT, ADMIN, "@third:example.org"], [ADMIN]);
      assert.equal(r.problems.length, 1);
      assert.match(r.problems[0], /3 members/);
    });

    it("reports every problem at once", () => {
      const r = settled().verify([ROOM], [BOT, "@a:example.org", "@b:example.org"], [ADMIN]);
      assert.equal(r.problems.length, 3, "no allowed user, admin gone, and not private");
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
