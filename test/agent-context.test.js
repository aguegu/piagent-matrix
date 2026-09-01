import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentManager } from "../src/agent.js";

/**
 * Every turn resends the room's context, so its size is what decides what a
 * room costs. Nothing reported it, and one room reached 430,000 tokens a turn
 * before anybody noticed — by which point it was meeting the provider's token
 * ceiling several times a day.
 */

const ROOM = "!room:example.org";

const said = (text, usage) => ({
  type: "message_end",
  message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }], usage },
});

const errored = (usage) => ({
  type: "message_end",
  message: { role: "assistant", stopReason: "error", errorMessage: "429 nope", content: [], usage },
});

function makeSession(events, compactResult) {
  const listeners = [];
  return {
    get isStreaming() { return false; },
    subscribe(fn) { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
    async prompt() { for (const e of events) for (const fn of [...listeners]) fn(e); },
    async compact() { return compactResult ?? { summary: "…", tokensBefore: 430662, estimatedTokensAfter: 23654 }; },
    dispose() {},
  };
}

const client = { async sendMessage() { return "$evt"; } };

function makeManager(session) {
  const mgr = new AgentManager({ cwd: process.cwd(), createSession: async () => ({ session }) });
  mgr.model = { provider: "fake", id: "fake-model", contextWindow: 1_048_576 };
  mgr.briefed.add(ROOM);
  return mgr;
}

const talk = (mgr) =>
  mgr.handleMessage({ roomId: ROOM, text: "hello", sender: "@a:example.org", client });

describe("what a room's context costs", () => {
  it("knows nothing until a reply lands", () => {
    const mgr = makeManager(makeSession([]));

    assert.deepEqual(mgr.describeContext(ROOM), { tokens: null, window: 1_048_576 });
  });

  it("records what the last reply carried", async () => {
    const mgr = makeManager(makeSession([said("hi", { totalTokens: 93_864 })]));

    await talk(mgr);

    assert.equal(mgr.describeContext(ROOM).tokens, 93_864);
  });

  it("does not let a failed turn's empty usage erase the measurement", async () => {
    // An errored turn reports zeroes across the board. Recording that would
    // read as "this room is cheap now" the moment the provider rate-limits us.
    const mgr = makeManager(makeSession([said("hi", { totalTokens: 93_864 })]));
    await talk(mgr);

    mgr.sessions.clear();
    const failing = makeSession([errored({ input: 0, output: 0, cacheRead: 0, totalTokens: 0 })]);
    mgr.createSession = async () => ({ session: failing });
    await talk(mgr);

    assert.equal(mgr.describeContext(ROOM).tokens, 93_864, "still the last real measurement");
  });

  it("shows the new size straight after compacting", async () => {
    const mgr = makeManager(makeSession([said("hi", { totalTokens: 430_662 })]));
    await talk(mgr);
    assert.equal(mgr.describeContext(ROOM).tokens, 430_662);

    await mgr.compact(ROOM);

    assert.equal(mgr.describeContext(ROOM).tokens, 23_654, "not the number it just replaced");
  });

  it("keeps rooms apart", async () => {
    const mgr = makeManager(makeSession([said("hi", { totalTokens: 1_234 })]));
    await talk(mgr);

    assert.equal(mgr.describeContext("!elsewhere:example.org").tokens, null);
  });
});
