// Entry point.
//
// Step 1 (this file): boots the Matrix bot and echoes back what you send,
// rendering any Markdown you give it. No agent yet — this proves the
// connection and the Markdown pipeline.
//
// Step 2 will replace `handleIncoming` with a call into the pi agent.

import { loadConfig } from "./config.js";
import { BotState } from "./bot-state.js";
import { MatrixBot } from "./matrix-client.js";
import { ClientEvent } from "matrix-js-sdk";

function makeLogger(level) {
  const order = ["debug", "info", "warn", "error"];
  const min = order.indexOf(level);
  const log = (lv) => (...args) => {
    if (order.indexOf(lv) >= min) console[lv === "debug" ? "log" : lv](`[${lv}]`, ...args);
  };
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
}

async function main() {
  const config = loadConfig();
  const log = makeLogger(config.logLevel);
  log.info("Config loaded. userId=", config.userId);

  const botState = new BotState(config.dataDir);
  const bot = new MatrixBot({ ...config, botState }, { logger: log });
  await bot.start();

  // Allowlist check
  function isAllowed(sender) {
    if (config.allowedUsers.length === 0) {
      log.warn(`Allowing ${sender} (MATRIX_ALLOWED_USERS is empty).`);
      return true;
    }
    return config.allowedUsers.includes(sender);
  }

  bot.onMessage(async (ctx) => {
    if (!isAllowed(ctx.sender)) {
      log.info(`Ignoring message from ${ctx.sender} (not allowed).`);
      return;
    }

    log.info(`< ${ctx.sender}: ${JSON.stringify(ctx.text)}`);

    // Step 1 echo: respond with the same text to verify markdown round-trip.
    // We'll use the streaming handle so we can also exercise edit-on-update.
    const stream = await bot.sendStream(ctx.room, {
      text: `Echo:\n\n${ctx.text}`,
    });
    // Briefly demo an update so you can see the edit-in-place path work.
    setTimeout(() => {
      stream.update(`Echo:\n\n${ctx.text}\n\n_(edited)_`).catch(() => {});
    }, 800);
  });

  // Proactive hello on startup: forces the bot to set up an outbound
  // Megolm session, which causes Element clients to push their key share
  // back. Without this, a fresh bot joining an encrypted room may sit
  // forever unable to decrypt anything sent to it before its own device
  // is known to the sender.
  bot.client.once(ClientEvent.Sync, async (state) => {
    if (state !== "PREPARED") return;
    for (const room of bot.client.getRooms()) {
      try {
        await bot.client.sendEvent(room.roomId, "m.room.message", {
          msgtype: "m.text",
          body: "👋 bot online",
        });
        log.info(`Sent hello to ${room.roomId}`);
      } catch (err) {
        log.warn(`Failed to send hello to ${room.roomId}: ${err.message}`);
      }
    }
  });

  log.info("Bot running. Send a message from an allowed user.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
