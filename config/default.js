import { resolve } from "node:path";
import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const dataDir = process.env.DATA_DIR || "./data";

export default {
  matrix: {
    homeserver: process.env.MATRIX_HOMESERVER,
    userId: process.env.MATRIX_USER_ID,
    password: process.env.MATRIX_PASSWORD,
    deviceName: process.env.MATRIX_DEVICE_NAME || "piagent-matrix",
    // Only used by `npm run cross-sign`; the bot itself never reads this.
    // matrix-bot-sdk has no secret-storage support, so the provisioning script
    // needs the recovery key to unlock the account's self-signing key.
    recoveryKey: process.env.MATRIX_RECOVERY_KEY || "",
    // The bot's control channel — normally the first room it was invited to, and
    // recorded in data/main-room.json rather than configured. Set this only to
    // pin a different room.
    mainRoom: process.env.MATRIX_MAIN_ROOM || "",
    // Empty list means "allow everyone", which the bot warns about on each message.
    allowedUsers: (process.env.MATRIX_ALLOWED_USERS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  storage: {
    dataDir,
    // The access token and the crypto store are a matched pair: the token binds
    // to a device, and the device's keys live in the store. Move or delete one
    // without the other and the bot loses its identity.
    token: `${dataDir}/token.json`,
    sync: `${dataDir}/sync.json`,
    crypto: `${dataDir}/crypto`,
  },
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
  // Spool directory other processes (cron jobs, scripts) drop messages into for
  // the running bot to send. Only the bot may open the crypto store: a second
  // client sharing it desynchronises the Megolm ratchet and produces messages
  // that conservative clients refuse to decrypt.
  outbox: {
    dir: process.env.OUTBOX_DIR || "./outbox",
    // Unaddressed *.txt drops go to the main room; see matrix.mainRoom.
  },
  agent: {
    // What a bot that has never been told starts with. Both are runtime
    // settings now: `.model` and `.thinking` in the main room record a choice
    // in stateFile, which wins over these.
    //
    // Deliberately not read from the environment. An interactive `pi` run
    // exports PI_MODEL and PI_PROVIDER into the shell, so honouring them let a
    // stray export decide the bot's model on a fresh install — invisible, and
    // pointless once the choice is a command away. Empty means first available.
    model: "",
    thinkingLevel: "low",
    // Where `.model` and `.thinking` record their choices, beside the bot's
    // other state rather than in pi's directory — these are the bot's settings,
    // not pi's.
    stateFile: `${dataDir}/agent.json`,
    // Working directory the agent operates in. Each Matrix room shares this cwd;
    // per-room cwd is intentionally out of scope for the first cut.
    //
    // No fallback on purpose: the default lives in the committed .env so it is
    // visible where people look for it. Resolved to absolute because pi records
    // cwd in each session header and matches it on resume — a relative value
    // would resolve differently depending on where the bot was started.
    // src/index.js refuses to start if this is unset, so a missing .env fails
    // loudly rather than silently reverting to process.cwd() (the repo root,
    // which holds the bot's credentials).
    cwd: process.env.BOT_CWD ? resolve(process.env.BOT_CWD) : "",
    // SESSION_DIR: when set, persist each room's conversation under
    // `${SESSION_DIR}/<encoded-roomId>/` so memory survives bot restarts.
    // When empty, sessions are in-memory only and reset on every restart.
    sessionDir: process.env.SESSION_DIR || "",
    // pi's config directory: auth.json, models-store.json, settings.json.
    // Defaults under DATA_DIR rather than ~/.pi/agent so the bot carries its
    // own provider credentials — otherwise it shares them with the operator's
    // interactive `pi`, and breaks when run as another user or in a container.
    agentDir: process.env.PI_AGENT_DIR || `${dataDir}/pi`,
    // Told to the agent so it can address messages it schedules for later.
    outboxDir: process.env.OUTBOX_DIR || "./outbox",
  },
};
