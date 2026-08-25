// Thin wrapper around matrix-js-sdk. Handles:
//   - Login (password or access token)
//   - E2EE (initRustCrypto + secret storage bootstrap with recovery key)
//   - Initial sync
//   - Timeline event subscription (post-decryption)
//   - Sending / editing messages with HTML formatted bodies
//
// The agent layer above should not import matrix-js-sdk directly.

import {
  createClient,
  ClientEvent,
  RoomEvent,
  MsgType,
} from "matrix-js-sdk";

import { BotState } from "./bot-state.js";

import { renderMarkdown, plainToHtml } from "./markdown.js";

export class MatrixBot {
  constructor(config, { logger = console } = {}) {
    this.config = config;
    this.log = logger;
    this.client = null;
    /** @type {Set<(ctx: MessageContext) => void>} */
    this.handlers = new Set();
    /** @type {Set<string>} event ids we have already emitted to handlers */
    this.handledEvents = new Set();
  }

  /** Register a function called for every incoming user message. */
  onMessage(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  async start() {
    const state = this.config.botState
      ? this.config.botState.load()
      : null;
    /** @type {string | undefined} */
    let cachedRecoveryKeyEncoded =
      this.config.recoveryKey || state?.recoveryKey;

    const opts = {
      baseUrl: this.config.homeserver,
      userId: this.config.userId,
    };
    if (state?.accessToken) {
      opts.accessToken = state.accessToken;
      opts.deviceId = state.deviceId;
    } else if (this.config.accessToken) {
      opts.accessToken = this.config.accessToken;
      opts.deviceId = process.env.MATRIX_DEVICE_ID || undefined;
    }

    // cryptoCallbacks must be passed at createClient time — the property is
    // captured by the constructor and ignored afterwards. The callback itself
    // closes over `cachedRecoveryKeyEncoded` and reads it lazily, so we can
    // update it later via the cacheSecretStorageKey hook.
    if (cachedRecoveryKeyEncoded) {
      let cachedKeyId = null;
      const { decodeRecoveryKey } = await import(
        "matrix-js-sdk/lib/crypto-api/recovery-key.js"
      );
      opts.cryptoCallbacks = {
        getSecretStorageKey: async ({ keys }) => {
          if (!cachedRecoveryKeyEncoded) return null;
          const ids = Object.keys(keys);
          let keyId = cachedKeyId;
          if (!keyId || !ids.includes(keyId)) {
            try {
              const def = await this.client.secretStorage.getDefaultKeyId();
              if (def && ids.includes(def)) keyId = def;
            } catch { /* fall through */ }
            if (!keyId && ids.length) keyId = ids[0];
          }
          if (!keyId) return null;
          cachedKeyId = keyId;
          return [keyId, decodeRecoveryKey(cachedRecoveryKeyEncoded)];
        },
        cacheSecretStorageKey: (keyId, _keyInfo, _key) => {
          cachedKeyId = keyId;
        },
      };
    }

    this.client = createClient(opts);

    if (this.config.password && !state?.accessToken) {
      this.log.info?.("Logging in via password…");
      const resp = await this.client.loginWithPassword(
        this.config.userId,
        this.config.password,
      );
      this.log.info?.(`Logged in as ${resp.user_id} (device ${resp.device_id})`);
      this.client.deviceId = resp.device_id;
      this.client.accessToken = resp.access_token;
      this.client.userId = resp.user_id;
      if (this.config.botState) {
        this.config.botState.save({
          accessToken: resp.access_token,
          deviceId: resp.device_id,
          userId: resp.user_id,
          recoveryKey: state?.recoveryKey || this.config.recoveryKey,
        });
      }
    } else {
      this.log.info?.(`Resuming with stored credentials (device ${opts.deviceId ?? "?"}).`);
    }

    // ---- E2EE setup ---------------------------------------------------
    this.log.info?.("Initializing crypto…");
    await this.client.initRustCrypto({ useIndexedDB: false });
    const cryptoApi = this.client.getCrypto();

    const isReady = await cryptoApi.isSecretStorageReady();
    if (!isReady) {
      this.log.info?.("Secret storage not set up — bootstrapping.");
      const generated = await cryptoApi.createRecoveryKeyFromPassphrase();
      cachedRecoveryKeyEncoded = generated.encodedPrivateKey;
      await cryptoApi.bootstrapSecretStorage({
        createSecretStorageKey: async () => generated,
        setupNewKeyBackup: true,
      });
      if (this.config.botState) {
        const cur = this.config.botState.load() ?? {};
        this.config.botState.save({
          ...cur,
          recoveryKey: generated.encodedPrivateKey,
        });
      }
      this.log.warn?.(
        "\n=========================================================\n" +
          "  GENERATED A NEW RECOVERY KEY. SAVE THIS:\n" +
          `  ${generated.encodedPrivateKey}\n` +
          "  Without it, you cannot read encrypted history on a fresh\n" +
          "  device or restore key backup. Stored at:\n" +
          `  ${this.config.botState?.path ?? "(no state file)"}\n` +
          "=========================================================\n",
      );
    } else {
      this.log.info?.("Secret storage already set up.");
    }

    // Try to load the key backup private key from secret storage. This is
    // what makes the key backup trusted and lets us decrypt messages from
    // before this device logged in.
    try {
      this.log.info?.("Loading key backup from secret storage…");
      await cryptoApi.loadSessionBackupPrivateKeyFromSecretStorage();
      this.log.info?.("Key backup private key loaded.");
    } catch (err) {
      this.log.warn?.(`Could not load key backup from secret storage: ${err?.message ?? err}`);
    }

    try {
      const check = await cryptoApi.checkKeyBackupAndEnable();
      if (check) {
        this.log.info?.(
          `Key backup check: trusted=${check.trustInfo?.trusted ?? "?"} ` +
          `matches=${check.trustInfo?.matches ?? "?"} version=${check.backupInfo?.version ?? "?"}`,
        );
      } else {
        this.log.warn?.("No key backup on server.");
      }
    } catch (err) {
      this.log.warn?.(`checkKeyBackupAndEnable failed: ${err?.message ?? err}`);
    }

    // Cross-sign our own device so other clients see it as verified and
    // share encryption keys with us. Without this, an unverified bot device
    // is treated as untrusted by clients like Firefox Element.
    try {
      const ready = await cryptoApi.isCrossSigningReady();
      this.log.info?.(`Cross-signing ready: ${ready}`);
      if (!ready) {
        this.log.info?.("Bootstrapping cross-signing from secret storage…");
        await cryptoApi.bootstrapCrossSigning({
          authUploadDeviceSigningKeys: async (makeRequest) => {
            this.log.info?.("Uploading cross-signing public keys (no auth needed).");
            await makeRequest({});
          },
        });
        this.log.info?.("Cross-signing bootstrapped.");
      }
      const deviceId = this.client.getDeviceId();
      if (deviceId) {
        await cryptoApi.crossSignDevice(deviceId);
        this.log.info?.(`Cross-signed our own device ${deviceId}.`);
      }
    } catch (err) {
      this.log.warn?.(`Cross-sign setup failed: ${err?.message ?? err}`);
    }
    // -------------------------------------------------------------------

    await this.client.startClient({ initialSyncLimit: 20 });

    this.client.on(ClientEvent.Sync, (state, _prev, data) => {
      if (state === "PREPARED") {
        this.log.info?.(`Sync ready. ${this.client.getRooms().length} rooms known.`);
        for (const room of this.client.getRooms()) {
          const members = room.getJoinedMemberCount?.() ?? "?";
          this.log.info?.(`  room ${room.roomId}  members=${members}  name=${JSON.stringify(room.name)}`);
        }
      } else if (state === "ERROR" || state === "RECONNECTING") {
        const err = data?.error;
        this.log.warn?.(`Sync state=${state}`, err?.message ?? "");
      }
    });

    // Auto-join rooms when invited, restricted to allowed senders.
    this.client.on(RoomEvent.MyMembership, async (room, membership) => {
      if (membership !== "invite") return;
      const myMember = room.getMember(this.client.getUserId());
      const inviter = myMember?.events?.member?.getSender?.();
      if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(inviter)) {
        this.log.warn?.(`Rejecting invite from ${inviter} (not in MATRIX_ALLOWED_USERS).`);
        try { await this.client.leave(room.roomId); } catch { /* ignore */ }
        return;
      }
      this.log.info?.(`Joining room ${room.roomId} (invited by ${inviter})`);
      try {
        await this.client.joinRoom(room.roomId);
      } catch (err) {
        this.log.warn?.(`Failed to join ${room.roomId}: ${err?.message ?? err}`);
      }
    });

    // Publish presence as "online" so other clients don't refuse to send
    // messages thinking we're offline.
    this.#publishPresence();
    setInterval(() => this.#publishPresence().catch(() => {}), 60_000);
    this.client.on(ClientEvent.Sync, (state) => {
      if (state === "PREPARED") this.#publishPresence().catch(() => {});
    });

    this.client.on(RoomEvent.Timeline, (event, room, toStartOfTimeline) => {
      const type = event.getType();
      const sender = event.getSender();
      const status = event.status;
      const isSelf = sender === this.client.getUserId();
      const eventId = event.getEventId();
      this.log.debug?.(
        `[timeline] room=${room.roomId} type=${type} sender=${sender} self=${isSelf} status=${status} backfill=${toStartOfTimeline} contentKeys=${Object.keys(event.getContent() || {}).join(",")}`,
      );
      if (toStartOfTimeline) return;
      if (type !== "m.room.message") return;
      if (isSelf) return;
      if (status && ["sending", "queued", "encrypting", "sending_failed"].includes(status)) {
        this.log.debug?.(`[timeline] skipping local-echo status=${status}`);
        return;
      }
      if (eventId && this.handledEvents.has(eventId)) {
        this.log.debug?.(`[timeline] already handled ${eventId}`);
        return;
      }
      // Skip events we can't decrypt yet. matrix-js-sdk will re-emit the
      // same event id once keys arrive (or via Event.decrypted); our dedupe
      // makes that safe.
      if (event.isDecryptionFailure?.()) {
        this.log.debug?.(`[timeline] decryption pending for ${eventId} (${event.decryptionFailureReason})`);
        return;
      }
      const ctx = this.#buildContext(event, room);
      if (!ctx) {
        this.log.debug?.(`[timeline] buildContext returned null`);
        return;
      }
      if (eventId) this.handledEvents.add(eventId);
      this.log.info?.(`[timeline] HANDLING message from ${sender} in ${room.roomId}: ${JSON.stringify(ctx.text)}`);
      for (const fn of this.handlers) {
        try {
          fn(ctx);
        } catch (err) {
          this.log.error?.("handler threw:", err);
        }
      }
    });

    return this;
  }

  #buildContext(event, room) {
    const content = event.getContent();
    if (content.msgtype !== MsgType.Text && content.msgtype !== MsgType.Notice) {
      return null;
    }
    const text = content.body || "";
    const formatted = content.format === "org.matrix.custom.html"
      ? content.formatted_body
      : null;
    return {
      roomId: room.roomId,
      sender: event.getSender(),
      eventId: event.getEventId(),
      text,
      formattedBody: formatted,
      raw: event,
      room,
      reply: async (payload) => this.#sendReply(room, event, payload),
      edit: async (payload) => this.#editMessage(room, event, payload),
    };
  }

  async #sendReply(room, event, payload) {
    if (typeof payload === "string") payload = { text: payload };
    const { text, html } = normalizePayload(payload);
    const content = {
      msgtype: MsgType.Text,
      body: text,
      format: "org.matrix.custom.html",
      formatted_body: html,
      "m.relates_to": {
        "m.in_reply_to": { event_id: event.getEventId() },
      },
    };
    return room.sendEvent("m.room.message", content);
  }

  async #editMessage(room, _origEvent, payload) {
    if (typeof payload === "string") payload = { text: payload };
    const { text, html } = normalizePayload(payload);
    throw new Error("edit() not implemented; use sendStream() for live updates");
  }

  /**
   * Send a message and return an object that lets you edit it in place.
   * @returns {Promise<{ eventId: string, update: (text: string) => Promise<void>, done: (text: string) => Promise<void> }>}
   */
  async sendStream(room, payload, { editThrottleMs = 400 } = {}) {
    if (typeof payload === "string") payload = { text: payload };
    const { text, html } = normalizePayload(payload);
    const resp = await this.client.sendEvent(room.roomId, "m.room.message", {
      msgtype: MsgType.Text,
      body: text,
      format: "org.matrix.custom.html",
      formatted_body: html,
    });
    const eventId = resp.event_id;
    let lastBody = text;
    let lastHtml = html;
    let timer = null;
    let pending = null;

    const doEdit = async (nextText, nextHtml) => {
      try {
        await this.client.sendEvent(room.roomId, "m.room.message", {
          msgtype: MsgType.Text,
          body: nextText,
          format: "org.matrix.custom.html",
          formatted_body: nextHtml,
          "m.relates_to": {
            rel_type: "m.replace",
            event_id: eventId,
          },
          "m.new_content": {
            msgtype: MsgType.Text,
            body: nextText,
            format: "org.matrix.custom.html",
            formatted_body: nextHtml,
          },
        });
      } catch (err) {
        this.log.warn?.(`edit failed for ${eventId}:`, err?.message ?? err);
      }
    };

    const update = async (next) => {
      if (typeof next === "string") next = { text: next };
      const { text: t, html: h } = normalizePayload(next);
      if (t === lastBody) return;
      lastBody = t; lastHtml = h;
      pending = { text: t, html: h };
      if (timer) return;
      timer = setTimeout(async () => {
        timer = null;
        const p = pending; pending = null;
        if (p) await doEdit(p.text, p.html);
      }, editThrottleMs);
    };

    const done = async (final) => {
      if (timer) { clearTimeout(timer); timer = null; }
      const f = typeof final === "string" ? final : (final?.text ?? lastBody);
      const fh = typeof final === "string"
        ? renderMarkdown(final)
        : (final?.html ?? lastHtml);
      await doEdit(f, fh);
    };

    return { eventId, update, done };
  }

  async #publishPresence() {
    try {
      await this.client.setPresence({ presence: "online", statusMessage: "tradebots-matrix" });
    } catch (err) {
      this.log.debug?.(`Failed to publish presence: ${err?.message ?? err}`);
    }
  }
}

function normalizePayload(payload) {
  if (typeof payload === "string") {
    return { text: payload, html: renderMarkdown(payload) };
  }
  const text = payload.text ?? "";
  const html = payload.html ?? renderMarkdown(text);
  return { text, html };
}
