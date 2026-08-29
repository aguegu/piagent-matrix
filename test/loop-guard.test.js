import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLoopGuard } from "../src/loop-guard.js";

const ROOM = "!r:example.org";
const OTHER = "!other:example.org";

describe("bounding a run of bots answering bots", () => {
  it("lets a person speak without limit", () => {
    const g = createLoopGuard(3);
    for (let i = 0; i < 20; i += 1) assert.equal(g.allow(ROOM, false), true);
  });

  it("allows automated messages up to the limit, then stops", () => {
    // The agent decides when an exchange is finished, and did once the silence
    // rule existed. This is only for when it does not.
    const g = createLoopGuard(3);
    assert.deepEqual([1, 2, 3, 4, 5].map(() => g.allow(ROOM, true)), [true, true, true, false, false]);
  });

  it("a person speaking resumes it", () => {
    const g = createLoopGuard(2);
    g.allow(ROOM, true);
    g.allow(ROOM, true);
    assert.equal(g.allow(ROOM, true), false, "spent");

    assert.equal(g.allow(ROOM, false), true, "a person is always heard");
    assert.equal(g.allow(ROOM, true), true, "and the machines may talk again");
  });

  it("counts each room on its own", () => {
    const g = createLoopGuard(1);
    assert.equal(g.allow(ROOM, true), true);
    assert.equal(g.allow(ROOM, true), false);
    assert.equal(g.allow(OTHER, true), true, "a busy room does not mute a quiet one");
  });

  it("forgets a room the bot has left", () => {
    const g = createLoopGuard(1);
    g.allow(ROOM, true);
    assert.equal(g.allow(ROOM, true), false);
    g.forget(ROOM);
    assert.equal(g.allow(ROOM, true), true, "a re-invite starts fresh");
  });

  it("reports the streak, for the log", () => {
    const g = createLoopGuard(1);
    g.allow(ROOM, true);
    g.allow(ROOM, true);
    assert.equal(g.streakOf(ROOM), 2);
    assert.equal(g.streakOf(OTHER), 0);
  });
});
