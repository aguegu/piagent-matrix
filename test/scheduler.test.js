import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LogService, RichConsoleLogger } from "matrix-bot-sdk";
import { jobEnvironment, startScheduler } from "../src/scheduler.js";

// The scheduler is a child process, so these use a stand-in for supercronic
// rather than the real one: the point is the supervision around it — that it
// is started with the right arguments, restarted when it dies, stopped when
// asked, and handed an environment with the bot's secrets taken out.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for a condition rather than for a duration, so a slow box is fine. */
async function until(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return false;
}

describe("running the scheduler as a child", () => {
  let dir, crontab, fake, marks;

  /** Records each launch, then behaves as told: linger, or exit at once. */
  function fakeCron(body) {
    const path = join(dir, "fake-cron");
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${marks}\n${body}\n`, { mode: 0o755 });
    return path;
  }
  const launches = () => (existsSync(marks) ? readFileSync(marks, "utf8").trim().split("\n") : []);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sched-"));
    crontab = join(dir, "crontab");
    marks = join(dir, "launches");
    // Quiet: the module logs deliberately, and a restart test would print it
    // five times over.
    LogService.setLogger({ info() {}, warn() {}, error() {}, debug() {}, trace() {} });
  });
  afterEach(() => {
    LogService.setLogger(new RichConsoleLogger());
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing at all without a crontab, which is the host", () => {
    assert.equal(startScheduler({}), null);
    assert.equal(startScheduler({ crontabFile: "" }), null);
  });

  it("seeds a crontab so the file is never missing, and never a second time", async () => {
    fake = fakeCron("while :; do sleep 0.05; done");
    const first = startScheduler({ crontabFile: crontab, binary: fake });
    try {
      assert.ok(existsSync(crontab), "a deployment starts with a file to edit");
      assert.match(readFileSync(crontab, "utf8"), /^#/, "and it explains itself");
      writeFileSync(crontab, "* * * * * echo mine\n");
    } finally {
      await first.stop();
    }

    const second = startScheduler({ crontabFile: crontab, binary: fake });
    try {
      assert.equal(readFileSync(crontab, "utf8"), "* * * * * echo mine\n", "an existing schedule survives a restart");
    } finally {
      await second.stop();
    }
  });

  it("watches the crontab it was given", async () => {
    fake = fakeCron("while :; do sleep 0.05; done");
    const s = startScheduler({ crontabFile: crontab, binary: fake });
    try {
      assert.ok(await until(() => launches().length === 1), "it starts");
      assert.equal(launches()[0], `-inotify ${crontab}`, "reloading on edit is the whole point");
      assert.ok(s.running);
      assert.ok(s.pid > 0);
    } finally {
      await s.stop();
    }
  });

  it("restarts a scheduler that dies, because nothing else would", async () => {
    fake = fakeCron("exit 1");
    const s = startScheduler({ crontabFile: crontab, binary: fake, restartDelayMs: 30 });
    try {
      assert.ok(await until(() => launches().length >= 3), `restarted only ${launches().length} times`);
    } finally {
      await s.stop();
    }
  });

  it("gives up on a crash loop rather than spinning forever", async () => {
    fake = fakeCron("exit 1");
    const s = startScheduler({ crontabFile: crontab, binary: fake, restartDelayMs: 10 });
    try {
      // Five failures inside the flap window is the limit; wait past where a
      // sixth would have appeared.
      await until(() => launches().length >= 5);
      const settled = launches().length;
      await sleep(200);
      assert.equal(launches().length, settled, "it stopped trying, and said so in the log");
      assert.ok(settled <= 6, `tried ${settled} times before giving up`);
    } finally {
      await s.stop();
    }
  });

  it("stops when the bot does, and stays stopped", async () => {
    fake = fakeCron("trap 'exit 0' TERM\nwhile :; do sleep 0.05; done");
    const s = startScheduler({ crontabFile: crontab, binary: fake, restartDelayMs: 10 });
    assert.ok(await until(() => launches().length === 1));

    await s.stop();
    assert.equal(s.running, false, "shutdown waits for it rather than orphaning it");
    await sleep(200);
    assert.equal(launches().length, 1, "a deliberate stop is not a death to recover from");
  });

  it("kills a scheduler that ignores SIGTERM instead of hanging shutdown", async () => {
    fake = fakeCron("trap '' TERM\nwhile :; do sleep 0.05; done");
    const s = startScheduler({ crontabFile: crontab, binary: fake, killGraceMs: 100 });
    assert.ok(await until(() => launches().length === 1));

    const began = Date.now();
    await s.stop();
    assert.ok(Date.now() - began < 3_000, "shutdown is not held open by a deaf child");
    assert.equal(s.running, false);
  });
});

describe("what a scheduled job is allowed to see", () => {
  // supercronic deliberately does not purge the environment before running a
  // job — verified against the real binary, where a variable set on the
  // container reached the job unchanged. As a child of the bot, that makes
  // the bot's whole environment the job's, so the child's is built rather
  // than filtered.

  it("passes only what a job needs to work", () => {
    const env = jobEnvironment({
      PATH: "/usr/bin", HOME: "/home/node", TZ: "Asia/Shanghai",
      DATA_DIR: "/data", INBOX_DIR: "/data/inbox", PI_CODING_AGENT_DIR: "/data/pi",
    });
    assert.deepEqual(env, {
      PATH: "/usr/bin", HOME: "/home/node", TZ: "Asia/Shanghai",
      DATA_DIR: "/data", INBOX_DIR: "/data/inbox", PI_CODING_AGENT_DIR: "/data/pi",
    });
  });

  it("drops everything it was not asked to pass, secret or not", () => {
    const env = jobEnvironment({
      PATH: "/usr/bin",
      MATRIX_PASSWORD: "hunter2",
      MATRIX_RECOVERY_KEY: "EsUB abcd",
      MATRIX_USER_ID: "@b:example.org",
      // The point of an allowlist: something nobody thought about is out by
      // default rather than in until someone remembers to exclude it.
      SOME_PROVIDER_API_KEY: "sk-live-whatever",
    });
    assert.deepEqual(Object.keys(env), ["PATH"]);
  });

  it("always has a PATH, since execvp resolves the binary against it", () => {
    assert.match(jobEnvironment({}).PATH, /\/usr\/bin/);
  });

  it("does not disturb the bot's own environment", () => {
    const before = process.env.MATRIX_PASSWORD;
    jobEnvironment();
    assert.equal(process.env.MATRIX_PASSWORD, before, "the bot still has to log in");
  });
});
