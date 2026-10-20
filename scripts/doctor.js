#!/usr/bin/env node
// Is this deployment ready, and if not, what exactly is missing.
//
// Written to be read by something that is not a person. "Did it work" has so
// far meant grepping the startup log for `Crypto ready=true`, which tells you
// nothing when it is absent — and an agent asked to deploy this bot needs a
// verification step at every stage, not a wall of narration to interpret.
// Each check names what is wrong and what to do about it; `--json` gives the
// same thing structured.
//
// Two rules this file must keep:
//
//   * **Read only.** It must be safe to run against a live deployment. Nothing
//     here writes, and in particular nothing opens the crypto store: only one
//     process may, and a second one desynchronises the Megolm ratchet. The
//     cross-signing check therefore asks the *server* over HTTP rather than
//     reading the store. See SECURITY.md.
//   * **No side effects from probing.** `ModelRuntime.create()` would answer
//     the provider question definitively, and would also create an empty
//     `auth.json` when none exists — turning a diagnostic into a change.
//     The file is inspected instead.
//
// Exit code is 0 when nothing failed, 1 otherwise, so a caller can branch on
// it without parsing anything. Warnings do not fail: an empty allowlist is a
// serious problem but not a reason to believe the bot will not start.

import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import config from "config";

const JSON_OUT = process.argv.includes("--json");
const PREFLIGHT = process.argv.includes("--preflight");
const results = [];

// --- preflight ---------------------------------------------------------------
//
// A different question from the rest of this file. The checks below ask
// whether a deployment that exists is healthy; this asks whether there is
// enough information to build one, and answers before anything has been
// created — no data directory, no container, nothing to inspect.
//
// It exists because of where the agent-driven path actually stalls. Four of
// these cannot be obtained by any amount of automation: someone has to
// register the bot's Matrix account, turn on recovery in Element so that
// secret storage exists at all, say who is allowed to drive the agent, and
// invite the bot to a room. An agent that discovers that at `up -d` has
// already built two thirds of a bot. Asked first, it is a short list of
// questions.
//
// `secret` is marked so a caller knows not to echo the value back; `from`
// says who can supply it, which is what turns this into a form rather than a
// list of complaints.

const INPUTS = [
  {
    key: "MATRIX_HOMESERVER", required: true, secret: false, from: "human",
    what: "Base URL of the homeserver the bot logs in to",
    how: "e.g. https://matrix.example.org — the server your own account is on",
  },
  {
    key: "MATRIX_USER_ID", required: true, secret: false, from: "human",
    what: "The bot's own Matrix user id",
    how: "Register a separate account for it, not your own and not another bot's: @mybot:matrix.example.org",
  },
  {
    key: "MATRIX_PASSWORD", required: true, secret: true, from: "human",
    what: "That account's password, for the first login only",
    how: "After the first start the bot stores a device token and this can be emptied",
  },
  {
    key: "MATRIX_ALLOWED_USERS", required: true, secret: false, from: "human",
    what: "Who may drive the agent — comma separated user ids",
    how: "Your own user id. Empty means everyone, and the agent runs shell commands with no approval gate",
  },
  {
    key: "MATRIX_RECOVERY_KEY", required: false, secret: true, from: "human",
    what: "Unlocks secret storage so the bot's device can be cross-signed",
    how: "Log into the bot's account in Element once and turn on recovery; that is what creates the secret storage, and it hands you this key. Without it the bot works, but every message it sends is flagged as sent by an unverified device",
  },
  {
    // Required, despite there being another way. `pi /login` is a terminal UI,
    // so it is available to a person and not to an agent — and preflight
    // exists for the caller that cannot use it. Marking this optional let a
    // dry run reach "All required inputs present" on a deployment that then
    // failed its first message with no provider configured.
    key: "*_API_KEY", required: true, secret: true, from: "human",
    what: "A model provider credential",
    how: "Set one here, e.g. ANTHROPIC_API_KEY. A person at a terminal can instead run `docker compose run --rm bot pi` and use /login, which writes data/pi/auth.json — but that needs a TTY, so it is not a route an agent can take",
  },
];

if (PREFLIGHT) {
  const provider = Object.keys(process.env).find((k) => /_API_KEY$/.test(k) && process.env[k]);
  const fields = INPUTS.map((i) => {
    const value = i.key === "*_API_KEY" ? (provider ? process.env[provider] : "") : process.env[i.key];
    return { ...i, ...(provider && i.key === "*_API_KEY" ? { key: provider } : {}), present: Boolean(value?.trim()) };
  });
  const missing = fields.filter((f) => f.required && !f.present);

  if (JSON_OUT) {
    console.log(JSON.stringify({ ready: missing.length === 0, missing: missing.map((f) => f.key), fields }, null, 2));
  } else {
    for (const f of fields) {
      const mark = f.present ? "ok  " : f.required ? "NEED" : "opt ";
      console.log(`${mark}  ${f.key}${f.secret ? "  (secret)" : ""}: ${f.what}`);
      if (!f.present) console.log(`        → ${f.how}`);
    }
    console.log(
      missing.length === 0
        ? "\nAll required inputs present. Nothing here can be obtained without you except by asking."
        : `\nMISSING ${missing.length}: ${missing.map((f) => f.key).join(", ")}`,
    );
    // The one step no variable covers, and the one most often forgotten.
    console.log("\nStill yours to do after it starts: invite the bot to a room from an allowlisted account.");
  }
  process.exit(missing.length === 0 ? 0 : 1);
}

/** @param {"ok"|"warn"|"fail"} status */
function record(name, status, detail, fix) {
  results.push({ name, status, detail, ...(fix ? { fix } : {}) });
}

const ok = (n, d) => record(n, "ok", d);
const warn = (n, d, f) => record(n, "warn", d, f);
const fail = (n, d, f) => record(n, "fail", d, f);

function writable(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// --- configuration -----------------------------------------------------------

const matrix = config.get("matrix");
const dataDir = resolve(config.get("storage.dataDir") ?? "./data");
const tokenPath = resolve(config.get("storage.token"));
const agentDir = resolve(config.get("agent.agentDir"));

if (!matrix.homeserver || !matrix.userId) {
  fail(
    "config",
    `missing ${!matrix.homeserver ? "MATRIX_HOMESERVER" : ""}${!matrix.homeserver && !matrix.userId ? " and " : ""}${!matrix.userId ? "MATRIX_USER_ID" : ""}`,
    "set them in .env beside compose.yml, then recreate the container — env_file is read at create, not at start",
  );
} else {
  ok("config", `${matrix.userId} at ${matrix.homeserver}`);
}

// --- storage -----------------------------------------------------------------

if (!existsSync(dataDir)) {
  fail("data directory", `${dataDir} does not exist`, `mkdir -p ${dataDir}`);
} else if (!writable(dataDir)) {
  // The classic: Docker created a missing bind-mount source as root and the
  // container runs as uid 1000.
  fail("data directory", `${dataDir} is not writable by uid ${process.getuid?.() ?? "?"}`,
    "create the bind-mount directories yourself before `up`, or chown them to 1000:1000");
} else {
  ok("data directory", `${dataDir} writable`);
}

for (const [label, key] of [["inbox", "inbox.dir"], ["outbox", "outbox.dir"]]) {
  const dir = resolve(config.get(key));
  if (!existsSync(dir)) fail(`${label} spool`, `${dir} does not exist`, `mkdir -p ${dir}`);
  else if (!writable(dir)) fail(`${label} spool`, `${dir} is not writable`, "chown it to the user the bot runs as");
  else ok(`${label} spool`, dir);
}

// --- identity ----------------------------------------------------------------
//
// token.json is what makes a restart keep the same device. Its absence is not
// a failure on a first run — it is what the first password login produces.

const token = readJson(tokenPath);
if (!token) {
  if (matrix.password) {
    warn("device", `no ${tokenPath} yet — the next start will log in with MATRIX_PASSWORD and create it`,
      "expected on a first run; after it exists the password is no longer needed");
  } else {
    fail("device", `no ${tokenPath} and MATRIX_PASSWORD is empty — nothing can log in`,
      "set MATRIX_PASSWORD for the first login, then recreate the container");
  }
} else if (!token.deviceId || !token.accessToken) {
  fail("device", `${tokenPath} is missing deviceId or accessToken`, "delete it and let a password login recreate it");
} else if (token.userId && matrix.userId && token.userId !== matrix.userId) {
  // Credentials swapped without swapping the data directory. The bot would
  // answer as somebody else, which is worth catching before it does.
  fail("device", `${tokenPath} holds ${token.userId} but MATRIX_USER_ID is ${matrix.userId}`,
    "point this deployment at its own DATA_DIR, or remove the stale token");
} else {
  ok("device", `${token.deviceId} for ${token.userId ?? matrix.userId}`);
}

// --- model provider ----------------------------------------------------------
//
// `auth.json` containing `{}` is pi's "created, never configured" state, and
// is exactly what a bot that has never been logged in looks like. An API key
// in the environment is the other documented route; pi writes auth.json from
// it on first use, so an empty file plus a key is fine.

const authPath = join(agentDir, "auth.json");
const auth = readJson(authPath);
const envKey = Object.keys(process.env).find((k) => /_API_KEY$/.test(k) && process.env[k]);

if (auth && Object.keys(auth).length > 0) {
  ok("model provider", `${Object.keys(auth).join(", ")} in ${authPath}`);
} else if (envKey) {
  ok("model provider", `${envKey} in the environment; pi will write ${authPath} on first use`);
} else if (auth) {
  fail("model provider", `${authPath} is empty ({}) and no *_API_KEY is set`,
    "`docker compose run --rm bot pi` then /login <provider>, or set an API key in .env");
} else {
  fail("model provider", `no ${authPath} and no *_API_KEY is set`,
    "`docker compose run --rm bot pi` then /login <provider>, or set an API key in .env");
}

// --- what the agent is told --------------------------------------------------

const agentsMd = join(agentDir, "AGENTS.md");
if (!existsSync(agentsMd)) {
  warn("agent instructions", `${agentsMd} not written yet`, "it is installed at every start; start the bot once");
} else {
  const text = readFileSync(agentsMd, "utf8");
  if (/\{\{/.test(text)) {
    fail("agent instructions", `${agentsMd} still contains a {{placeholder}}`,
      "a value was not supplied; check the startup log for which");
  } else {
    ok("agent instructions", `${agentsMd}, ${text.length} chars`);
  }
}

// --- enabled sections, against what ships -------------------------------------
//
// A copy in parts-enabled/ is the operator's outright: the bot publishes the
// shipped text to parts-available/ on every start and never touches an enabled
// copy. That is the whole design, and its cost is silent drift — a bot can go
// on reading a section written before the behaviour it describes changed.
//
// This happened. One deployment spent six weeks telling its agent to check a
// heartbeat file that had been deleted, because its copy was seeded two hours
// before the text was rewritten. The `{{placeholder}}` check above caught it
// only because a *variable* disappeared with the mechanism; text that drifts
// without one would go on unnoticed.
//
// So: compare, and warn rather than fail, because an edited copy is the point.
// The direction is knowable — publishParts only writes when the shipped text
// actually changes, so an available file newer than the enabled copy means
// something shipped after yours was made, where the reverse is just an edit.

const enabledDir = join(dataDir, "parts-enabled");
const availableDir = join(dataDir, "parts-available");

if (!existsSync(enabledDir)) {
  ok("agent sections", "none enabled — AGENTS.md carries the template alone");
} else {
  const enabled = readdirSync(enabledDir).filter((n) => n.endsWith(".md")).sort();
  const stale = [];
  const edited = [];
  const own = [];

  for (const name of enabled) {
    // Seeded copies carry a 10-/20- prefix for ordering; the shipped file does not.
    const shipped = join(availableDir, name.replace(/^\d+-/, ""));
    if (!existsSync(shipped)) {
      own.push(name);
      continue;
    }
    const mine = readFileSync(join(enabledDir, name), "utf8").trim();
    const theirs = readFileSync(shipped, "utf8").replace(/^<!--[^>]*-->\s*/, "").trim();
    if (mine === theirs) continue;

    const mineAt = statSync(join(enabledDir, name)).mtime;
    const theirsAt = statSync(shipped).mtime;
    (theirsAt > mineAt ? stale : edited).push(
      // To the minute: the drift that prompted this was two hours wide, and a
      // date alone would have shown both sides as the same day.
      `${name} (yours ${mineAt.toISOString().slice(0, 16).replace("T", " ")}, shipped ${theirsAt.toISOString().slice(0, 16).replace("T", " ")})`,
    );
  }

  const parts = [`${enabled.length} enabled`];
  if (own.length) parts.push(`${own.length} your own`);
  if (edited.length) parts.push(`${edited.length} edited`);

  if (stale.length) {
    warn("agent sections", `${parts.join(", ")}; ${stale.length} behind what ships — ${stale.join("; ")}`,
      `the shipped text changed after your copy was made. Compare with ${availableDir}/ and copy across if you did not mean to customise it`);
  } else {
    ok("agent sections", parts.join(", "));
  }
}

// --- access control ----------------------------------------------------------
//
// A warning rather than a failure: the bot starts and works. It just lets
// anyone who can reach it run shell commands. See SECURITY.md.

if (!matrix.allowedUsers?.length) {
  warn("allowlist", "MATRIX_ALLOWED_USERS is empty — everyone who can message the bot may run shell commands",
    "set it to your own user id, then recreate the container");
} else {
  ok("allowlist", `${matrix.allowedUsers.length} user(s)`);
}

// --- scheduling --------------------------------------------------------------

const crontabFile = config.get("agent.crontabFile");
if (!crontabFile) {
  ok("scheduler", "CRONTAB_FILE unset — scheduling is off, and the agent is not told it exists");
} else {
  const onPath = (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, "supercronic")));
  if (!onPath) {
    fail("scheduler", `CRONTAB_FILE is ${crontabFile} but there is no supercronic on PATH`,
      "nothing would read the schedule; unset CRONTAB_FILE or use an image that ships supercronic");
  } else if (!existsSync(crontabFile)) {
    warn("scheduler", `${crontabFile} does not exist yet`, "the bot seeds it at startup");
  } else {
    const jobs = readFileSync(crontabFile, "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
    ok("scheduler", `${crontabFile}, ${jobs.length} active job(s)`);
  }
}

// --- is one already running --------------------------------------------------
//
// Informational, and the thing to know before starting another: two processes
// on one data directory desynchronise the Megolm ratchet.

const lockPath = join(dataDir, "bot.lock");
if (!existsSync(lockPath)) {
  ok("instance lock", "free — nothing has claimed this data directory");
} else {
  const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);

  // `process.kill(pid, 0)` alone is not enough, and the way it fails is
  // instructive: thread ids share the pid space, so in a fresh container
  // node's own libuv threadpool occupies the low numbers and a lock naming
  // pid 7 "exists" as one of them. Checking the command line is what
  // instance-lock.js does for the same reason.
  let visible = false;
  try {
    process.kill(pid, 0);
    visible = readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("index.js");
  } catch (err) {
    // EPERM means it exists and belongs to someone else; an unreadable
    // /proc entry means it is gone between the two calls.
    visible = err?.code === "EPERM";
  }

  if (visible) {
    ok("instance lock", `held by pid ${pid}, which is running here — a bot is live`);
  } else {
    // A pid that is not visible is *not* the same as a pid that is gone, and
    // the difference matters more than anything else this script reports.
    // Process ids are per namespace: run this in a throwaway container and the
    // live bot's pid 7 is simply not in view. Calling that "stale" would
    // invite starting a second bot on one crypto store, which desynchronises
    // the Megolm ratchet and produces messages strict clients refuse to
    // decrypt. So say what is known and no more.
    warn("instance lock", `claimed by pid ${pid}, which is not visible from this process`,
      "it may be stale, or a bot may be running in another container — check `docker ps` before starting one; " +
        "two bots on one data directory desynchronise the Megolm ratchet");
  }
}

// --- cross-signing -----------------------------------------------------------
//
// Asked of the server rather than the local store, so this is safe while the
// bot is running. A device signed only by itself is one Element flags as
// "Encrypted by a device not verified by its owner".

async function checkCrossSigning() {
  if (!token?.accessToken || !token?.deviceId || !matrix.homeserver) {
    warn("cross-signing", "skipped — needs a device token", "run again once the bot has logged in");
    return;
  }
  try {
    const res = await fetch(`${matrix.homeserver}/_matrix/client/v3/keys/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ device_keys: { [matrix.userId]: [token.deviceId] } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      warn("cross-signing", `homeserver answered ${res.status}`, "check MATRIX_HOMESERVER and the token");
      return;
    }
    const body = await res.json();
    const sigs = Object.keys(body?.device_keys?.[matrix.userId]?.[token.deviceId]?.signatures?.[matrix.userId] ?? {});
    const selfOnly = sigs.length <= 1 && sigs.every((s) => s.endsWith(token.deviceId));
    if (sigs.length === 0 || selfOnly) {
      warn("cross-signing", `${token.deviceId} is signed only by itself`,
        "docker compose run --rm bot node /app/scripts/cross-sign.js");
    } else {
      ok("cross-signing", `${token.deviceId} signed by ${sigs.length} key(s)`);
    }
  } catch (err) {
    warn("cross-signing", `could not reach the homeserver: ${err?.message ?? err}`, "check MATRIX_HOMESERVER");
  }
}

await checkCrossSigning();

// --- report ------------------------------------------------------------------

const failed = results.filter((r) => r.status === "fail");
const warned = results.filter((r) => r.status === "warn");

if (JSON_OUT) {
  console.log(JSON.stringify({ ready: failed.length === 0, failed: failed.length, warnings: warned.length, checks: results }, null, 2));
} else {
  const mark = { ok: "ok  ", warn: "WARN", fail: "FAIL" };
  for (const r of results) {
    console.log(`${mark[r.status]}  ${r.name}: ${r.detail}`);
    if (r.fix && r.status !== "ok") console.log(`        → ${r.fix}`);
  }
  console.log(
    failed.length === 0
      ? `\nREADY${warned.length ? ` — with ${warned.length} warning(s)` : ""}.`
      : `\nNOT READY — ${failed.length} check(s) failed.`,
  );
}

process.exit(failed.length === 0 ? 0 : 1);
