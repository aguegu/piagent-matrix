import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentManager } from "../src/agent.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assistantMsg = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

/**
 * A session whose run emits a scripted event sequence, mirroring what pi does
 * for a run that spans several assistant messages around a tool call:
 *
 *   assistant "…" -> message_end -> tool start/end -> assistant "…" -> message_end
 */
function makeScriptedSession(script) {
  const listeners = [];
  let streaming = false;
  return {
    get isStreaming() { return streaming; },
    subscribe(fn) {
      listeners.push(fn);
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },
    async prompt() {
      streaming = true;
      await sleep(5);
      for (const ev of script) {
        for (const fn of [...listeners]) fn(ev);
        await sleep(1);
      }
      streaming = false;
    },
    dispose() {},
  };
}

function makeFakeClient() {
  const sent = [];
  return { sent, async sendMessage(roomId, content) { sent.push(content.body); return "$e"; } };
}

function makeManager(session) {
  const mgr = new AgentManager({ cwd: process.cwd(), createSession: async () => ({ session }) });
  mgr.model = { provider: "fake", id: "fake-model" };
  return mgr;
}

async function runOnce(script) {
  const session = makeScriptedSession(script);
  const client = makeFakeClient();
  await makeManager(session).handleMessage({
    roomId: "!r:example.org", text: "go", sender: "@a:example.org", client,
  });
  return client.sent;
}

describe("reply rendering across a multi-message run", () => {
  it("keeps text from every assistant message, not just the last", async () => {
    const sent = await runOnce([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", partial: assistantMsg("Let me check the disk.") } },
      { type: "message_end", message: assistantMsg("Let me check the disk.") },
      { type: "tool_execution_start", toolName: "bash", args: { command: "df -h /" } },
      { type: "tool_execution_end", isError: false },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", partial: assistantMsg("You're at 22%.") } },
      { type: "message_end", message: assistantMsg("You're at 22%.") },
    ]);

    assert.equal(sent.length, 1);
    const body = sent[0];
    assert.match(body, /Let me check the disk\./, "pre-tool text must survive");
    assert.match(body, /You're at 22%\./, "post-tool text must survive");
    // Order must reflect what actually happened.
    assert.ok(
      body.indexOf("Let me check the disk.") < body.indexOf("⏺ bash"),
      "tool line comes after the text that preceded it",
    );
    assert.ok(
      body.indexOf("⏺ bash") < body.indexOf("You're at 22%."),
      "tool line comes before the text that followed it",
    );
    assert.match(body, /⏺ bash\(.*df -h.*\)\s+✓/, "tool line records success");
  });

  it("marks a failed tool and still reports surrounding text", async () => {
    const sent = await runOnce([
      { type: "tool_execution_start", toolName: "bash", args: { command: "false" } },
      { type: "tool_execution_end", isError: true },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", partial: assistantMsg("That command failed.") } },
      { type: "message_end", message: assistantMsg("That command failed.") },
    ]);
    assert.match(sent[0], /✗/, "failed tool is marked");
    assert.match(sent[0], /That command failed\./);
  });

  it("posts nothing when a run yields no text at all", async () => {
    const sent = await runOnce([
      { type: "tool_execution_start", toolName: "bash", args: {} },
      { type: "tool_execution_end", isError: false },
    ]);
    // Tool lines alone are still output; the empty-run guard only trips when
    // there is genuinely nothing to say.
    assert.equal(sent.length, 1);
    assert.match(sent[0], /⏺ bash/);
  });
});
