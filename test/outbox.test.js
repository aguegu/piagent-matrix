import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startOutbox } from "../src/outbox.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Drop a file the way a writer must: write outside, then rename in. */
function spool(dir, name, body) {
  const tmp = join(dir, `.tmp-${name}`);
  writeFileSync(tmp, body);
  renameSync(tmp, join(dir, name));
}

function fakeClient() {
  const sent = [];
  return { sent, async sendMessage(roomId, content) { sent.push({ roomId, body: content.body }); return "$e"; } };
}

/** Wait for the outbox to settle, rather than guessing a fixed delay. */
async function settle(dir, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(50);
    const pending = readdirSync(dir).filter((n) => n.endsWith(".txt") || n.endsWith(".json"));
    if (pending.length === 0) return;
  }
}

describe("outbox", () => {
  let dir;
  let stop;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "outbox-test-"));
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends a .txt drop to the default room", async () => {
    const client = fakeClient();
    stop = startOutbox(client, { dir, defaultRoom: "!room:example.org", pollMs: 100 });

    spool(dir, "20260101T000000Z-a.txt", "hello\n");
    await settle(dir);

    assert.deepEqual(client.sent, [{ roomId: "!room:example.org", body: "hello" }]);
    assert.deepEqual(readdirSync(dir), [], "the spool is drained on success");
  });

  it("parks a .txt drop as .failed when there is no default room", async () => {
    // This is the state index.js produces when the bot starts before being
    // invited anywhere: joined[0] is undefined, so defaultRoom is "".
    const client = fakeClient();
    stop = startOutbox(client, { dir, defaultRoom: "", pollMs: 100 });

    spool(dir, "20260101T000000Z-a.txt", "hello\n");
    await settle(dir);

    assert.equal(client.sent.length, 0, "nothing is sent");
    const failed = readdirSync(dir).filter((n) => n.endsWith(".failed"));
    assert.equal(failed.length, 1, "the drop is parked as .failed, not retried or lost");
  });

  it("still routes a .json drop that names its own room", async () => {
    // The same empty-default state must not block explicitly addressed messages.
    const client = fakeClient();
    stop = startOutbox(client, { dir, defaultRoom: "", pollMs: 100 });

    spool(dir, "20260101T000000Z-b.json", JSON.stringify({ room: "!explicit:example.org", body: "hi" }));
    await settle(dir);

    assert.deepEqual(client.sent, [{ roomId: "!explicit:example.org", body: "hi" }]);
  });

  it("sends messages spooled while it was not running", async () => {
    const client = fakeClient();
    spool(dir, "20260101T000000Z-early.txt", "queued while down");

    stop = startOutbox(client, { dir, defaultRoom: "!room:example.org", pollMs: 100 });
    await settle(dir);

    assert.deepEqual(client.sent.map((m) => m.body), ["queued while down"]);
  });

  it("processes drops in filename order", async () => {
    const client = fakeClient();
    stop = startOutbox(client, { dir, defaultRoom: "!room:example.org", pollMs: 100 });

    spool(dir, "20260101T000003Z-c.txt", "third");
    spool(dir, "20260101T000001Z-a.txt", "first");
    spool(dir, "20260101T000002Z-b.txt", "second");
    await settle(dir);

    assert.deepEqual(client.sent.map((m) => m.body), ["first", "second", "third"]);
  });

  it("parks an orphaned .sending claim rather than risking a duplicate send", async () => {
    // Left behind by a crash mid-send: we cannot know whether it reached the
    // server, so it must not be replayed.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "20260101T000000Z-a.txt.sending"), "ambiguous");

    const client = fakeClient();
    stop = startOutbox(client, { dir, defaultRoom: "!room:example.org", pollMs: 100 });
    await sleep(300);

    assert.equal(client.sent.length, 0, "an ambiguous claim is never re-sent");
    assert.ok(
      readdirSync(dir).some((n) => n.endsWith(".failed")),
      "it is parked for inspection",
    );
  });
});
