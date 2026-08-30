import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startInbox } from "../src/inbox.js";

const ROOM = "!main:example.org";
const settle = () => new Promise((r) => setTimeout(r, 60));

describe("inbox", () => {
  let dir;
  let stop;
  let ran;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "inbox-")); ran = []; });
  afterEach(() => { stop?.(); rmSync(dir, { recursive: true, force: true }); });

  /** Writers rename in; writing in place risks the bot reading half a file. */
  const drop = (name, contents) => {
    const tmp = join(dir, `.${name}`);
    writeFileSync(tmp, contents);
    renameSync(tmp, join(dir, name));
  };

  const start = (defaultRoom = ROOM) => {
    stop = startInbox({
      dir,
      defaultRoom,
      pollMs: 20,
      deliver: async (job) => { ran.push(job); },
    });
  };

  it("runs a .json drop as a prompt in the room it names", async () => {
    start("");
    drop("1-weather.json", JSON.stringify({ room: "!other:example.org", prompt: "fetch the weather" }));
    await settle();

    assert.deepEqual(ran, [{
      roomId: "!other:example.org",
      prompt: "fetch the weather",
      from: "a scheduled job on this host",
    }]);
    assert.deepEqual(readdirSync(dir), [], "consumed on success");
  });

  it("runs a .txt drop in the main room", async () => {
    start();
    drop("1-note.txt", "summarise today\n");
    await settle();
    assert.deepEqual(ran.map((j) => [j.roomId, j.prompt]), [[ROOM, "summarise today"]]);
  });

  it("carries a stated origin, since the agent is told who is speaking", async () => {
    start();
    drop("1.json", JSON.stringify({ prompt: "go", from: "the hourly weather cron" }));
    await settle();
    assert.equal(ran[0].from, "the hourly weather cron");
  });

  it("says which spool a body belongs in", async () => {
    // The two look alike, and one was already used for the other's job: a cron
    // wrote its cue into the outbox, which posted it to the room where the
    // agent it was meant for ignored it.
    start();
    drop("1.json", JSON.stringify({ body: "an announcement" }));
    await settle();

    assert.deepEqual(ran, [], "not run as a prompt");
    assert.ok(readdirSync(dir).some((n) => n.endsWith(".failed")), "parked for inspection");
  });

  it("parks a drop with no room and no main room", async () => {
    start("");
    drop("1.txt", "do a thing");
    await settle();
    assert.deepEqual(ran, []);
    assert.ok(readdirSync(dir).some((n) => n.endsWith(".failed")));
  });

  it("parks an empty prompt rather than waking the agent for nothing", async () => {
    start();
    drop("1.json", JSON.stringify({ prompt: "   " }));
    await settle();
    assert.deepEqual(ran, []);
    assert.ok(readdirSync(dir).some((n) => n.endsWith(".failed")));
  });

  it("runs drops in filename order", async () => {
    start();
    drop("3-c.txt", "c"); drop("1-a.txt", "a"); drop("2-b.txt", "b");
    await settle();
    assert.deepEqual(ran.map((j) => j.prompt), ["a", "b", "c"]);
  });

  it("parks an orphaned claim rather than running it twice", async () => {
    // Died mid-run: whether the agent already did the work is unknowable, and
    // repeating it is a second agent run with real effects.
    writeFileSync(join(dir, "1-x.json.working"), JSON.stringify({ prompt: "go" }));
    start();
    await settle();
    assert.deepEqual(ran, []);
    assert.ok(existsSync(join(dir, "1-x.json.failed")));
  });

  it("does nothing without a directory", () => {
    assert.doesNotThrow(() => startInbox({ deliver: async () => {} })());
  });
});
