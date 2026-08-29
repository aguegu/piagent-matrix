import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describeBuild, describeStart, readCommit, readVersion } from "../src/version.js";

describe("naming the build", () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "build-"));
    mkdirSync(join(root, ".git"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const pkg = (version) => writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  const SHA = "39bbb2512a4c0d9f1e77aa30bb5c4e881f0a2d63";

  it("reads a commit through a branch ref", () => {
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "refs", "heads", "main"), `${SHA}\n`);
    assert.equal(readCommit(root), "39bbb25");
  });

  it("reads a detached HEAD", () => {
    writeFileSync(join(root, ".git", "HEAD"), `${SHA}\n`);
    assert.equal(readCommit(root), "39bbb25");
  });

  it("falls back to packed-refs when the branch has no file", () => {
    // git gc packs refs away; the loose file simply stops existing.
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "packed-refs"), `# pack-refs with: peeled\n${SHA} refs/heads/main\n`);
    assert.equal(readCommit(root), "39bbb25");
  });

  it("follows a .git file to the real gitdir", () => {
    // A worktree or submodule has .git as a file: `gitdir: <elsewhere>`.
    // Treating it as a directory reported nothing for a real checkout.
    const real = join(root, "elsewhere");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "HEAD"), `${SHA}\n`);
    rmSync(join(root, ".git"), { recursive: true, force: true });
    writeFileSync(join(root, ".git"), `gitdir: ${real}\n`);

    assert.equal(readCommit(root), "39bbb25");
  });

  it("reports no commit outside a checkout", () => {
    // A tarball or an image built by copying has none, which is honest.
    rmSync(join(root, ".git"), { recursive: true, force: true });
    assert.equal(readCommit(root), "");
  });

  it("names version and commit together", () => {
    pkg("0.2.2");
    writeFileSync(join(root, ".git", "HEAD"), `${SHA}\n`);
    assert.equal(describeBuild(root), "piagent-matrix 0.2.2 (39bbb25)");
  });

  it("degrades to whichever half it has", () => {
    // The version alone is what a deployment without .git can say; the name
    // alone is what one with neither can.
    pkg("0.2.2");
    assert.equal(describeBuild(root), "piagent-matrix 0.2.2");
    rmSync(join(root, "package.json"));
    assert.equal(readVersion(root), "");
    assert.equal(describeBuild(root), "piagent-matrix");
  });
});

describe("saying how long it has been up", () => {
  const at = (iso, uptime) => describeStart(Date.parse(iso), uptime);

  it("gives the moment it started, derived from uptime", () => {
    // From process.uptime(), not a timestamp taken at import, so it is the
    // process that is being described rather than the module.
    assert.match(at("2026-08-29T12:47:07Z", 8047), /^2026-08-29 10:33:00Z/);
  });

  it("reports elapsed time to the coarsest useful pair", () => {
    assert.match(at("2026-08-29T12:47:07Z", 8047), /\(up 2h 14m\)$/);
    assert.match(at("2026-08-29T12:47:07Z", 3 * 86400 + 7200), /\(up 3d 2h\)$/);
    assert.match(at("2026-08-29T12:47:07Z", 900), /\(up 15m\)$/);
    assert.match(at("2026-08-29T12:47:07Z", 40), /\(up 40s\)$/);
  });

  it("moves, unlike the build", async () => {
    // The value is that it changes; it must not be frozen at import.
    const first = describeStart(Date.now(), 10);
    const later = describeStart(Date.now(), 20);
    assert.notEqual(first, later);
  });
});
