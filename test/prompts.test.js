import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fillTemplate, installPrompts, SHIPPED_PROMPTS } from "../src/prompts.js";

describe("filling a template", () => {
  it("substitutes what it knows", () => {
    assert.equal(fillTemplate("state is in {{DATA_DIR}}.", { DATA_DIR: "/srv/bot/data" }),
      "state is in /srv/bot/data.");
  });

  it("leaves an unknown name alone rather than blanking it", () => {
    // A silently emptied path reads as a working instruction pointing nowhere.
    assert.equal(fillTemplate("{{NOPE}} and {{DATA_DIR}}", { DATA_DIR: "/d" }), "{{NOPE}} and /d");
  });

  it("substitutes every occurrence", () => {
    assert.equal(fillTemplate("{{A}}/x {{A}}/y", { A: "/p" }), "/p/x /p/y");
  });
});

describe("installing the shipped templates", () => {
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

  const target = (name) => join(agentDir, "prompts", `${name}.md`);

  it("writes them with this host's paths filled in", () => {
    writeFileSync(join(from, "whoami.md"), "read {{DATA_DIR}}/main-room.json");

    const r = installPrompts(agentDir, { DATA_DIR: "/srv/bot/data" }, from);

    assert.deepEqual(r.written, ["whoami"]);
    assert.equal(readFileSync(target("whoami"), "utf8"), "read /srv/bot/data/main-room.json");
  });

  it("does not rewrite one that already matches", () => {
    // Every restart installs; only a change should show up in the log.
    writeFileSync(join(from, "a.md"), "same");
    installPrompts(agentDir, {}, from);
    const again = installPrompts(agentDir, {}, from);
    assert.deepEqual(again, { written: [], skipped: ["a"] });
  });

  it("overwrites an edited copy, since the repo is the source", () => {
    writeFileSync(join(from, "a.md"), "shipped");
    installPrompts(agentDir, {}, from);
    writeFileSync(target("a"), "hand-edited on this host");

    assert.deepEqual(installPrompts(agentDir, {}, from).written, ["a"]);
    assert.equal(readFileSync(target("a"), "utf8"), "shipped");
  });

  it("leaves a template the repo does not ship", () => {
    // A deployment's own prompts — verify.md on these hosts — are not the
    // bot's to manage, and installing must never touch them.
    mkdirSync(join(agentDir, "prompts"), { recursive: true });
    writeFileSync(target("verify"), "this host's own");
    writeFileSync(join(from, "a.md"), "shipped");

    installPrompts(agentDir, {}, from);

    assert.equal(readFileSync(target("verify"), "utf8"), "this host's own");
  });

  it("ignores anything that is not a .md", () => {
    writeFileSync(join(from, "notes.txt"), "not a template");
    assert.deepEqual(installPrompts(agentDir, {}, from).written, []);
  });

  it("warns rather than throwing when there is nothing to install from", () => {
    // A bot that cannot install a prompt still answers messages.
    assert.deepEqual(installPrompts(agentDir, {}, join(from, "missing")), { written: [], skipped: [] });
  });

  it("ships whoami, and only what belongs to every deployment", () => {
    // .whoami describes the bot itself, so it has to be true everywhere.
    // verify.md is a deployment's own working style and stays out of the repo.
    assert.ok(existsSync(join(SHIPPED_PROMPTS, "whoami.md")), "prompts/whoami.md should exist");
    assert.equal(existsSync(join(SHIPPED_PROMPTS, "verify.md")), false, "verify is not global");
  });
});
