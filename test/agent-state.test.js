import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AgentManager } from "../src/agent.js";

// The point of `.model` and `.thinking` is to replace PI_MODEL and
// PI_THINKING_LEVEL: a choice made in a room has to outlive the process, and
// has to win over the env on the next start. These tests pin that precedence.

const dirs = [];
function stateFile() {
  const dir = mkdtempSync(join(tmpdir(), "piagent-state-"));
  dirs.push(dir);
  return join(dir, "agent.json");
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A session whose thinking level we can watch being set. */
function makeFakeSession(level = "low") {
  return {
    thinkingLevel: level,
    setThinkingLevel(next) {
      this.thinkingLevel = next;
    },
    subscribe() {
      return () => {};
    },
    dispose() {},
  };
}

function makeManager(opts = {}) {
  const mgr = new AgentManager({ cwd: process.cwd(), createSession: async () => ({ session: makeFakeSession() }), ...opts });
  mgr.model = { provider: "fake", id: "fake-model" };
  return mgr;
}

describe("thinking level", () => {
  it("records the choice and applies it to live sessions", async () => {
    const file = stateFile();
    const session = makeFakeSession();
    const mgr = makeManager({ stateFile: file, thinkingLevel: "low" });
    mgr.sessions.set("!room:example.org", Promise.resolve(session));

    const result = await mgr.setThinkingLevel("high");

    assert.deepEqual(result, { ok: true, level: "high", applied: 1 });
    assert.equal(session.thinkingLevel, "high");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).thinkingLevel, "high");
  });

  it("wins over PI_THINKING_LEVEL on the next start", async () => {
    const file = stateFile();
    await makeManager({ stateFile: file, thinkingLevel: "low" }).setThinkingLevel("xhigh");

    // A fresh manager, as after a restart: the env default is still "low".
    const restarted = makeManager({ stateFile: file, thinkingLevel: "low" });
    const { current, live } = await restarted.describeThinking("!unseen:example.org");
    assert.equal(current, "xhigh");
    assert.equal(live, false, "a room never messaged has no session of its own");
  });

  it("refuses a level pi does not have, without recording it", async () => {
    const file = stateFile();
    const mgr = makeManager({ stateFile: file, thinkingLevel: "low" });

    const result = await mgr.setThinkingLevel("ludicrous");

    assert.equal(result.ok, false);
    assert.ok(result.levels.includes("medium"), "the reply should list what is on offer");
    assert.throws(() => readFileSync(file, "utf8"), "nothing recorded");
    assert.equal((await mgr.describeThinking("!r:example.org")).current, "low");
  });

  it("normalises case and surrounding space", async () => {
    const mgr = makeManager({ stateFile: stateFile() });
    assert.equal((await mgr.setThinkingLevel("  MAX ")).level, "max");
  });
});

describe("recorded state", () => {
  it("keeps the model and the thinking level side by side", async () => {
    const file = stateFile();
    writeFileSync(file, JSON.stringify({ model: "fake/fake-model" }));
    const mgr = makeManager({ stateFile: file });

    await mgr.setThinkingLevel("medium");

    // Setting one must not drop the other — they share a file.
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      model: "fake/fake-model",
      thinkingLevel: "medium",
    });
  });

  it("falls back to the env default when the file is unreadable", async () => {
    const file = stateFile();
    writeFileSync(file, "{ not json");
    const mgr = makeManager({ stateFile: file, thinkingLevel: "minimal" });
    assert.equal((await mgr.describeThinking("!r:example.org")).current, "minimal");
  });
});
