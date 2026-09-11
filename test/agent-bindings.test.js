import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentManager } from "../src/agent.js";

/**
 * Extensions must be bound, not merely loaded.
 *
 * pi emits `session_start` from `AgentSession.bindExtensions`, and an
 * extension that does its work on that event does nothing at all until
 * something binds. This bot had no UI to bind with, so it never called it,
 * and the failure was invisible for two releases: extensions reported as
 * loaded, `.info` listed them, and anything that only registered tools worked
 * fine.
 *
 * pi-mcp-adapter is what made it visible. It initialises MCP solely in its
 * session_start handler, so its tools registered from the metadata cache and
 * every call came back "MCP not initialized" — with the tools *present*, which
 * is what made it look like a configuration problem rather than a missing
 * call. `.reload` could not repair it either: pi re-emits session_start on
 * reload only when bindings already exist.
 *
 * The call is optional-chained so test doubles need not implement it, which
 * is exactly why it needs a test of its own.
 */

const ROOM = "!room:example.org";

function makeSession(extra = {}) {
  const listeners = [];
  return {
    isStreaming: false,
    subscribe(fn) {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
    async prompt() {
      for (const fn of [...listeners]) {
        fn({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            partial: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          },
        });
      }
    },
    dispose() {},
    ...extra,
  };
}

/** Drives a real message through, which is what creates the session. */
async function runOnce(session) {
  const mgr = new AgentManager({
    cwd: process.cwd(),
    createSession: async () => ({ session }),
  });
  // Skip ModelRuntime.create(), which would touch real auth/model config.
  mgr.model = { provider: "fake", id: "fake-model" };
  mgr.briefed.add(ROOM);
  const client = { async sendMessage() { return "$evt"; } };
  await mgr.handleMessage({ roomId: ROOM, text: "hello", sender: "@a:example.org", client });
  return mgr;
}

describe("binding extensions to a new session", () => {
  it("binds, so session_start fires and an extension can start", async () => {
    const calls = [];
    await runOnce(makeSession({ async bindExtensions(b) { calls.push(b); } }));

    assert.equal(calls.length, 1, "every session is bound exactly once");
  });

  it("binds headlessly: an error listener, and no UI context", async () => {
    const calls = [];
    await runOnce(makeSession({ async bindExtensions(b) { calls.push(b); } }));
    const [bindings] = calls;

    // The adapter checks ctx.hasUI before showing dialogs and notifications.
    // There is no terminal here, so claiming one would route output nowhere.
    assert.equal(bindings.uiContext, undefined, "a Matrix room is not a TUI");
    assert.equal(typeof bindings.onError, "function", "extension errors must reach the log");
  });

  it("survives a session that does not implement it", async () => {
    // Older pi, or a double. The bot must still answer.
    const sent = [];
    const session = makeSession();
    const mgr = new AgentManager({ cwd: process.cwd(), createSession: async () => ({ session }) });
    mgr.model = { provider: "fake", id: "fake-model" };
    mgr.briefed.add(ROOM);
    await mgr.handleMessage({
      roomId: ROOM, text: "hello", sender: "@a:example.org",
      client: { async sendMessage(r, c) { sent.push(c); return "$evt"; } },
    });
    assert.ok(mgr.sessions.has(ROOM), "the session was still created");
  });
});
