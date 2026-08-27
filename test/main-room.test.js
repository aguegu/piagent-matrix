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

    assert.equal(mr.adopt("!first:example.org", "first room joined"), true);
    assert.equal(mr.roomId, "!first:example.org");

    const saved = JSON.parse(readFileSync(join(dir, "main-room.json"), "utf8"));
    assert.equal(saved.roomId, "!first:example.org");
    assert.match(saved.recordedBecause, /first room joined/);
  });

  it("ignores later rooms once one is established", () => {
    const mr = new MainRoom(dir);
    mr.adopt("!first:example.org", "first room joined");
    assert.equal(mr.adopt("!second:example.org", "first room joined"), false);
    assert.equal(mr.roomId, "!first:example.org");
  });

  it("survives a restart", () => {
    new MainRoom(dir).adopt("!kept:example.org", "first room joined");
    assert.equal(new MainRoom(dir).roomId, "!kept:example.org", "read back from disk");
  });

  it("lets MATRIX_MAIN_ROOM pin a different room than the recorded one", () => {
    new MainRoom(dir).adopt("!recorded:example.org", "first room joined");

    const pinned = new MainRoom(dir, "!pinned:example.org");
    assert.equal(pinned.roomId, "!pinned:example.org");
    assert.equal(pinned.isPinned, true);
    // A pinned room must not be overwritten by whatever is joined next.
    assert.equal(pinned.adopt("!other:example.org", "first room joined"), false);
    assert.equal(pinned.roomId, "!pinned:example.org");
  });

  it("adopts the only joined room at startup for a bot that predates the record", () => {
    const mr = new MainRoom(dir);
    mr.settleOnStartup(["!only:example.org"]);
    assert.equal(mr.roomId, "!only:example.org");
    assert.ok(existsSync(join(dir, "main-room.json")), "and records it, so it is stable");
  });

  it("refuses to guess when several rooms are already joined", () => {
    const mr = new MainRoom(dir);
    mr.settleOnStartup(["!a:example.org", "!b:example.org"]);
    assert.equal(mr.roomId, "", "no guess: getJoinedRooms has no meaningful order");
    assert.equal(existsSync(join(dir, "main-room.json")), false, "and nothing is recorded");
  });

  it("stays unset with no rooms, ready for the first invite", () => {
    const mr = new MainRoom(dir);
    mr.settleOnStartup([]);
    assert.equal(mr.roomId, "");
    assert.equal(mr.adopt("!later:example.org", "first room joined"), true, "a later invite still wins");
  });

  it("tolerates an unreadable record rather than failing to start", () => {
    writeFileSync(join(dir, "main-room.json"), "{ not json");
    assert.equal(new MainRoom(dir).roomId, "");
  });
});
