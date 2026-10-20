import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * The readiness check, run as the thing it is.
 *
 * It exists to be read by something that is not a person — an agent asked to
 * deploy this bot needs a verification step it can branch on, not a startup
 * log to interpret. So the two properties that matter are the exit code and
 * the shape of `--json`, and both are asserted here by running the script
 * rather than by importing anything out of it.
 *
 * Nothing here reaches a homeserver: `MATRIX_HOMESERVER` is a name that
 * cannot resolve, so the cross-signing check degrades to a warning, which is
 * itself worth covering — an unreachable server must not read as "not
 * cross-signed".
 */

const execFileAsync = promisify(execFile);
const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DOCTOR = join(REPO, "scripts", "doctor.js");

/** A deployment directory, as complete as the arguments ask for. */
function makeDeployment({ token = true, auth = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  const data = join(dir, "data");
  for (const d of [data, join(data, "inbox"), join(data, "outbox"), join(data, "pi")]) {
    mkdirSync(d, { recursive: true });
  }
  if (token) {
    writeFileSync(join(data, "token.json"),
      JSON.stringify({ accessToken: "not-a-token", deviceId: "DOCTOR0000", userId: "@doc:invalid.example" }));
  }
  // `{}` is pi's "created but never configured" state, so an empty object is
  // the honest way to express "no provider" — not an absent file.
  writeFileSync(join(data, "pi", "auth.json"), auth ? JSON.stringify({ fakeprovider: { apiKey: "x" } }) : "{}");
  return { dir, data };
}

function env(data, extra = {}) {
  return {
    ...process.env,
    DATA_DIR: data,
    INBOX_DIR: join(data, "inbox"),
    OUTBOX_DIR: join(data, "outbox"),
    PI_AGENT_DIR: join(data, "pi"),
    BOT_CWD: data,
    CRONTAB_FILE: "",
    MATRIX_HOMESERVER: "https://doctor.invalid",
    MATRIX_USER_ID: "@doc:invalid.example",
    MATRIX_PASSWORD: "",
    MATRIX_RECOVERY_KEY: "",
    MATRIX_ALLOWED_USERS: "@you:invalid.example",
    ...extra,
  };
}

/** Runs it and returns the parsed report, whatever the exit code. */
async function run(data, extra) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [DOCTOR, "--json"], { env: env(data, extra) });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.code, report: JSON.parse(err.stdout) };
  }
}

const statusOf = (report, name) => report.checks.find((c) => c.name === name)?.status;

describe("the readiness check", () => {
  it("reports ready, and exits 0, when a deployment is complete", async () => {
    const { dir, data } = makeDeployment();
    try {
      const { code, report } = await run(data);
      assert.equal(report.ready, true, JSON.stringify(report.checks.filter((c) => c.status === "fail")));
      assert.equal(code, 0, "a caller must be able to branch on the exit code alone");
      assert.equal(report.failed, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails, and exits non-zero, when no model provider is configured", async () => {
    const { dir, data } = makeDeployment({ auth: false });
    try {
      const { code, report } = await run(data);
      assert.equal(report.ready, false);
      assert.equal(code, 1);
      assert.equal(statusOf(report, "model provider"), "fail");
      const check = report.checks.find((c) => c.name === "model provider");
      assert.match(check.fix, /login|API key/, "a failure has to say what to do about it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns rather than fails on an empty allowlist", async () => {
    // The bot starts and works; it just lets anyone who reaches it run shell
    // commands. Failing here would block a deployment that is merely unsafe,
    // and the distinction is the point of having two levels.
    const { dir, data } = makeDeployment();
    try {
      const { code, report } = await run(data, { MATRIX_ALLOWED_USERS: "" });
      assert.equal(statusOf(report, "allowlist"), "warn");
      assert.equal(report.ready, true);
      assert.equal(code, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mistake an unreachable homeserver for an unsigned device", async () => {
    const { dir, data } = makeDeployment();
    try {
      const { report } = await run(data);
      assert.equal(statusOf(report, "cross-signing"), "warn",
        "not knowing is a warning; claiming the device is unsigned would be a lie");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to call a lock stale when it cannot see the pid", async () => {
    // Process ids are per namespace, so a lock written by a bot in a
    // container names a pid this process cannot check. Reporting that as
    // stale would invite starting a second bot on one crypto store.
    const { dir, data } = makeDeployment();
    try {
      writeFileSync(join(data, "bot.lock"), "999999\n");
      const { report } = await run(data);
      const lock = report.checks.find((c) => c.name === "instance lock");
      assert.equal(lock.status, "warn");
      assert.match(lock.detail, /not visible/);
      assert.match(lock.fix, /another container|Megolm/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when a schedule is configured with nothing to run it", async () => {
    const { dir, data } = makeDeployment();
    try {
      const crontab = join(data, "crontab");
      writeFileSync(crontab, "* * * * * true\n");
      const { report } = await run(data, { CRONTAB_FILE: crontab, PATH: "/nonexistent" });
      assert.equal(statusOf(report, "scheduler"), "fail",
        "a crontab nothing reads is the silent failure this project keeps removing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
