import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fillTemplate, installAgentResources, MANAGED, PARTS, renderPart, SHIPPED } from "../src/resources.js";

describe("filling a template", () => {
  it("substitutes what it knows", () => {
    assert.equal(fillTemplate("read {{DATA_DIR}}/x", { DATA_DIR: "/srv/bot/data" }),
      "read /srv/bot/data/x");
  });

  it("leaves an unknown name alone rather than blanking it", () => {
    // A silently emptied path reads as a working instruction pointing nowhere.
    assert.equal(fillTemplate("{{NOPE}} and {{DATA_DIR}}", { DATA_DIR: "/d" }), "{{NOPE}} and /d");
  });

  it("substitutes every occurrence", () => {
    assert.equal(fillTemplate("{{A}}/x {{A}}/y", { A: "/p" }), "/p/x /p/y");
  });
});

describe("installing the bot's standing instructions", () => {
  let from;
  let agentDir;
  beforeEach(() => {
    from = mkdtempSync(join(tmpdir(), "shipped-"));
    agentDir = mkdtempSync(join(tmpdir(), "agentdir-"));
  });
  afterEach(() => {
    rmSync(from, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  const target = () => join(agentDir, "AGENTS.md");
  const ship = (body) => writeFileSync(join(from, "AGENTS.md"), body);

  it("writes it with this host's paths filled in, and marks it as managed", () => {
    ship("read {{DATA_DIR}}/main-room.json");

    const r = installAgentResources(agentDir, { DATA_DIR: "/srv/bot/data" }, from);

    assert.deepEqual(r.written, ["AGENTS.md"]);
    const written = readFileSync(target(), "utf8");
    assert.ok(written.startsWith(MANAGED), "the marker is what makes it ours to rewrite");
    assert.match(written, /read \/srv\/bot\/data\/main-room\.json/);
  });

  it("does not rewrite one that already matches", () => {
    // Every restart installs; only a change should show up in the log.
    ship("same");
    installAgentResources(agentDir, {}, from);
    assert.deepEqual(installAgentResources(agentDir, {}, from),
      { written: [], skipped: ["AGENTS.md"], kept: [], unresolved: [] });
  });

  it("overwrites its own copy, since the repo is the source", () => {
    ship("shipped");
    installAgentResources(agentDir, {}, from);
    writeFileSync(target(), `${MANAGED}\n\nhand-edited on this host`);

    assert.deepEqual(installAgentResources(agentDir, {}, from).written, ["AGENTS.md"]);
    assert.match(readFileSync(target(), "utf8"), /shipped/);
  });

  it("refuses to touch an AGENTS.md it did not write", () => {
    // The same file is the natural home for an operator's own standing
    // instructions, and overwriting those would be theft.
    writeFileSync(target(), "# my own instructions");
    ship("shipped");

    const r = installAgentResources(agentDir, {}, from);

    assert.deepEqual(r, { written: [], skipped: [], kept: ["AGENTS.md"], unresolved: [] });
    assert.equal(readFileSync(target(), "utf8"), "# my own instructions");
  });

  it("ignores anything that is not a .md", () => {
    writeFileSync(join(from, "notes.txt"), "not instructions");
    assert.deepEqual(installAgentResources(agentDir, {}, from).written, []);
  });

  it("warns rather than throwing when there is nothing to install from", () => {
    // A bot that cannot write its context file still answers messages.
    assert.deepEqual(installAgentResources(agentDir, {}, join(from, "missing")),
      { written: [], skipped: [], kept: [], unresolved: [] });
  });

  it("reports a placeholder nothing supplies, rather than shipping it quietly", () => {
    // Left in rather than blanked — an empty path reads as a real instruction
    // — but the agent would otherwise be told to look in "{{DATA_DIR}}".
    ship("read {{DATA_DIR}}/x and {{NOPE}}/y");

    const r = installAgentResources(agentDir, { DATA_DIR: "/d" }, from);

    assert.deepEqual(r.unresolved, ["NOPE"]);
    assert.match(readFileSync(target(), "utf8"), /\{\{NOPE\}\}/, "and it is still visible in the file");
  });

  it("ships an AGENTS.md whose placeholders are all supplied at startup", () => {
    // Guards the pairing between agent/*.md and the values index.js passes.
    const shipped = readFileSync(join(SHIPPED, "AGENTS.md"), "utf8");
    const used = [...new Set([...shipped.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();
    // Sorted, so the two section placeholders land where the alphabet puts
    // them rather than where they read.
    assert.deepEqual(used, [
      "BOT_CWD", "BOT_NAME", "DATA_DIR", "INBOX_DIR", "MATRIX_USER_ID", "OUTBOX_DIR",
      // Whole sections rather than paths, each empty where it does not apply:
      // see schedulingSection and sandboxSection in index.js.
      "SCHEDULING", "WHERE_YOU_ARE",
    ]);
  });

  it("ships an AGENTS.md that tells the agent where its record is", () => {
    const shipped = readFileSync(join(SHIPPED, "AGENTS.md"), "utf8");
    assert.match(shipped, /\{\{DATA_DIR\}\}\/main-room\.json/, "asked to read the record, not told");
    assert.doesNotMatch(shipped, /token\.json`[^)]*read/, "and warned off the credentials beside it");
  });
});

describe("what the agent is told about scheduling", () => {
  // The agent cannot discover this: in a container there is no cron daemon
  // and no `crontab`. Asked to schedule something it tried `at`, then
  // `crontab`, then settled for `nohup sleep 300` and reported success.
  const render = (vars) => fillTemplate("before\n{{SCHEDULING}}after\n", vars);

  it("says nothing where a real cron exists", () => {
    assert.equal(render({ SCHEDULING: "" }), "before\nafter\n");
  });

  it("names the file, and that saving is enough", () => {
    const out = render({ SCHEDULING: "The schedule is `/data/crontab`. Save it.\n" });
    assert.match(out, /\/data\/crontab/);
    assert.match(out, /Save it/);
  });

  it("leaves an unknown placeholder alone rather than blanking it", () => {
    // A var nobody supplies must stay visible, so a missing one is noticed
    // rather than silently producing an instruction with a hole in it.
    assert.match(fillTemplate("x {{NOT_SUPPLIED}} y", {}), /\{\{NOT_SUPPLIED\}\}/);
  });
});

describe("optional sections of AGENTS.md", () => {
  // Prose belongs in markdown. The scheduling section used to be 36 lines of
  // strings in a JS array with escaped backticks, which is a poor place to
  // edit an instruction that has already been rewritten twice.

  it("fills a part's own placeholders, which the main pass cannot", () => {
    // fillTemplate is a single replace, so a {{...}} arriving inside a
    // substituted value would reach the agent as written.
    const out = renderPart("scheduling-crontab", {
      CRONTAB_FILE: "/data/crontab",
      CRON_LOG: "/data/cron.log",
      CRON_ALIVE: "/data/cron-alive",
      INBOX_DIR: "/data/inbox",
      OUTBOX_DIR: "/data/outbox",
    });
    assert.doesNotMatch(out, /\{\{/, "no placeholder survives into the agent's copy");
    for (const v of ["/data/crontab", "/data/cron-alive", "/data/cron.log", "/data/inbox"]) {
      assert.ok(out.includes(v), `${v} is named`);
    }
  });

  it("supplies every placeholder each shipped part uses", () => {
    // The same guard AGENTS.md has, for the parts beside it.
    const supplied = ["CRONTAB_FILE", "CRON_LOG", "CRON_ALIVE", "INBOX_DIR", "OUTBOX_DIR",
                      "DATA_DIR", "SESSION_DIR", "BOT_CWD"];
    for (const file of readdirSync(PARTS).filter((n) => n.endsWith(".md"))) {
      const text = readFileSync(join(PARTS, file), "utf8");
      for (const [, name] of text.matchAll(/\{\{(\w+)\}\}/g)) {
        assert.ok(supplied.includes(name), `${file} uses {{${name}}}, which nothing supplies`);
      }
    }
  });

  it("does not install the parts directory as a context file", () => {
    // pi reads one context file per directory; a stray parts/ copied into
    // PI_AGENT_DIR would be clutter at best.
    assert.ok(!readdirSync(SHIPPED).includes("parts.md"));
    assert.ok(readdirSync(SHIPPED).includes("parts"), "parts is a directory beside the shipped files");
  });
});
