import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchSpool } from "../src/spool.js";

/**
 * The spool used to hold one lock across an awaited handler, so a handler that
 * waits — the inbox awaits an entire agent run — stopped every other file being
 * claimed, whichever room it was for. A scheduled tick for one room sat unread
 * behind a conversation in another.
 */

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** A promise you resolve by hand, to hold a handler open. */
function gate() {
  let open;
  const p = new Promise((r) => { open = r; });
  return { p, open };
}

describe("spool concurrency", () => {
  let dir;
  let stop;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "spool-")); });
  afterEach(() => { stop?.(); rmSync(dir, { recursive: true, force: true }); });

  /** Writers rename in; writing in place risks the bot reading half a file. */
  const drop = (name, contents = "x") => {
    const tmp = join(dir, `.${name}`);
    writeFileSync(tmp, contents);
    renameSync(tmp, join(dir, name));
  };

  it("does not let one slow file block the next", async () => {
    const started = [];
    const held = gate();
    stop = watchSpool({
      dir,
      label: "test",
      pollMs: 20,
      concurrency: 4,
      async handle(name) {
        started.push(name);
        if (name === "1-slow.json") await held.p;
        return `ran ${name}`;
      },
    });

    drop("1-slow.json");
    drop("2-quick.json");
    await settle();

    assert.deepEqual(started, ["1-slow.json", "2-quick.json"], "both must have started");
    assert.ok(!existsSync(join(dir, "2-quick.json")), "the quick one finished and was dropped");
    assert.ok(existsSync(join(dir, "1-slow.json.working")), "the slow one is still claimed");

    held.open();
    await settle();
    assert.ok(!existsSync(join(dir, "1-slow.json.working")), "and finishes on its own");
  });

  it("claims in name order even when handlers overlap", async () => {
    const started = [];
    const held = gate();
    stop = watchSpool({
      dir,
      label: "test",
      pollMs: 20,
      concurrency: 4,
      async handle(name) { started.push(name); await held.p; return name; },
    });

    for (const n of ["3-c.json", "1-a.json", "2-b.json"]) drop(n);
    await settle();
    held.open();

    assert.deepEqual(started, ["1-a.json", "2-b.json", "3-c.json"], "a timestamp prefix still means order");
  });

  it("picks up a file that lands while a handler is running", async () => {
    const started = [];
    const held = gate();
    stop = watchSpool({
      dir,
      label: "test",
      pollMs: 5_000, // long: the rescan must come from the finishing handler
      concurrency: 1,
      async handle(name) { started.push(name); if (name === "1-slow.json") await held.p; return name; },
    });

    drop("1-slow.json");
    await settle();
    assert.deepEqual(started, ["1-slow.json"]);

    drop("2-late.json"); // arrives after the listing that claimed the first
    await settle();
    held.open();
    await settle();

    assert.deepEqual(started, ["1-slow.json", "2-late.json"], "the finishing handler rescans");
  });

  it("runs no more at once than it is allowed", async () => {
    let now = 0;
    let peak = 0;
    const held = gate();
    stop = watchSpool({
      dir,
      label: "test",
      pollMs: 20,
      concurrency: 2,
      async handle() {
        now += 1;
        peak = Math.max(peak, now);
        await held.p;
        now -= 1;
        return "ok";
      },
    });

    for (let i = 1; i <= 6; i++) drop(`${i}.json`);
    await settle();

    assert.equal(peak, 2, "the cap is a cap");
    held.open();
    await settle();
  });

  it("keeps a serial spool finishing in name order", async () => {
    // What the outbox needs: two messages posted out of order is a visible
    // fault, so concurrency 1 waits for each before claiming the next.
    const finished = [];
    stop = watchSpool({
      dir,
      label: "test",
      pollMs: 20,
      concurrency: 1,
      async handle(name) {
        await settle(name === "1-first.json" ? 40 : 1); // the first is the slow one
        finished.push(name);
        return name;
      },
    });

    drop("1-first.json");
    drop("2-second.json");
    await settle(200);

    assert.deepEqual(finished, ["1-first.json", "2-second.json"]);
  });

  it("still parks a failure without taking the spool down", async () => {
    const done = [];
    stop = watchSpool({
      dir,
      label: "test",
      pollMs: 20,
      concurrency: 4,
      async handle(name) {
        if (name === "1-bad.json") throw new Error("nope");
        done.push(name);
        return name;
      },
    });

    drop("1-bad.json");
    drop("2-good.json");
    await settle();

    assert.ok(existsSync(join(dir, "1-bad.json.failed")), "the bad one is parked for inspection");
    assert.deepEqual(done, ["2-good.json"], "and the other one still ran");
  });
});
