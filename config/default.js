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
    // Room used for *.txt drops and for *.json without an explicit "room".
    defaultRoom: process.env.OUTBOX_DEFAULT_ROOM || "",
  },
  agent: {
    // PI_MODEL = "<provider>/<model-id>". If unset, picks the first available.
    model: process.env.PI_MODEL || "",
    // PI_THINKING_LEVEL = off | minimal | low | medium | high | xhigh | max. Default low.
    thinkingLevel: process.env.PI_THINKING_LEVEL || "low",
    // Working directory the agent operates in. Each Matrix room shares this cwd;
    // per-room cwd is intentionally out of scope for the first cut.
    cwd: process.env.BOT_CWD || process.cwd(),
    // SESSION_DIR: when set, persist each room's conversation under
    // `${SESSION_DIR}/<encoded-roomId>/` so memory survives bot restarts.
    // When empty, sessions are in-memory only and reset on every restart.
    sessionDir: process.env.SESSION_DIR || "",
    // pi's config directory: auth.json, models-store.json, settings.json.
    // Defaults under DATA_DIR rather than ~/.pi/agent so the bot carries its
    // own provider credentials — otherwise it shares them with the operator's
    // interactive `pi`, and breaks when run as another user or in a container.
    agentDir: process.env.PI_AGENT_DIR || `${dataDir}/pi`,
  },
};
