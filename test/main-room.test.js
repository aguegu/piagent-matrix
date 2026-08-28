import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MainRoom } from "../src/main-room.js";

describe("MainRoom", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mainroom-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("adopts the first room joined and records it", () => {
    const mr = new MainRoom(dir);
    assert.equal(mr.roomId, "", "nothing until a room is joined");

    assert.equal(mr.adoptOnJoin("!first:example.org", 1), true);
    assert.equal(mr.roomId, "!first:example.org");

    const saved = JSON.parse(readFileSync(join(dir, "main-room.json"), "utf8"));
    assert.equal(saved.roomId, "!first:example.org");
    assert.match(saved.recordedBecause, /first room joined/);
  });

  it("ignores later rooms once one is established", () => {
    const mr = new MainRoom(dir);
    mr.adoptOnJoin("!first:example.org", 1);
    assert.equal(mr.adoptOnJoin("!second:example.org", 2), false);
    assert.equal(mr.roomId, "!first:example.org");
  });

  it("adopts only on the 0 -> 1 join, not on whichever room comes next", () => {
    // A bot already sitting in rooms that lost its record must not hand the
    // control channel to an arbitrary arrival, or to whoever invited it.
    const mr = new MainRoom(dir);
    assert.equal(mr.adoptOnJoin("!third:example.org", 3), false);
    assert.equal(mr.roomId, "", "nothing adopted");
    assert.equal(existsSync(join(dir, "main-room.json")), false, "and nothing recorded");
  });

  it("declines when the joined count is unknown", () => {
    // getJoinedRooms() failing leaves it undefined. Not adopting is the
    // outcome an operator can still fix; adopting the wrong room is not.
    const mr = new MainRoom(dir);
    assert.equal(mr.adoptOnJoin("!unknown:example.org", undefined), false);
    assert.equal(mr.roomId, "");
  });

  it("survives a restart", () => {
    new MainRoom(dir).adoptOnJoin("!kept:example.org", 1);
    assert.equal(new MainRoom(dir).roomId, "!kept:example.org", "read back from disk");
  });

  it("lets MATRIX_MAIN_ROOM pin a different room than the recorded one", () => {
    new MainRoom(dir).adoptOnJoin("!recorded:example.org", 1);

    const pinned = new MainRoom(dir, "!pinned:example.org");
    assert.equal(pinned.roomId, "!pinned:example.org");
    assert.equal(pinned.isPinned, true);
    // A pinned room must not be overwritten by whatever is joined next.
    assert.equal(pinned.adoptOnJoin("!other:example.org", 1), false);
    assert.equal(pinned.roomId, "!pinned:example.org");
  });

  it("adopts the only joined room at startup for a bot that predates the record", () => {
    const mr = new MainRoom(dir);
    // Returns what it adopted, so the caller can announce it in that room.
    assert.equal(mr.settleOnStartup(["!only:example.org"]), "!only:example.org");
    assert.equal(mr.roomId, "!only:example.org");
    assert.ok(existsSync(join(dir, "main-room.json")), "and records it, so it is stable");
    assert.equal(mr.settleOnStartup(["!only:example.org"]), "", "and does not re-announce on the next start");
  });

  it("refuses to guess when several rooms are already joined", () => {
    const mr = new MainRoom(dir);
    assert.equal(mr.settleOnStartup(["!a:example.org", "!b:example.org"]), "", "nothing to announce");
    assert.equal(mr.roomId, "", "no guess: getJoinedRooms has no meaningful order");
    assert.equal(existsSync(join(dir, "main-room.json")), false, "and nothing is recorded");
  });

  it("stays unset with no rooms, ready for the first invite", () => {
    const mr = new MainRoom(dir);
    assert.equal(mr.settleOnStartup([]), "");
    assert.equal(mr.roomId, "");
    assert.equal(mr.adoptOnJoin("!later:example.org", 1), true, "a later invite still wins");
  });

  describe("verifying an established main room", () => {
    const ROOM = "!main:example.org";
    const ADMIN = "@agu:example.org";
    const BOT = "@bot:example.org";
    const settled = () => {
      const mr = new MainRoom(dir);
      mr.adoptOnJoin(ROOM, 1);
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
      assert.match(r.problems[0], /record is kept/, "and says a re-invite restores it");
    });

    it("names MATRIX_MAIN_ROOM when a pinned room is the one missing", () => {
      const pinned = new MainRoom(dir, "!typo:example.org");
      const r = pinned.verify([ROOM], null, [ADMIN]);
      assert.match(r.problems[0], /MATRIX_MAIN_ROOM/, "a mistyped id is the likelier cause");
    });

    it("reports a control channel with no admin in it", () => {
      const r = settled().verify([ROOM], [BOT, "@stranger:example.org"], [ADMIN]);
      assert.equal(r.present, true);
      assert.deepEqual(r.admins, []);
      assert.equal(r.problems.length, 1);
      assert.match(r.problems[0], /none of MATRIX_ALLOWED_USERS/);
    });

    it("does not ask who the admin is when the allowlist is empty", () => {
      // Empty means everyone, so the question does not arise.
      const r = settled().verify([ROOM], [BOT, "@anyone:example.org"], []);
      assert.deepEqual(r.problems, []);
    });

    it("still flags a main room that is not private", () => {
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

  it("tolerates an unreadable record rather than failing to start", () => {
    writeFileSync(join(dir, "main-room.json"), "{ not json");
    assert.equal(new MainRoom(dir).roomId, "");
  });
});
