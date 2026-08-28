import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fillTemplate, installAgentResources, MANAGED, SHIPPED } from "../src/resources.js";

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
      { written: [], skipped: ["AGENTS.md"], kept: [] });
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

    assert.deepEqual(r, { written: [], skipped: [], kept: ["AGENTS.md"] });
    assert.equal(readFileSync(target(), "utf8"), "# my own instructions");
  });

  it("ignores anything that is not a .md", () => {
    writeFileSync(join(from, "notes.txt"), "not instructions");
    assert.deepEqual(installAgentResources(agentDir, {}, from).written, []);
  });

  it("warns rather than throwing when there is nothing to install from", () => {
    // A bot that cannot write its context file still answers messages.
    assert.deepEqual(installAgentResources(agentDir, {}, join(from, "missing")),
      { written: [], skipped: [], kept: [] });
  });

  it("ships an AGENTS.md that tells the agent where its record is", () => {
    const shipped = readFileSync(join(SHIPPED, "AGENTS.md"), "utf8");
    assert.match(shipped, /\{\{DATA_DIR\}\}\/main-room\.json/, "asked to read the record, not told");
    assert.doesNotMatch(shipped, /token\.json`[^)]*read/, "and warned off the credentials beside it");
  });
});
