import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentManager } from "../src/agent.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stands in for a pi AgentSession, reproducing the one behaviour that matters
 * here: prompt() called while the session is already streaming does NOT run —
 * it queues the text as a follow-up and returns immediately.
 */
function makeFakeSession() {
  const listeners = [];
  let streaming = false;
  const promptsRun = [];
  const promptsQueued = [];

  return {
    promptsRun,
    promptsQueued,
    get isStreaming() {
      return streaming;
    },
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt(text) {
      if (streaming) {
        promptsQueued.push(text);
        return; // <- the trap: returns without producing anything
      }
      streaming = true;
      promptsRun.push(text);
      await sleep(20);
      for (const fn of [...listeners]) {
        fn({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            partial: { role: "assistant", content: [{ type: "text", text: `reply to ${text}` }] },
          },
        });
      }
      await sleep(20);
      streaming = false;
    },
    dispose() {},
  };
}

function makeFakeClient() {
  const sent = [];
  return { sent, async sendMessage(roomId, content) { sent.push({ roomId, body: content.body }); return "$evt"; } };
}

function makeManager(session) {
  const mgr = new AgentManager({
    cwd: process.cwd(),
    createSession: async () => ({ session }),
  });
  // Skip ModelRuntime.create(), which would touch real auth/model config.
  mgr.model = { provider: "fake", id: "fake-model" };
  return mgr;
}

describe("AgentManager per-room serialization", () => {
  it("gives every concurrent message its own run and its own reply", async () => {
    const session = makeFakeSession();
    const client = makeFakeClient();
    const mgr = makeManager(session);
    const roomId = "!room:example.org";

    // Both arrive before the first run finishes — the case that used to drop
    // the second reply entirely.
    await Promise.all([
      mgr.handleMessage({ roomId, text: "first", sender: "@a:example.org", client }),
      mgr.handleMessage({ roomId, text: "second", sender: "@a:example.org", client }),
    ]);

    assert.deepEqual(session.promptsRun, ["first", "second"], "both prompts must run as real runs");
    assert.deepEqual(session.promptsQueued, [], "nothing should fall into the follow-up queue");
    assert.equal(client.sent.length, 2, "each message gets exactly one reply");
    assert.deepEqual(
      client.sent.map((m) => m.body),
      ["reply to first", "reply to second"],
      "replies must match their prompts, in order",
    );
  });

  it("keeps serving after a failing run", async () => {
    const session = makeFakeSession();
    const client = makeFakeClient();
    const mgr = makeManager(session);
    const roomId = "!room:example.org";

    const boom = new Error("model exploded");
    const realPrompt = session.prompt.bind(session);
    let calls = 0;
    session.prompt = async (text) => {
      calls += 1;
      if (calls === 1) throw boom;
      return realPrompt(text);
    };

    const results = await Promise.allSettled([
      mgr.handleMessage({ roomId, text: "bad", sender: "@a:example.org", client }),
      mgr.handleMessage({ roomId, text: "good", sender: "@a:example.org", client }),
    ]);

    assert.equal(results[0].status, "rejected", "the failing run still reports failure");
    assert.equal(results[1].status, "fulfilled", "a failed predecessor must not block the queue");
    assert.ok(
      client.sent.some((m) => m.body === "reply to good"),
      "the following message is still answered",
    );
  });

  it("refuses rather than growing an unbounded backlog", async () => {
    const session = makeFakeSession();
    const client = makeFakeClient();
    const mgr = makeManager(session);
    const roomId = "!room:example.org";

    const many = Array.from({ length: 12 }, (_, i) =>
      mgr.handleMessage({ roomId, text: `m${i}`, sender: "@a:example.org", client }),
    );
    await Promise.allSettled(many);

    const dropped = client.sent.filter((m) => m.body.includes("was dropped"));
    assert.ok(dropped.length > 0, "over-cap messages are refused explicitly, not silently");
    assert.ok(session.promptsRun.length <= 12, "no run is duplicated");
  });
});

describe("session creation failures do not poison a room", () => {
  it("retries after a failed session creation instead of replaying the error", async () => {
    const session = makeFakeSession();
    const client = makeFakeClient();
    const roomId = "!room:example.org";

    // First attempt fails the way a missing provider does; later ones succeed.
    let attempts = 0;
    const mgr = new AgentManager({
      cwd: process.cwd(),
      createSession: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("No models with complete auth are available");
        return { session };
      },
    });
    mgr.model = { provider: "fake", id: "fake-model" };

    await assert.rejects(
      mgr.handleMessage({ roomId, text: "first", sender: "@a:example.org", client }),
      /No models with complete auth/,
      "the first message surfaces the real error",
    );

    // The cause is now fixed; the next message must try again rather than
    // replay the cached rejection.
    await mgr.handleMessage({ roomId, text: "second", sender: "@a:example.org", client });

    assert.equal(attempts, 2, "session creation is retried, not replayed from cache");
    assert.deepEqual(
      client.sent.map((m) => m.body),
      ["reply to second"],
      "the retried message is answered",
    );
  });
});
