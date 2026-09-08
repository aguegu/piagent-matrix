import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager } from "../src/agent.js";

/**
 * `.session` reports what a room has cost. pi's own `/session` is a built-in,
 * dispatched by its interactive UI rather than by prompt(), so — like
 * `/compact` — typing it in a room reaches the model as ordinary text and
 * reports nothing. This calls getSessionStats() instead.
 */

const ROOM = "!room:example.org";

const STATS = {
  sessionId: "01a04e7c",
  sessionFile: "/somewhere/on/disk.jsonl",
  totalMessages: 412,
  userMessages: 168,
  assistantMessages: 200,
  toolCalls: 44,
  toolResults: 44,
  tokens: { input: 120_000, output: 45_678, cacheRead: 12_000_000, cacheWrite: 0, total: 12_165_678 },
  cost: 4.3216,
  contextUsage: { tokens: 41_591 },
};

function makeSession(stats = STATS) {
  return {
    statsCalls: 0,
    get isStreaming() { return false; },
    subscribe() { return () => {}; },
    async prompt() {},
    getSessionStats() { this.statsCalls += 1; return stats; },
    dispose() {},
  };
}

function makeManager(session, opts = {}) {
  const mgr = new AgentManager({ cwd: process.cwd(), createSession: async () => ({ session }), ...opts });
  mgr.model = { provider: "fake", id: "fake-model" };
  return mgr;
}

describe("what a room's session has cost", () => {
  it("reports pi's own accounting for a live room", async () => {
    const session = makeSession();
    const mgr = makeManager(session);
    mgr.briefed.add(ROOM);
    await mgr.handleMessage({
      roomId: ROOM, text: "hi", sender: "@a:example.org",
      client: { async sendMessage() { return "$e"; } },
    });

    const stats = await mgr.describeSession(ROOM);

    assert.equal(stats.sessionId, "01a04e7c");
    assert.equal(stats.totalMessages, 412);
    assert.equal(stats.cost, 4.3216);
    assert.equal(session.statsCalls, 1);
  });

  it("reads a room whose session is on disk but not in memory", async () => {
    // The same cold-map trap `.compact` shipped with: a restart empties the map
    // while the transcript stays, and "no session" would be the wrong answer
    // for the room that has spent the most.
    const sessionDir = mkdtempSync(join(tmpdir(), "sessions-"));
    const roomDir = join(sessionDir, ROOM.replace(/[!@:/\\]/g, "_"));
    mkdirSync(roomDir, { recursive: true });
    writeFileSync(join(roomDir, "2026-09-02T00-00-00_abc.jsonl"), "{}\n");

    const session = makeSession();
    const mgr = makeManager(session, { sessionDir });
    assert.equal(mgr.sessions.size, 0, "cold, as after a restart");

    const stats = await mgr.describeSession(ROOM);

    assert.equal(stats.sessionId, "01a04e7c");
  });

  it("says nothing was spent in a room with no session and no transcript", async () => {
    const session = makeSession();
    const mgr = makeManager(session, { sessionDir: mkdtempSync(join(tmpdir(), "sessions-")) });

    assert.equal(await mgr.describeSession("!never:example.org"), null);
    assert.equal(session.statsCalls, 0);
    assert.equal(mgr.sessions.size, 0, "reading must not open a session");
  });

  it("survives a pi build that does not expose the stats", async () => {
    // getSessionStats is public API, but the reply should degrade rather than
    // throw if a future version moves it.
    const session = makeSession();
    delete session.getSessionStats;
    const mgr = makeManager(session);
    mgr.briefed.add(ROOM);
    await mgr.handleMessage({
      roomId: ROOM, text: "hi", sender: "@a:example.org",
      client: { async sendMessage() { return "$e"; } },
    });

    assert.equal(await mgr.describeSession(ROOM), null);
  });
});
