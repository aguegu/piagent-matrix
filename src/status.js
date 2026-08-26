// Status feedback: typing indicators and edit-in-place "live" messages.
//
// Both exist for the agent, where a reply can take tens of seconds and the room
// would otherwise sit silent. The echo path uses them too, so the machinery is
// exercised on every message rather than only once the agent lands.

import { LogService } from "matrix-bot-sdk";

/**
 * Show a typing indicator for as long as `fn` runs.
 *
 * Matrix typing notifications expire server-side, so a long task needs the
 * indicator refreshed. We re-assert well before the timeout and always clear it,
 * including on failure — a stuck "bot is typing…" is worse than none.
 */
export async function withTyping(client, roomId, fn, { timeoutMs = 20_000 } = {}) {
  const ping = () =>
    client.setTyping(roomId, true, timeoutMs).catch((err) => {
      LogService.debug("status", `setTyping failed in ${roomId}: ${err?.message ?? err}`);
    });

  await ping();
  const keepAlive = setInterval(ping, Math.floor(timeoutMs * 0.6));

  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
    await client.setTyping(roomId, false, 0).catch(() => {});
  }
}

/**
 * A message that can be edited in place after it is sent.
 *
 * Send a placeholder immediately so the room shows something, then replace its
 * content as results arrive. Edits are throttled: each one is a real event, and
 * an unthrottled token stream would flood the room.
 */
export class LiveMessage {
  #client;
  #roomId;
  #eventId;
  #lastSent;
  #pending = null;
  #timer = null;
  #throttleMs;

  constructor(client, roomId, eventId, initialText, throttleMs) {
    this.#client = client;
    this.#roomId = roomId;
    this.#eventId = eventId;
    this.#lastSent = initialText;
    this.#throttleMs = throttleMs;
  }

  static async send(client, roomId, text, { throttleMs = 1000 } = {}) {
    const eventId = await client.sendMessage(roomId, { msgtype: "m.text", body: text });
    return new LiveMessage(client, roomId, eventId, text, throttleMs);
  }

  get eventId() {
    return this.#eventId;
  }

  /** Queue new content. Coalesces: only the latest text survives the throttle window. */
  update(text) {
    if (text === this.#lastSent) return;
    this.#pending = text;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const next = this.#pending;
      this.#pending = null;
      if (next !== null) this.#flush(next).catch(() => {});
    }, this.#throttleMs);
  }

  /** Send the final content immediately, cancelling any queued edit. */
  async finish(text) {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pending = null;
    if (text === this.#lastSent) return;
    await this.#flush(text);
  }

  async #flush(text) {
    this.#lastSent = text;
    const content = {
      msgtype: "m.text",
      // Clients that don't understand edits show this fallback.
      body: `* ${text}`,
      "m.new_content": { msgtype: "m.text", body: text },
      "m.relates_to": { rel_type: "m.replace", event_id: this.#eventId },
    };

    try {
      // sendEvent() would encrypt the whole content, burying m.relates_to inside
      // the ciphertext — clients would then render this as a new message rather
      // than a replacement. The relation has to stay in cleartext, so encrypt
      // manually and re-attach it at the top level.
      if (await this.#client.crypto?.isRoomEncrypted(this.#roomId)) {
        const encrypted = await this.#client.crypto.encryptRoomEvent(
          this.#roomId,
          "m.room.message",
          content,
        );
        encrypted["m.relates_to"] = content["m.relates_to"];
        await this.#client.sendRawEvent(this.#roomId, "m.room.encrypted", encrypted);
      } else {
        await this.#client.sendRawEvent(this.#roomId, "m.room.message", content);
      }
    } catch (err) {
      LogService.warn("status", `edit failed for ${this.#eventId}: ${err?.message ?? err}`);
    }
  }
}
