// Step 1: connect to Matrix with a persistent on-disk crypto store.
//
// The whole point of the new crypto stack is that device keys survive restarts:
// the rust-sdk store is a real SQLite file, so the bot keeps its Olm/Megolm
// identity instead of minting a new Olm account on every boot the way the
// old matrix-js-sdk path did.
//
// Step 2: each allowed m.text message is forwarded to a per-room AgentManager
// (see ./agent.js). The reply streams back into the room via LiveMessage
// (edit-in-place, with the encrypted-room dance baked in — see ./status.js).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import config from "config";
import {
  AutojoinRoomsMixin,
  LogLevel,
  LogService,
  MatrixAuth,
  MatrixClient,
  RichConsoleLogger,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
} from "matrix-bot-sdk";
import { StoreType } from "@matrix-org/matrix-sdk-crypto-nodejs";
import { withTyping } from "./status.js";
import { renderMarkdown } from "./markdown.js";
import { AgentManager } from "./agent.js";
import { startOutbox } from "./outbox.js";
import { parseCommand, helpText, mayCommand } from "./commands.js";
import { MainRoom, roomFits } from "./main-room.js";
import { installAgentResources } from "./resources.js";

const matrix = config.get("matrix");
const storagePaths = config.get("storage");

// .env is a committed template whose keys are all present but empty, so
// config.get() alone won't catch a missing value — it sees "" as defined.
// Check for emptiness explicitly, or a fresh clone without .env.local sails
// past startup and dies later with an opaque auth error.
for (const key of ["homeserver", "userId"]) {
  if (!matrix[key]) {
    throw new Error(
      `Missing config: matrix.${key}. Copy .env to .env.local and fill it in.`,
    );
  }
}

// BOT_CWD has no fallback in config/default.js — its default lives in the
// committed .env. Fail loudly if neither is present: silently defaulting to
// process.cwd() would point the agent at whatever directory the bot was
// started from, which for this repo is the one holding its own credentials.
if (!config.get("agent.cwd")) {
  throw new Error(
    "Missing config: agent.cwd (BOT_CWD). The default lives in .env — if the " +
      "bot is started from another directory, dotenv-flow will not find it; " +
      "set BOT_CWD explicitly in the environment.",
  );
}

const TOKEN_PATH = resolve(storagePaths.token);
const SYNC_PATH = resolve(storagePaths.sync);
const CRYPTO_PATH = resolve(storagePaths.crypto);

const LOG_LEVELS = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};

/**
 * Logger wrapper around RichConsoleLogger that swallows a small set of known
 * noisy error patterns from the SDK.
 *
 * The bot-sdk calls `LogService.error("MatrixHttpClient", "(REQ-N)", body)`
 * for every HTTP request that returns an errcode, including the `M_NOT_FOUND`
 * noise from the encryption-state probe and DM lookup. Real errors (500s,
 * decryption failures, network problems) pass through unchanged.
 */
const baseLogger = new RichConsoleLogger();
const filteredLogger = {
  trace: (...args) => baseLogger.trace(...args),
  debug: (...args) => baseLogger.debug(...args),
  info: (...args) => baseLogger.info(...args),
  warn: (...args) => baseLogger.warn(...args),
  error: (module, ...rest) => {
    if (module === "MatrixHttpClient" && isNoisyHttpError(rest)) return;
    baseLogger.error(module, ...rest);
  },
};

function isNoisyHttpError(args) {
  // The third argument from http.js is the redacted error body. Look for
  // M_NOT_FOUND specifically — everything else is forwarded.
  for (const a of args) {
    if (a && typeof a === "object" && a.errcode === "M_NOT_FOUND") return true;
  }
  return false;
}

// A token is tied to a device, and a device is tied to the crypto store, so the
// two have to be created and reused together. Losing one invalidates the other.
async function resolveAccessToken() {
  if (existsSync(TOKEN_PATH)) {
    const saved = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
    LogService.info("bot", `Reusing stored device ${saved.deviceId}.`);
    return saved.accessToken;
  }

  if (!matrix.password) {
    throw new Error("No stored token and MATRIX_PASSWORD is unset — cannot log in.");
  }

  LogService.info("bot", "No stored token — logging in with password.");
  const auth = new MatrixAuth(matrix.homeserver);
  const fresh = await auth.passwordLogin(
    matrix.userId.split(":")[0].replace(/^@/, ""),
    matrix.password,
    matrix.deviceName,
  );

  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(
    TOKEN_PATH,
    JSON.stringify(
      {
        accessToken: fresh.accessToken,
        deviceId: await fresh.getWhoAmI().then((w) => w.device_id),
        userId: matrix.userId,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  LogService.info("bot", `Logged in and saved token to ${TOKEN_PATH}.`);
  return fresh.accessToken;
}

function isAllowed(sender) {
  if (matrix.allowedUsers.length === 0) {
    LogService.warn("bot", `Allowing ${sender} — MATRIX_ALLOWED_USERS is empty.`);
    return true;
  }
  return matrix.allowedUsers.includes(sender);
}

// Lazy singleton so we only pay ModelRuntime.create() (which reads auth + models
// catalog from disk) when the first message actually arrives.
let agentPromise = null;
let botClient = null;
let stopOutbox = null;
/** @type {MainRoom | null} */
let mainRoom = null;
function getAgent() {
  if (!agentPromise) {
    const opts = config.get("agent");
    agentPromise = Promise.resolve(new AgentManager(opts));
  }
  return agentPromise;
}

async function shutdown(signal) {
  LogService.info("bot", `Received ${signal}, shutting down.`);
  try {
    stopOutbox?.();
  } catch {
    /* ignore */
  }
  try {
    if (agentPromise) {
      const agent = await agentPromise;
      await agent.dispose();
    }
  } catch (err) {
    LogService.warn("bot", `agent.dispose: ${err?.message ?? err}`);
  }
  try {
    botClient?.stop?.();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

/**
 * Handle one incoming room message. Errors propagate to the caller, which is
 * responsible for catching them — see the `room.message` registration.
 */
async function handleRoomMessage(client, roomId, event) {
  if (event.sender === (await client.getUserId())) return;
  const body = event.content?.body;
  if (event.content?.msgtype !== "m.text" || !body) return;

  if (!isAllowed(event.sender)) {
    LogService.info("bot", `Ignoring ${event.sender} — not allowed.`);
    return;
  }

  const encrypted = await client.crypto.isRoomEncrypted(roomId).catch(() => false);
  LogService.info(
    "bot",
    `< ${encrypted ? "[e2ee] " : ""}${event.sender}: ${JSON.stringify(body)}`,
  );

  // Acknowledge immediately so the sender sees the bot registered the message
  // even if the reply takes a while.
  await client.sendReadReceipt(roomId, event.event_id).catch(() => {});

  // A short allowlist of bot commands, checked before the agent sees anything.
  // Unrecognised slash text falls through as an ordinary prompt, so a message
  // that merely starts with a slash — a path, say — still reaches the agent.
  const command = parseCommand(body);

  await withTyping(client, roomId, async () => {
    const agent = await getAgent();
    if (command) return runCommand(command, { agent, client, roomId, sender: event.sender });
    await agent.handleMessage({ roomId, text: body, sender: event.sender, client });
  });
}

/** Handle one recognised bot command. */
async function runCommand(command, { agent, client, roomId, sender }) {
  LogService.info("bot", `command /${command.name} from ${sender} in ${roomId}`);

  // Commands belong to the main room; a working room gets `.info` only. The
  // refusal says nothing about why, and never names the main room — a working
  // room may hold people who are not the bot's admin.
  if (!mayCommand(command.name, roomId, mainRoom?.roomId)) {
    await client.sendMessage(roomId, htmlMessage(`\`.${command.name}\` is not available here.`));
    return;
  }

  if (command.name === "info") {
    // Two lines, no caveats. Whether this room has a live session yet is an
    // implementation detail — sessions are in-memory, so a room chatted in for
    // days reports none after a restart, which reads as "I do not remember
    // you" when the history is on disk waiting to be resumed. The values are
    // the same either way. `.model` and `.thinking` keep the distinction,
    // where an admin can act on it.
    const [model, thinking] = await Promise.all([
      agent.describeModel(roomId),
      agent.describeThinking(roomId),
    ]);
    await client.sendMessage(roomId, htmlMessage(
      `Model: \`${model.current}\`\nThinking: \`${thinking.current}\``,
    ));
    return;
  }

  if (command.name === "help") {
    const dir = resolve(config.get("agent.agentDir"));
    await client.sendMessage(roomId, htmlMessage(helpText({
      prompts: listNames(join(dir, "prompts")),
      skills: listNames(join(dir, "skills")),
    })));
    return;
  }

  if (command.name === "model") {
    // Bare `.model` is the chat equivalent of pi's selector UI: report where we
    // are and what else is on offer, since a room cannot present a picker.
    if (!command.args) {
      const { current, live, available } = await agent.describeModel(roomId);
      const lines = [
        `Model: \`${current}\`${live ? "" : " (no session yet — this is what the next one starts with)"}`,
        "",
        "Available:",
        ...available.map((m) => `- \`${m}\``),
        "",
        "Switch with `.model <provider/id>`. It applies to every room, and is recorded so it survives a restart.",
      ];
      await client.sendMessage(roomId, htmlMessage(lines.join("\n")));
      return;
    }

    const result = await agent.setModel(command.args);
    const note = result.ok
      ? `Model is now \`${result.model}\` for every room — applied to ${result.applied} live session(s) and recorded, so it survives a restart.`
      : [
          `No model matches \`${command.args}\`.`,
          "",
          "Available:",
          ...result.available.map((m) => `- \`${m}\``),
        ].join("\n");
    await client.sendMessage(roomId, htmlMessage(note));
    return;
  }

  if (command.name === "thinking") {
    if (!command.args) {
      const { current, live, levels } = await agent.describeThinking(roomId);
      const lines = [
        `Thinking: \`${current}\`${live ? "" : " (no session yet — this is what the next one starts with)"}`,
        "",
        `Levels: ${levels.map((l) => `\`${l}\``).join(", ")}`,
        "",
        "Set it with `.thinking <level>`. It applies to every room, and is recorded so it survives a restart.",
      ];
      await client.sendMessage(roomId, htmlMessage(lines.join("\n")));
      return;
    }

    const result = await agent.setThinkingLevel(command.args);
    const note = result.ok
      ? `Thinking is now \`${result.level}\` for every room — applied to ${result.applied} live session(s) and recorded, so it survives a restart.`
      : `\`${command.args}\` is not a thinking level. Pick one of: ${result.levels.map((l) => `\`${l}\``).join(", ")}.`;
    await client.sendMessage(roomId, htmlMessage(note));
    return;
  }

  if (command.name === "rooms") {
    const joined = await client.getJoinedRooms();
    const main = mainRoom?.roomId ?? "";
    const [sub = "", ...rest] = command.args.trim().split(/\s+/).filter(Boolean);

    if (!sub) {
      const lines = ["**Rooms**", ""];
      for (const id of joined) {
        const tag = id === main ? `— **main room**${mainRoom.admin ? `, admin \`${mainRoom.admin}\`` : ""}` : "";
        lines.push(`- ${await describeRoom(client, id)} ${tag}`.trimEnd());
      }
      lines.push("", "Leave one with `.rooms leave <roomId>`.");
      await client.sendMessage(roomId, htmlMessage(lines.join("\n")));
      return;
    }

    // Room ids are printed in code spans, so a copied one arrives wrapped.
    const target = (rest[0] ?? "").replace(/^`+|`+$/g, "");
    if (sub.toLowerCase() !== "leave" || !target) {
      await client.sendMessage(roomId, htmlMessage(
        "`.rooms` lists the rooms the bot is in. `.rooms leave <roomId>` leaves one of them.",
      ));
      return;
    }

    if (!joined.includes(target)) {
      await client.sendMessage(roomId, htmlMessage(
        `Not in \`${target}\`. Say \`.rooms\` for the ids the bot is actually in.`,
      ));
      return;
    }

    // Leaving the room the command came from — the main room, since that is
    // where commands run. Allowed: whoever can type this can kick the bot out
    // anyway, and more easily. But the goodbye has to go out first, because
    // afterwards there is no room to send it to.
    if (target === roomId) {
      await client.sendMessage(roomId, htmlMessage(
        "Leaving this room. The main room record goes with it, so the next room that fits becomes " +
          "the control channel and the bot says so there. If none fits, it has no main room until " +
          "one is invited.",
      ));
      const error = await leaveRoom(client, agent, target);
      // Still here if it did not work, so the failure can still be reported.
      if (error) await client.sendMessage(roomId, htmlMessage(`Could not leave: ${error}`));
      return;
    }

    const error = await leaveRoom(client, agent, target);
    await client.sendMessage(roomId, htmlMessage(
      error ? `Could not leave \`${target}\`: ${error}` : `Left \`${target}\`.`,
    ));
    return;
  }

  if (command.name === "reload") {
    const { reloaded, failed } = await agent.reload();
    const note = failed.length
      ? `Reloaded ${reloaded} session(s); ${failed.length} failed — see the log.`
      : reloaded
        ? `Reloaded ${reloaded} session(s): extensions, skills, prompts and context files re-read.`
        : "No live sessions to reload — the next message will pick up any changes.";
    await client.sendMessage(roomId, htmlMessage(note));
    return;
  }

  // Everything else is a pi prompt template. Hand it over with the leading
  // slash intact; pi expands it and runs the agent, so the reply arrives the
  // usual way.
  await agent.handleMessage({
    roomId,
    text: `/${command.name}${command.args ? ` ${command.args}` : ""}`,
    sender,
    client,
  });
}

/** Names of the *.md files in a pi resource directory, without extensions. */
function listNames(dir) {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".md")).map((n) => n.replace(/\.md$/, "")).sort();
  } catch {
    return [];
  }
}

/**
 * Tell a room it has just become the control channel.
 *
 * Adoption is otherwise invisible: it happens on join and is written to disk,
 * so without this the only way to learn which room the bot takes commands from
 * is to read the log. The room that gets the powers should be told it has them.
 *
 * Failure is logged, not thrown — a bot that cannot post the notice has still
 * joined and still adopted, and an exception here would escape into the join
 * handler's unhandled rejection.
 */
async function announceMainRoom(client, roomId) {
  const note = [
    "**Adopted this as my main room.**",
    "",
    "It is my control channel: commands run here, and anything I am asked to post later arrives here.",
    "Other rooms get `.info` and nothing else.",
    "",
    "Say `.help` for what I answer to.",
  ].join("\n");
  try {
    await client.sendMessage(roomId, htmlMessage(note));
    LogService.info("bot", `Announced the main room in ${roomId}.`);
  } catch (err) {
    LogService.warn("bot", `Could not announce the main room in ${roomId}: ${err?.message ?? err}`);
  }
}

/**
 * Leave a room, dropping its cached session with it.
 *
 * Returns rather than throws, because the caller may be about to lose the room
 * it would report into and has to know which happened.
 *
 * @returns {Promise<string>} "" on success, else why it failed
 */
async function leaveRoom(client, agent, roomId) {
  try {
    await client.leaveRoom(roomId, "Asked to leave from the main room");
    await agent.disposeRoom(roomId);
    LogService.info("bot", `Left ${roomId} on request from the main room.`);
    return "";
  } catch (err) {
    const why = String(err?.message ?? err);
    LogService.warn("bot", `Could not leave ${roomId}: ${why}`);
    return why;
  }
}

/**
 * One line describing a room: its name if it has one, its id, and how many
 * members.
 *
 * The name is written by whoever made the room, so it goes in a code span —
 * markdown inside it then renders as itself rather than as formatting. (The
 * sanitiser already blocks anything worse; this is about a room called
 * "**urgent**" not shouting in the listing.)
 */
async function describeRoom(client, roomId) {
  const name = await client
    .getRoomStateEvent(roomId, "m.room.name", "")
    .then((e) => (typeof e?.name === "string" ? e.name.replace(/`/g, "'").trim() : ""))
    .catch(() => "");
  const members = await roomMembers(client, roomId);
  const count = members ? `${members.length} member${members.length === 1 ? "" : "s"}` : "members unknown";
  return `${name ? `\`${name}\` ` : ""}\`${roomId}\` — ${count}`;
}

/** Members of a room, or null when the lookup fails. */
function roomMembers(client, roomId) {
  return client.getJoinedRoomMembers(roomId).catch(() => null);
}

/**
 * Check the main room, and drop the record if the bot is not in it.
 *
 * Being outside the room is the one disqualifying failure: commands run there
 * and nowhere else, so the bot would go silent while looking healthy, and every
 * alternative room would be declined because one is "already" recorded.
 * Dropping it lets another room take over without anyone editing a file on the
 * host. The other problems describe a room that still works, so they only warn.
 *
 * The chat notice goes out only where someone can act on it: not to a room the
 * bot is not in, obviously, and not to one holding no allowed user — a room of
 * strangers is the last place to announce that it is the bot's control room.
 * The log always gets everything.
 */
async function verifyMainRoom(client, joined) {
  if (!mainRoom?.roomId) return;
  const present = Array.isArray(joined) && joined.includes(mainRoom.roomId);
  const members = present ? await roomMembers(client, mainRoom.roomId) : null;

  const { problems, admins } = mainRoom.verify(joined, members, matrix.allowedUsers);
  if (!present) {
    mainRoom.unset("the bot is not in it");
    return;
  }
  if (!problems.length) return;

  if (matrix.allowedUsers.length && admins.length === 0) return;
  try {
    await client.sendMessage(mainRoom.roomId, htmlMessage(
      ["**Main room check**", "", ...problems.map((p) => `- ${p}`)].join("\n"),
    ));
  } catch (err) {
    LogService.warn("bot", `Could not post the main room check: ${err?.message ?? err}`);
  }
}

/**
 * Fill an empty main room from the rooms the bot is in.
 *
 * `preferred` is a room just joined, and wins outright if it fits: the invite
 * is the signal, and deferring to it is what lets an admin move the control
 * channel by inviting the bot somewhere new. Without one — at startup, or after
 * the main room was lost — exactly one fitting room is unambiguous and several
 * are not, the same reasoning that has always applied to guessing at startup.
 */
async function settleMainRoom(client, { preferred = "", why = "" } = {}) {
  if (!mainRoom || mainRoom.roomId) return;
  // Needed to tell the bot from its admin among a room's two members.
  const me = await client.getUserId().catch(() => "");

  if (preferred) {
    const fit = roomFits(await roomMembers(client, preferred), matrix.allowedUsers, me);
    if (fit.ok) {
      if (mainRoom.adopt(preferred, why || "joined a room that fits", fit.admin)) {
        await announceMainRoom(client, preferred);
      }
      return;
    }
    LogService.info("bot", `${preferred} is not adopted as the main room: ${fit.why}.`);
  }

  const joined = await client.getJoinedRooms().catch(() => []);
  const fits = [];
  for (const roomId of joined) {
    if (roomId === preferred) continue; // already tried, and it did not fit
    const fit = roomFits(await roomMembers(client, roomId), matrix.allowedUsers, me);
    if (fit.ok) fits.push({ roomId, admin: fit.admin });
  }

  if (fits.length === 1) {
    if (mainRoom.adopt(fits[0].roomId, why || "the only room that fits", fits[0].admin)) {
      await announceMainRoom(client, fits[0].roomId);
    }
    return;
  }
  if (fits.length === 0) {
    LogService.warn(
      "bot",
      "No main room, and none of the rooms this bot is in fits one. Invite it to a room " +
        "holding only itself and a user from MATRIX_ALLOWED_USERS.",
    );
    return;
  }
  LogService.warn(
    "bot",
    `No main room, and ${fits.length} rooms would fit (${fits.map((f) => f.roomId).join(", ")}), so there is no safe ` +
      "guess. Invite the bot to the room you want and it takes that one.",
  );
}

function htmlMessage(markdown) {
  return {
    msgtype: "m.text",
    body: markdown,
    format: "org.matrix.custom.html",
    formatted_body: renderMarkdown(markdown),
  };
}

async function main() {
  LogService.setLogger(filteredLogger);
  LogService.setLevel(LOG_LEVELS[config.get("logger.level")] ?? LogLevel.INFO);
  // The rust crypto layer is extremely chatty at DEBUG and drowns everything else.
  LogService.muteModule("Metrics");

  mkdirSync(resolve(storagePaths.dataDir), { recursive: true });
  mainRoom = new MainRoom(resolve(storagePaths.dataDir));
  // The bot's standing instructions are source, kept in agent/ and installed
  // here with this host's paths substituted, rather than living unversioned
  // under DATA_DIR.
  installAgentResources(resolve(config.get("agent.agentDir")), {
    DATA_DIR: resolve(storagePaths.dataDir),
    BOT_CWD: config.get("agent.cwd"),
    OUTBOX_DIR: resolve(config.get("outbox.dir")),
  });
  // The agent's working directory must exist before pi opens a session in it.
  mkdirSync(config.get("agent.cwd"), { recursive: true });

  const accessToken = await resolveAccessToken();
  const storage = new SimpleFsStorageProvider(SYNC_PATH);
  const cryptoStore = new RustSdkCryptoStorageProvider(CRYPTO_PATH, StoreType.Sqlite);

  const client = new MatrixClient(matrix.homeserver, accessToken, storage, cryptoStore);
  botClient = client;
  AutojoinRoomsMixin.setupOnClient(client);

  client.on("room.invite", (roomId, event) => {
    LogService.info("bot", `Invited to ${roomId} by ${event.sender} — autojoining.`);
  });

  client.on("room.join", async (roomId) => {
    const encrypted = await client.crypto.isRoomEncrypted(roomId).catch(() => false);
    LogService.info("bot", `Joined ${roomId} (encrypted=${encrypted}).`);

    // With no main room, a room that fits becomes the control channel here
    // rather than at startup, so a bot invited after it started needs no
    // restart — and so an admin can move the control channel by inviting it
    // somewhere new, without editing anything on the host.
    await settleMainRoom(client, { preferred: roomId, why: "first room that fits" });
  });

  // "leave" covers kicked, banned and left alike; the member event tells them
  // apart. Losing the main room is the case that matters: commands run there
  // and nowhere else, so a bot holding a pointer to a room it cannot reach goes
  // silent while looking healthy. Drop it and let another room take over.
  client.on("room.leave", async (roomId, event) => {
    const kicked = event?.sender && event.sender !== event.state_key;
    const by = kicked ? ` (kicked by ${event.sender}` : " (left";
    const reason = event?.content?.reason ? `: ${event.content.reason})` : ")";
    LogService.info("bot", `Left ${roomId}${by}${reason}.`);

    if (roomId !== mainRoom?.roomId) return;
    if (mainRoom.unset(kicked ? "the bot was kicked from it" : "the bot is no longer in it")) {
      await settleMainRoom(client, { why: "the main room was lost" });
    }
  });

  // A decryption failure means the sender never shared a Megolm session with
  // this device — usually because the bot joined after the message was sent,
  // or the sender refuses to share with unverified devices.
  client.on("room.failed_decryption", (roomId, event, err) => {
    LogService.error("bot", `Failed to decrypt in ${roomId}: ${err?.message ?? err}`);
  });

  // matrix-bot-sdk emits on a plain EventEmitter, which neither awaits nor
  // catches the promise an async listener returns. Anything that escapes
  // becomes an unhandledRejection, and Node terminates the process by default —
  // so a single failed agent run would take down the bot, and with it the
  // outbox and the hourly reports. Contain it at the boundary.
  client.on("room.message", (roomId, event) => {
    handleRoomMessage(client, roomId, event).catch((err) => {
      LogService.error(
        "bot",
        `message handler failed in ${roomId}: ${err?.message ?? err}`,
      );
    });
  });

  await client.start();

  const joined = await client.getJoinedRooms();
  LogService.info("bot", `Started. Crypto ready=${client.crypto?.isReady}. Rooms: ${joined.length}`);
  for (const roomId of joined) LogService.info("bot", `  ${roomId}`);

  LogService.info("bot", mainRoom.describe());
  await verifyMainRoom(client, joined);
  await settleMainRoom(client, { why: "the only room that fits at startup" });

  // Started after sync so crypto is warm before the first spooled send.
  // The main room is read per send, not captured here, so a room adopted later
  // takes effect immediately.
  const outboxCfg = config.get("outbox");
  stopOutbox = startOutbox(client, {
    dir: resolve(outboxCfg.dir),
    defaultRoom: () => mainRoom.roomId,
  });

  // Make sure agent + sync are torn down cleanly. The handoff flagged
  // `client` as undefined in this scope (defined only inside main), so capture
  // it on the module for the handler.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Backstop for any rejection that escapes a listener we haven't wrapped.
// Node's default for unhandledRejection is to terminate; for a long-running bot
// that turns one bad message into an outage. Log and keep serving instead.
//
// uncaughtException is deliberately NOT handled: a synchronous throw that
// reaches the top leaves the process in an undefined state, and continuing from
// there is worse than restarting. Let it crash and be restarted.
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  LogService.error("bot", `unhandled rejection: ${err.message}`);
  if (err.stack) LogService.debug("bot", err.stack);
});

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
