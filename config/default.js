import dotenvFlow from "dotenv-flow";
dotenvFlow.config();

const dataDir = process.env.DATA_DIR || "./data";

export default {
  matrix: {
    homeserver: process.env.MATRIX_HOMESERVER,
    userId: process.env.MATRIX_USER_ID,
    password: process.env.MATRIX_PASSWORD,
    deviceName: process.env.MATRIX_DEVICE_NAME || "tradebots-matrix-v2",
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
};
