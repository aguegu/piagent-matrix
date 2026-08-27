// Provisioning step — run with `npm run cross-sign [DEVICE_ID]`.
//
// Signs the bot's device with the account's EXISTING self-signing key, so
// Element stops showing "Encrypted by a device not verified by its owner".
//
// Why this exists as a separate script rather than living in the bot:
// matrix-bot-sdk (and the rust bindings under it) have no secret-storage
// support, so they cannot read the account's self-signing key out of 4S the
// way Element does. matrix-js-sdk can, so it is pulled in as a devDependency
// used only here. The running bot never imports it.
//
// Safety notes:
//   * Aborts before touching cross-signing unless the EXISTING self-signing key
//     can be read from secret storage. bootstrapCrossSigning may otherwise mint
//     a replacement identity and reset trust for every session on the account.
//   * Logs in as its own throwaway device and logs out at the end. It must not
//     reuse the bot's access token: matrix-js-sdk would build its own crypto
//     store for that device id and re-upload different device keys, clobbering
//     the identity the running bot depends on.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import config from "config";
import { createClient } from "matrix-js-sdk";
import { logger as sdkLogger } from "matrix-js-sdk/lib/logger.js";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";

// matrix-js-sdk logs every HTTP request and the rust crypto layer is chattier
// still, which buries this script's own progress in hundreds of lines. The run
// reports each step and verifies the result against the server, so the SDK's
// narration adds nothing on a good run — and on a bad one the catch block
// prints the real error. VERBOSE=1 brings it all back.
sdkLogger.setLevel(process.env.VERBOSE ? "debug" : "silent");

const step = (msg) => console.log(`\n=== ${msg}`);
const fail = (msg) => {
  console.error(`\nABORT: ${msg}`);
  process.exit(1);
};

const matrix = config.get("matrix");
const tokenPath = resolve(config.get("storage.token"));

// Default to whichever device the bot is currently running as.
let target = process.argv[2];
if (!target) {
  if (!existsSync(tokenPath)) {
    fail(`No device id given and ${tokenPath} does not exist. Start the bot once first.`);
  }
  target = JSON.parse(readFileSync(tokenPath, "utf8")).deviceId;
}

if (!matrix.recoveryKey) fail("MATRIX_RECOVERY_KEY is not set — cannot unlock secret storage.");
if (!matrix.password) fail("MATRIX_PASSWORD is not set — needed to log in and to satisfy UIA.");

let cachedKeyId = null;
let client;

const cryptoCallbacks = {
  getSecretStorageKey: async ({ keys }) => {
    const ids = Object.keys(keys);
    let keyId = cachedKeyId;
    if (!keyId || !ids.includes(keyId)) {
      try {
        const def = await client.secretStorage.getDefaultKeyId();
        if (def && ids.includes(def)) keyId = def;
      } catch { /* fall through */ }
      if (!keyId && ids.length) keyId = ids[0];
    }
    if (!keyId) return null;
    cachedKeyId = keyId;
    try {
      return [keyId, decodeRecoveryKey(matrix.recoveryKey)];
    } catch (err) {
      console.error(`  recovery key failed to decode: ${err.message}`);
      return null;
    }
  },
};

try {
  step(`Target device: ${target}`);

  // Throwaway login so we never touch the bot's own token or device keys.
  const login = createClient({ baseUrl: matrix.homeserver });
  const session = await login.loginRequest({
    type: "m.login.password",
    identifier: { type: "m.id.user", user: matrix.userId.split(":")[0].replace(/^@/, "") },
    password: matrix.password,
    initial_device_display_name: "cross-sign (temporary)",
  });
  console.log(`  logged in as throwaway device ${session.device_id}`);

  client = createClient({
    baseUrl: matrix.homeserver,
    userId: matrix.userId,
    accessToken: session.access_token,
    deviceId: session.device_id,
    cryptoCallbacks,
  });

  await client.initRustCrypto({ useIndexedDB: false });
  const crypto = client.getCrypto();

  step("Starting sync");
  await client.startClient({ initialSyncLimit: 1 });
  await new Promise((res, rej) => {
    const deadline = Date.now() + 60_000;
    const check = () => {
      const s = client.getSyncState();
      // With a saved sync token the client goes straight to SYNCING and never
      // reports PREPARED, so treat either as ready.
      if (s === "PREPARED" || s === "SYNCING") return res();
      if (Date.now() > deadline) return rej(new Error(`sync stuck in state=${s}`));
      setTimeout(check, 300);
    };
    check();
  });
  console.log(`  sync ${client.getSyncState()}`);

  step("Checking secret storage BEFORE touching cross-signing");
  const defaultKeyId = await client.secretStorage.getDefaultKeyId();
  console.log(`  default 4S key id: ${defaultKeyId ?? "(none)"}`);
  if (!defaultKeyId) fail("No default secret-storage key on the account.");

  const selfSigning = await client.secretStorage.get("m.cross_signing.self_signing");
  console.log(`  self-signing key retrievable: ${Boolean(selfSigning)}`);
  if (!selfSigning) {
    fail(
      "Could not decrypt the existing self-signing key from secret storage.\n" +
      "  Refusing to continue: bootstrapCrossSigning could create a NEW identity\n" +
      "  and reset trust for every session. Check MATRIX_RECOVERY_KEY.",
    );
  }

  step("Loading existing cross-signing identity (no reset)");
  console.log(`  isCrossSigningReady before: ${await crypto.isCrossSigningReady()}`);
  await crypto.bootstrapCrossSigning({
    // setupNewCrossSigning intentionally omitted => defaults to false.
    authUploadDeviceSigningKeys: async (makeRequest) => {
      await makeRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: matrix.userId },
        password: matrix.password,
      });
    },
  });
  console.log(`  isCrossSigningReady after:  ${await crypto.isCrossSigningReady()}`);

  step(`Signing ${target}`);
  await crypto.crossSignDevice(target);

  step("Verifying on the server");
  const res = await client.http.authedRequest("POST", "/keys/query", undefined, {
    device_keys: { [matrix.userId]: [target] },
  });
  const sigs = Object.keys(
    res.device_keys?.[matrix.userId]?.[target]?.signatures?.[matrix.userId] ?? {},
  );
  const ssKeyId = Object.keys(res.self_signing_keys?.[matrix.userId]?.keys ?? {})[0];
  console.log(`  signatures now:   ${sigs.join(", ")}`);
  console.log(`  self-signing key: ${ssKeyId}`);
  const ok = sigs.includes(ssKeyId);
  console.log(ok ? "\nSUCCESS — device is cross-signed." : "\nSTILL UNSIGNED — signature did not land.");

  step("Cleaning up throwaway device");
  client.stopClient();
  await client.logout(true);
  console.log(`  logged out ${session.device_id}`);

  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error("\nFAILED:", err?.message ?? err);
  if (err?.stack) console.error(err.stack.split("\n").slice(1, 6).join("\n"));
  try {
    client?.stopClient();
    await client?.logout(true);
  } catch { /* ignore */ }
  process.exit(1);
}
