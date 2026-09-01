import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentManager } from "../src/agent.js";

/**
 * A run that fails completely and a run that chooses to say nothing both end
 * with an empty reply buffer. pi retries an API failure internally and then
 * resolves the prompt, so the caller's catch never fires — which is how a
 * provider quota limit came to look like the bot ignoring the room.
 *
 * The events here are the shapes pi actually emits, taken from a session
 * transcript recorded during the outage.
 */

const QUOTA_429 =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"Token Plan quota reached: upgrade the plan or buy credits. (2056)"},"request_id":"06e5ab"}';

const errored = (errorMessage) => ({
  type: "message_end",
  message: { role: "assistant", stopReason: "error", errorMessage, content: [] },
});

const said = (text) => ({
  type: "message_end",
  message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
});

/** Emits a scripted list of events for each prompt, then returns normally. */
function makeScriptedSession(events) {
  const listeners = [];
  return {
    get isStreaming() {
      return false;
    },
    subscribe(fn) {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
    async prompt() {
      for (const event of events) for (const fn of [...listeners]) fn(event);
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

async function run(events) {
  const client = makeFakeClient();
  const mgr = new AgentManager({
    cwd: process.cwd(),
    createSession: async () => ({ session: makeScriptedSession(events) }),
  });
  mgr.model = { provider: "fake", id: "fake-model" };
  const roomId = "!room:example.org";
  mgr.briefed.add(roomId); // steady state: skip the first-prompt briefing
  await mgr.handleMessage({ roomId, text: "hello", sender: "@a:example.org", client });
  return client.sent;
}

describe("a run that failed is not a run that chose silence", () => {
  it("reports a provider failure that produced no text", async () => {
    const sent = await run([errored(QUOTA_429)]);

    assert.equal(sent.length, 1, "the room must be told, not left in silence");
    assert.match(sent[0].body, /No reply/);
    assert.match(sent[0].body, /Token Plan quota reached/, "the provider's own words");
    assert.match(sent[0].body, /429 rate_limit_error/, "the status and kind");
    assert.doesNotMatch(sent[0].body, /request_id/, "the envelope is noise in a room");
  });

  it("counts the attempts when pi retried before giving up", async () => {
    const sent = await run([errored(QUOTA_429), errored(QUOTA_429), errored(QUOTA_429)]);

    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /after 3 attempts/);
  });

  it("says nothing extra when a retry eventually succeeded", async () => {
    const sent = await run([errored(QUOTA_429), said("here you go")]);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].body, "here you go", "a recovered run is just an answer");
  });

  it("keeps the text and marks it cut short when a later attempt failed", async () => {
    const sent = await run([said("half an answer"), errored(QUOTA_429)]);

    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /half an answer/, "work already done is not thrown away");
    assert.match(sent[0].body, /Cut short/);
  });

  it("still posts nothing when the agent chose to stay quiet", async () => {
    const sent = await run([said(".")]);

    assert.deepEqual(sent, [], "deliberate silence must survive the change");
  });

  it("falls back to the raw error when it is not the provider's JSON", async () => {
    const sent = await run([errored("socket hang up")]);

    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /socket hang up/);
  });

  it("reports a failure carried only by pi's retry events", async () => {
    const sent = await run([
      { type: "auto_retry_start", attempt: 1, maxAttempts: 4, errorMessage: QUOTA_429 },
      { type: "auto_retry_end", success: false, attempt: 4, finalError: QUOTA_429 },
    ]);

    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /after 4 attempts/);
    assert.match(sent[0].body, /Token Plan quota reached/);
  });

  it("clears a retried failure when the retry reports success", async () => {
    const sent = await run([
      { type: "auto_retry_start", attempt: 1, maxAttempts: 4, errorMessage: QUOTA_429 },
      { type: "auto_retry_end", success: true, attempt: 2 },
      said("recovered"),
    ]);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].body, "recovered");
  });
});
