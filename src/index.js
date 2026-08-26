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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
import { AgentManager } from "./agent.js";

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

const TOKEN_PATH = resolve(storagePaths.token);
const SYNC_PATH = resolve(storagePaths.sync);
const CRYPTO_PATH = resolve(storagePaths.crypto);

const LOG_LEVELS = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};

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

async function main() {
  LogService.setLogger(new RichConsoleLogger());
  LogService.setLevel(LOG_LEVELS[config.get("logger.level")] ?? LogLevel.INFO);
  // The rust crypto layer is extremely chatty at DEBUG and drowns everything else.
  LogService.muteModule("Metrics");

  mkdirSync(resolve(storagePaths.dataDir), { recursive: true });

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
  });

  // A decryption failure means the sender never shared a Megolm session with
  // this device — usually because the bot joined after the message was sent,
  // or the sender refuses to share with unverified devices.
  client.on("room.failed_decryption", (roomId, event, err) => {
    LogService.error("bot", `Failed to decrypt in ${roomId}: ${err?.message ?? err}`);
  });

  client.on("room.message", async (roomId, event) => {
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

    await withTyping(client, roomId, async () => {
      const agent = await getAgent();
      await agent.handleMessage({ roomId, text: body, sender: event.sender, client });
    });
  });

  await client.start();

  const joined = await client.getJoinedRooms();
  LogService.info("bot", `Started. Crypto ready=${client.crypto?.isReady}. Rooms: ${joined.length}`);
  for (const roomId of joined) LogService.info("bot", `  ${roomId}`);

  // Make sure agent + sync are torn down cleanly. The handoff flagged
  // `client` as undefined in this scope (defined only inside main), so capture
  // it on the module for the handler.
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
