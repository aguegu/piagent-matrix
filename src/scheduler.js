// The scheduler, run by the bot rather than beside it.
//
// `supercronic` reads a crontab file and runs what is in it. Where that
// process lives has been moved twice, and the reasoning is worth keeping:
//
//   - its own container first, on the argument that a scheduler dying should
//     do so visibly. It dies visibly to whoever runs `docker ps`, and
//     invisibly to the agent, which is the party that schedules things. The
//     agent looked for a scheduler, found none, and had to be told to
//     disbelieve its own `ps`;
//   - a second process in the bot's container next, started by the compose
//     `command`. That fixed the visibility and broke shutdown: a backgrounded
//     sibling gets no SIGTERM, so it ran through the grace period and died by
//     SIGKILL. Measured, not assumed;
//   - a child of this process, which is here. The bot already knows how to
//     shut down in order, so the scheduler shuts down with it. Nothing is
//     needed in compose, which means a published image schedules out of the
//     box rather than only for someone who copied the right `command:`.
//
// Being the parent buys three things the other two arrangements could not:
// the child is restarted when it dies, its output joins the bot's log instead
// of a second stream, and its environment is ours to choose. That last one
// matters more than it sounds — supercronic deliberately does not purge the
// environment before running a job (a container's configuration arrives that
// way, and this was verified against the real binary rather than trusted), so
// as a child of the bot a job would inherit everything the bot has, the
// Matrix password and recovery key included. The sidecar was denied those by
// leaving out `env_file`; here the child's environment is built from an
// allowlist instead. See PASSED.
//
// `pgrep -a supercronic` still finds it, which is the check the agent reached
// for unaided and the reason it is in this container at all.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LogService } from "matrix-bot-sdk";

/** Written once, when there is no crontab yet, so the file is never missing. */
const SEED = "# Schedule for this bot. Edited by the agent; reloaded on save.\n";

/**
 * All a job gets. Everything else in the bot's environment is dropped.
 *
 * This was a denylist first — the bot's password and recovery key removed,
 * the rest passed through — which is the wrong way round. A denylist has to
 * keep up with every secret anyone adds to `.env`, and the day it does not,
 * nothing says so: the leak is silent and permanent, since a job's whole
 * output is a file somebody may well post to a room.
 *
 * So the list is what a scheduled command needs to *work*: enough to find its
 * tools (`PATH`), write scratch files (`HOME`), agree with everyone else
 * about the time (`TZ`) and about text (`LANG`, `LC_ALL`), and address this
 * deployment's own directories — including pi's, so a job may run `pi`
 * itself. Nothing here is a credential.
 *
 * A job needing more should read it from a file, which is the same answer the
 * agent already has for everything else it wants to persist:
 * `. /data/cron.env && your-command`.
 */
const PASSED = [
  "PATH", "HOME", "TZ", "LANG", "LC_ALL",
  "DATA_DIR", "SESSION_DIR", "BOT_CWD", "INBOX_DIR", "OUTBOX_DIR", "CRONTAB_FILE",
  "PI_AGENT_DIR", "PI_CODING_AGENT_DIR",
];

/** Only if PATH were unset, which would otherwise fail to exec at all. */
const FALLBACK_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** A crash loop, rather than the occasional death worth restarting through. */
const FLAP_WINDOW_MS = 10_000;
const FLAP_LIMIT = 5;

/** Environment for the child: built from nothing, not filtered from ours. */
export function jobEnvironment(env = process.env) {
  const out = {};
  for (const name of PASSED) if (env[name] !== undefined) out[name] = env[name];
  // execvp resolves the binary against the *child's* PATH, so an absent one
  // means supercronic itself cannot be found, let alone anything it runs.
  if (!out.PATH) out.PATH = FALLBACK_PATH;
  return out;
}

/** supercronic logs `time="…" level=info msg="…"`; our log already has a time. */
function routeLine(line) {
  const text = line.replace(/^time="[^"]*"\s*/, "");
  if (/level=(error|fatal|panic)/.test(text)) LogService.error("cron", text);
  else if (/level=warn/.test(text)) LogService.warn("cron", text);
  else LogService.info("cron", text);
}

/**
 * Start the scheduler as a child of this process.
 *
 * Returns null when there is nothing to run — no crontab configured, which is
 * the host deployment, where a real cron exists and the agent already drives
 * it. A missing binary cannot be reported that way, since spawn only fails
 * asynchronously; it arrives as an `error` event and is logged there. Either
 * way it must not pass quietly: a schedule file that nothing reads is the
 * failure this whole arrangement exists to avoid.
 *
 * @param {object} opts
 * @param {string} opts.crontabFile   Path to the crontab; also seeded if missing.
 * @param {string} [opts.binary]      Defaults to `supercronic` on PATH.
 * @param {number} [opts.restartDelayMs]
 * @param {number} [opts.killGraceMs] How long SIGTERM gets before SIGKILL.
 * @returns {{ stop: () => Promise<void>, get pid(): number | undefined,
 *             get running(): boolean } | null}
 */
export function startScheduler({
  crontabFile,
  binary = "supercronic",
  restartDelayMs = 5_000,
  killGraceMs = 5_000,
} = {}) {
  if (!crontabFile) return null;

  try {
    mkdirSync(dirname(crontabFile), { recursive: true });
    if (!existsSync(crontabFile)) writeFileSync(crontabFile, SEED);
  } catch (err) {
    LogService.error("cron", `Cannot prepare ${crontabFile}: ${err?.message ?? err}. Nothing will be scheduled.`);
    return null;
  }

  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  let stopping = false;
  let timer = null;
  let flaps = 0;

  const launch = () => {
    const startedAt = Date.now();
    child = spawn(binary, ["-inotify", crontabFile], {
      stdio: ["ignore", "pipe", "pipe"],
      env: jobEnvironment(),
    });

    for (const stream of [child.stdout, child.stderr]) {
      let buffered = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) routeLine(line);
      });
    }

    child.on("error", (err) => {
      // ENOENT here is the interesting one: no supercronic on PATH, which is
      // every deployment that set CRONTAB_FILE and did not install it.
      child = null;
      if (stopping) return;
      LogService.error(
        "cron",
        err?.code === "ENOENT"
          ? `No \`${binary}\` on PATH. ${crontabFile} will be read by nothing, so nothing scheduled there runs.`
          : `Scheduler failed to start: ${err?.message ?? err}`,
      );
    });

    child.on("exit", (code, signal) => {
      child = null;
      if (stopping) return;

      flaps = Date.now() - startedAt < FLAP_WINDOW_MS ? flaps + 1 : 0;
      const how = signal ? `on ${signal}` : `with code ${code}`;
      if (flaps >= FLAP_LIMIT) {
        LogService.error("cron", `Scheduler exited ${how} ${flaps} times in a row; giving up. Nothing in ${crontabFile} will run.`);
        return;
      }
      LogService.warn("cron", `Scheduler exited ${how}; restarting in ${restartDelayMs}ms.`);
      timer = setTimeout(launch, restartDelayMs);
      timer.unref?.();
    });
  };

  launch();

  return {
    get pid() {
      return child?.pid;
    },
    get running() {
      return child !== null && child.exitCode === null;
    },
    /** SIGTERM, then SIGKILL if it is still there — so a job in flight ends. */
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      const dying = child;
      if (!dying || dying.exitCode !== null) return;
      await new Promise((resolve) => {
        const hard = setTimeout(() => {
          try {
            dying.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, killGraceMs);
        hard.unref?.();
        dying.once("exit", () => {
          clearTimeout(hard);
          resolve();
        });
        try {
          dying.kill("SIGTERM");
        } catch {
          clearTimeout(hard);
          resolve();
        }
      });
    },
  };
}
