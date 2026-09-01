import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentManager } from "../src/agent.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `.compact` calls pi's compact() directly rather than prompting "/compact".
 * A built-in slash command is dispatched by pi's interactive and RPC modes, not
 * by AgentSession.prompt() — which only executes extension commands and expands
 * skill commands and prompt templates. Sent as a prompt it would reach the
 * model as ordinary text and compact nothing.
 */
function makeFakeSession({ order = [], compactResult } = {}) {
  const listeners = [];
  let streaming = false;
  return {
    order,
    compactCalls: 0,
    get isStreaming() {
      return streaming;
    },
    subscribe(fn) {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
    async prompt(text) {
      streaming = true;
      order.push("prompt:start");
      await sleep(30);
      for (const fn of [...listeners]) {
        fn({
          type: "message_end",
          message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `reply to ${text}` }] },
        });
      }
      order.push("prompt:end");
      streaming = false;
    },
    async compact() {
      this.compactCalls += 1;
      order.push("compact");
      // pi refuses a prompt while compaction runs, and compaction aborts a run;
      // a fake that tolerated overlap would hide exactly the bug that matters.
      assert.equal(streaming, false, "compaction must never overlap a run");
      return compactResult ?? { summary: "…", tokensBefore: 93764, estimatedTokensAfter: 12000 };
    },
    dispose() {},
  };
}

function makeFakeClient() {
  const sent = [];
  return {
    sent,
    async sendMessage(roomId, content) {
      sent.push({ roomId, body: content.body });
      return "$evt";
    },
  };
}

function makeManager(session) {
  const mgr = new AgentManager({
    cwd: process.cwd(),
    createSession: async () => ({ session }),
  });
  mgr.model = { provider: "fake", id: "fake-model" };
  return mgr;
}

const ROOM = "!room:example.org";

describe("compacting one room's session", () => {
  it("reports what the summary saved", async () => {
    const session = makeFakeSession();
    const mgr = makeManager(session);
    mgr.briefed.add(ROOM);
    await mgr.handleMessage({ roomId: ROOM, text: "hello", sender: "@a:example.org", client: makeFakeClient() });

    const result = await mgr.compact(ROOM);

    assert.deepEqual(result, { compacted: true, before: 93764, after: 12000 });
    assert.equal(session.compactCalls, 1);
  });

  it("does nothing in a room with no session, and opens none", async () => {
    const session = makeFakeSession();
    const mgr = makeManager(session);

    const result = await mgr.compact("!never-spoken-in:example.org");

    assert.deepEqual(result, { compacted: false }, "there is no history to shed");
    assert.equal(session.compactCalls, 0);
    assert.equal(mgr.sessions.size, 0, "compacting must not create a session");
  });

  it("waits for a run in flight instead of overlapping it", async () => {
    const order = [];
    const session = makeFakeSession({ order });
    const mgr = makeManager(session);
    mgr.briefed.add(ROOM);

    // Open the session first, so compact() sees a room it knows about.
    await mgr.handleMessage({ roomId: ROOM, text: "first", sender: "@a:example.org", client: makeFakeClient() });
    order.length = 0;

    // A message and a .compact racing, which is what a busy room does.
    await Promise.all([
      mgr.handleMessage({ roomId: ROOM, text: "second", sender: "@a:example.org", client: makeFakeClient() }),
      mgr.compact(ROOM),
    ]);

    assert.deepEqual(order, ["prompt:start", "prompt:end", "compact"]);
  });

  it("still reports success when pi gives no token counts", async () => {
    const session = makeFakeSession({ compactResult: { summary: "…" } });
    const mgr = makeManager(session);
    mgr.briefed.add(ROOM);
    await mgr.handleMessage({ roomId: ROOM, text: "hello", sender: "@a:example.org", client: makeFakeClient() });

    const result = await mgr.compact(ROOM);

    assert.equal(result.compacted, true);
    assert.equal(result.before, undefined);
  });
});
