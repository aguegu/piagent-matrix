import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

describe("telling extensions where the agent directory is", () => {
  it("sets PI_CODING_AGENT_DIR from agentDir", () => {
    // pi's getAgentDir() reads this and otherwise answers ~/.pi/agent, so an
    // extension would use the operator's home while the session ran out of
    // ours. Passing agentDir to createAgentSession does not cover that call.
    const before = process.env.PI_CODING_AGENT_DIR;
    try {
      new AgentManager({ cwd: process.cwd(), agentDir: "./data/pi" });
      assert.equal(process.env.PI_CODING_AGENT_DIR, resolve("./data/pi"));
    } finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = before;
    }
  });

  it("leaves it alone when there is no agentDir to point at", () => {
    const before = process.env.PI_CODING_AGENT_DIR;
    try {
      delete process.env.PI_CODING_AGENT_DIR;
      new AgentManager({ cwd: process.cwd() });
      assert.equal(process.env.PI_CODING_AGENT_DIR, undefined, "pi's own default stands");
    } finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = before;
    }
  });
});

describe("reporting which extensions are running", () => {
  it("names a package from its install path", async () => {
    // pi reports a path when an extension declares no name of its own, and the
    // path is the whole install location.
    const { extensionName } = await import("../src/agent.js");
    assert.equal(
      extensionName({ path: "/srv/bot/data/pi/npm/node_modules/pi-web-access/index.ts" }),
      "pi-web-access",
    );
    assert.equal(
      extensionName({ path: "/srv/bot/data/pi/npm/node_modules/@smoose/pi-persona/extensions/index.ts" }),
      "@smoose/pi-persona",
      "scope included",
    );
    assert.equal(extensionName({ name: "declared" }), "declared", "its own name wins");
    assert.equal(extensionName({}), "?");
  });

  it("falls back to what settings.json configures, and says so", () => {
    // Configured is not loaded, and the difference is what goes wrong: two bots
    // agreed their skill lists matched while their tools did not.
    const dir = mkdtempSync(join(tmpdir(), "agentdir-"));
    dirs.push(dir);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      packages: ["npm:pi-web-access", "https://github.com/x/y@abc"],
    }));

    const mgr = new AgentManager({ cwd: process.cwd(), agentDir: dir });
    assert.deepEqual(mgr.describeExtensions(), {
      names: ["pi-web-access", "https://github.com/x/y@abc"],
      failed: [],
      live: false,
    });
  });

  it("reports what loaded once a session has been made", () => {
    const mgr = new AgentManager({ cwd: process.cwd() });
    mgr.extensions = { names: ["pi-web-access"], failed: ["broken-one"] };
    assert.deepEqual(mgr.describeExtensions(), {
      names: ["pi-web-access"], failed: ["broken-one"], live: true,
    });
  });

  it("says nothing rather than guessing with no agent dir", () => {
    assert.deepEqual(new AgentManager({ cwd: process.cwd() }).describeExtensions(),
      { names: [], failed: [], live: false });
  });
});
