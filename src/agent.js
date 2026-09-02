// AgentManager: thin wrapper that turns incoming Matrix messages into prompts
// for a pi AgentSession, one session per room, and posts a single clean reply
// to the room when the run finishes.
//
// Design notes (from docs/pi-integration.md):
//   * `model.provider`, never `providerId` (v1 silently fell through).
//   * Cache the createAgentSession PROMISE per room — two messages arriving
//     back-to-back must not both spawn a session and clobber each other.
//   * NO edit-in-place. An earlier build streamed into a LiveMessage and let
//     Element render the reply with an "(edited)" marker, which the user
//     disliked. The typing indicator is the accepted progress signal: we
//     buffer everything in memory, then send one m.room.message when the run
//     ends. Tool-call status lines are still surfaced inline so a long tool
//     run is visible in the final answer.

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LogService } from "matrix-bot-sdk";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import {
  calculateContextTokens,
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Beyond this many messages waiting on one room we start refusing, rather than
// letting a burst build an unbounded backlog the sender has no visibility into.
const MAX_QUEUED_PER_ROOM = 8;

export class AgentManager {
  /** @param {{ model?: string, thinkingLevel?: string, cwd: string, createSession?: Function }} opts */
  constructor(opts) {
    this.opts = opts;
    // Seam for tests: swap in a fake session factory.
    this.createSession = opts.createSession ?? createAgentSession;
    // Absolute, or null to fall back to pi's own default (~/.pi/agent).
    this.agentDir = opts.agentDir ? resolve(opts.agentDir) : null;
    // Extensions ask pi where the agent directory is, via its exported
    // getAgentDir(), which reads this variable and otherwise answers
    // ~/.pi/agent. Passing agentDir to createAgentSession steers pi's own
    // loading but not that call, so an extension would read and write the
    // operator's home directory while the session ran out of ours — the bot's
    // credentials in one place, an extension's state in another, and neither
    // travelling with a container. Set it so both agree.
    if (this.agentDir) process.env.PI_CODING_AGENT_DIR = this.agentDir;
    // `.model` and `.thinking` record their choices here so they survive a
    // restart; that is the point of those commands, and why neither setting is
    // configured anywhere else.
    this.stateFile = opts.stateFile ? resolve(opts.stateFile) : null;
    /** @type {Map<string, Promise<import('@earendil-works/pi-coding-agent').AgentSession>>} */
    this.sessions = new Map();
    /** What actually loaded, once a session has been created. */
    this.extensions = null;
    /** Per-room tail of the run chain, so prompts never overlap. @type {Map<string, Promise<void>>} */
    this.chains = new Map();
    /** Per-room count of messages queued or running. @type {Map<string, number>} */
    this.pending = new Map();
    /** Rooms already told where they are. @type {Set<string>} */
    this.briefed = new Set();
    /**
     * Tokens the last reply in each room carried, by pi's own reckoning.
     *
     * Nothing surfaced this, so a room could reach 430,000 tokens a turn
     * unnoticed — every turn resending the lot, against a plan measured in
     * tokens. @type {Map<string, number>}
     */
    this.contextTokens = new Map();
    /** @type {import('@earendil-works/pi-coding-agent').ModelRuntime | null} */
    this.runtime = null;
    /** @type {import('@earendil-works/pi-coding-agent').Model<any> | null} */
    this.model = null;
  }

  /** Lazily initialize ModelRuntime + pick a model. Called on first message. */
  async #ensureModel() {
    if (this.model) return;

    // Keep pi's credentials with the bot rather than in ~/.pi/agent, so the bot
    // does not depend on whoever happens to be running it having logged into pi.
    const agentDir = this.agentDir;
    if (agentDir) mkdirSync(agentDir, { recursive: true });

    LogService.info("agent", `Initializing ModelRuntime (agentDir=${agentDir ?? "pi default"})...`);
    this.runtime = await ModelRuntime.create(
      agentDir
        ? {
            authPath: resolve(agentDir, "auth.json"),
            modelsStorePath: resolve(agentDir, "models-store.json"),
          }
        : undefined,
    );

    const available = await this.runtime.getAvailable();
    if (available.length === 0) {
      throw new Error(describeMissingAuth(agentDir));
    }

    // Precedence: a choice recorded by `.model`, then opts.model, then whatever
    // is first available.
    const recorded = this.#readState().model;
    const want = recorded || this.opts.model;
    if (want) {
      const hit = matchModel(available, want);
      if (hit) {
        this.model = hit;
      } else {
        LogService.warn(
          "agent",
          `${recorded ? "Recorded" : "Requested"} model ${want} not available. Falling back. ` +
            `Available: ${available.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
        );
      }
    }
    if (!this.model) {
      this.model = available[0];
    }

    LogService.info(
      "agent",
      `Using model ${this.model.provider}/${this.model.id}` +
        ` (thinkingLevel=${this.#thinkingLevel()})`,
    );
  }

  /**
   * Context prepended to the first prompt of each room's session.
   *
   * Only the outbox is offered as a send mechanism. The agent must not open its
   * own Matrix client: two processes sharing the crypto store desynchronise the
   * Megolm ratchet and produce messages strict clients refuse to decrypt.
   */
  /**
   * The context block in front of an ordinary message.
   *
   * The sender goes on every turn, because it changes between turns and the
   * agent has no other way to see it. Without this it filled the gap with
   * whoever it usually talks to: asked whether a message came from another bot,
   * it answered "still @aguegu on my side" three times, having been told
   * nothing either way.
   *
   * The room id only needs saying once — it is the same for the whole session.
   */
  #preamble(roomId, sender, roomName, missed = []) {
    const lines = ["[context]", `This message is from ${sender}.`];
    if (missed.length) {
      // Said in the room while the bot was not replying — see src/loop-guard.js.
      // Included so the agent's view of the conversation matches everyone
      // else's; it was not answered, but it was not unheard either.
      lines.push(`Also said since you last replied, which you did not answer:`);
      for (const m of missed) lines.push(`  ${m.sender}: ${m.body.replace(/\s+/g, " ")}`);
    }
    if (!this.briefed.has(roomId)) {
      const where = roomName ? `"${roomName}" (${roomId})` : roomId;
      lines.push(`You are replying in Matrix room ${where}. "here" and "this room" mean that room id.`);
      if (roomName) lines.push("A room can be renamed; the id cannot, so address anything by id.");
    }
    lines.push("[/context]", "");
    return lines.join("\n");
  }

  /** A choice recorded by `.thinking` first, then opts, then "low". */
  #thinkingLevel() {
    const want = String(this.#readState().thinkingLevel || this.opts.thinkingLevel || "low").toLowerCase();
    return THINKING_LEVELS.includes(want) ? want : "low";
  }

  /**
   * What the last reply in a room carried, against the model's window.
   *
   * `tokens` is null until a reply lands: the count comes from the provider's
   * own usage, and a restart starts again knowing nothing.
   */
  describeContext(roomId) {
    return {
      tokens: this.contextTokens.get(roomId) ?? null,
      window: this.model?.contextWindow ?? 0,
    };
  }

  /** The thinking level in use for a room, and the levels on offer. */
  async describeThinking(roomId) {
    const session = this.sessions.has(roomId) ? await this.sessions.get(roomId) : null;
    return {
      current: session?.thinkingLevel ?? this.#thinkingLevel(),
      live: Boolean(session),
      levels: [...THINKING_LEVELS],
    };
  }

  /**
   * Set the thinking level, as pi's `/thinking <level>` does, and remember it.
   *
   * Applies to every live session and is recorded, so it holds across restarts
   * rather than reverting to the startup default.
   */
  async setThinkingLevel(level) {
    const want = String(level ?? "").trim().toLowerCase();
    if (!THINKING_LEVELS.includes(want)) {
      return { ok: false, levels: [...THINKING_LEVELS] };
    }
    let applied = 0;
    for (const [roomId, pending] of this.sessions) {
      try {
        (await pending).setThinkingLevel(want);
        applied += 1;
      } catch (err) {
        LogService.warn("agent", `setThinkingLevel failed for ${roomId}: ${err?.message ?? err}`);
      }
    }
    this.#writeState({ thinkingLevel: want });
    LogService.info("agent", `Thinking level set to ${want} (${applied} live session(s)).`);
    return { ok: true, level: want, applied };
  }

  /**
   * Get or create the session for a room. Returns the same promise on concurrent
   * calls so two near-simultaneous messages share one session.
   *
   * When `opts.sessionDir` is set, the session is loaded from / saved to
   * `${sessionDir}/${roomId}/` so conversation memory survives bot restarts.
   * Otherwise the session lives in memory only.
   * @param {string} roomId
   */
  #getOrCreateSession(roomId) {
    let p = this.sessions.get(roomId);
    if (p) return p;

    p = (async () => {
      await this.#ensureModel();
      const sessionManager = this.#buildSessionManager(roomId);
      const result = await this.createSession({
        cwd: this.opts.cwd,
        // Settings, extensions and skills load from here too, not from ~/.pi.
        ...(this.agentDir ? { agentDir: this.agentDir } : {}),
        sessionManager,
        modelRuntime: this.runtime,
        model: this.model,
        thinkingLevel: this.#thinkingLevel(),
      });
      if (result.modelFallbackMessage) {
        LogService.warn("agent", `model fallback: ${result.modelFallbackMessage}`);
      }

      // Extensions come from settings.json in agentDir, installed with
      // `pi install`. Report what loaded: otherwise there is no way to tell an
      // extension is active short of asking the agent to use it, and a failed
      // load is silent.
      const loaded = result.extensionsResult?.extensions ?? [];
      const failed = result.extensionsResult?.errors ?? [];
      // Kept so `.info` can report what is actually running rather than what
      // settings.json asks for. Two bots comparing notes found their skill
      // directories equally empty and concluded they matched, while one had
      // pi-web-access and the other had nothing.
      this.extensions = {
        names: loaded.map(extensionName),
        failed: failed.map(extensionName),
      };
      if (loaded.length) {
        LogService.info("agent", `Extensions loaded: ${loaded.map(extensionName).join(", ")}`);
      }
      for (const e of failed) {
        LogService.error("agent", `Extension failed to load (${e.path}): ${e.error}`);
      }
      const persisted = this.opts.sessionDir ? "persistent" : "in-memory";
      LogService.info("agent", `Created ${persisted} agent session for room ${roomId}`);
      return result.session;
    })();
    this.sessions.set(roomId, p);

    // Cache the promise so concurrent messages share one session — but only
    // while it succeeds. A rejected promise left in the map is replayed to
    // every later message, so a room that failed once (no provider configured,
    // say) keeps reporting that first error even after the cause is fixed, and
    // only a restart clears it. Evict on failure so the next message retries.
    p.catch(() => {
      if (this.sessions.get(roomId) === p) this.sessions.delete(roomId);
    });

    return p;
  }

  /**
   * Pick a SessionManager appropriate for the current configuration.
   * Without a sessionDir we get fresh in-memory state on every bot restart.
   * With a sessionDir we resume the most recent session per room, or start
   * a new one if none exists yet.
   */
  #buildSessionManager(roomId) {
    if (!this.opts.sessionDir) {
      return SessionManager.inMemory(this.opts.cwd);
    }
    // One subdirectory per room keeps conversations isolated and makes it
    // obvious where each room's session lives on disk.
    const roomDir = resolve(this.opts.sessionDir, encodeRoomId(roomId));
    mkdirSync(roomDir, { recursive: true });
    return SessionManager.continueRecent(this.opts.cwd, roomDir);
  }

  /**
   * Handle one incoming Matrix message.
   *
   * Buffers the agent's response in memory and sends a single, non-edited
   * m.room.message when the run finishes. Long tool runs are made visible
   * via inline `⏺ <tool>(args)  ✓` lines above the answer text.
   *
   * @param {object} ctx
   * @param {string} ctx.roomId
   * @param {string} ctx.text
   * @param {string} ctx.sender
   * @param {{sender: string, body: string}[]} [ctx.missed]  said but not answered
   * @param {import('matrix-bot-sdk').MatrixClient} ctx.client
   */
  async handleMessage(ctx) {
    const { roomId } = ctx;

    const depth = this.pending.get(roomId) ?? 0;
    if (depth >= MAX_QUEUED_PER_ROOM) {
      LogService.warn("agent", `queue full for ${roomId} (${depth}); dropping message`);
      await this.#post(ctx.client, roomId, `_Still working through ${depth} earlier message(s) — this one was dropped. Try again shortly._`);
      return;
    }
    this.pending.set(roomId, depth + 1);

    const mine = this.#onTurn(roomId, () => this.#runPrompt(ctx));

    try {
      return await mine;
    } finally {
      this.pending.set(roomId, Math.max(0, (this.pending.get(roomId) ?? 1) - 1));
    }
  }

  /**
   * Run `work` when the room's turn comes, and hand back what it returns.
   *
   * Serializes per room. pi's prompt() does NOT run a second prompt while the
   * session is streaming: it queues via followUp and returns *immediately*, so
   * a caller that then renders its buffer renders nothing, while its text
   * silently lands in the previous run's output. Waiting for our turn means
   * every prompt owns a complete run.
   *
   * Compaction shares the queue rather than having one of its own: pi refuses a
   * prompt while compaction is running, and compaction aborts whatever the
   * agent is doing, so the two must never overlap.
   */
  #onTurn(roomId, work) {
    const prev = this.chains.get(roomId) ?? Promise.resolve();
    const mine = prev.then(work, work); // a failed predecessor must not block the queue
    this.chains.set(roomId, mine.then(() => {}, () => {}));
    return mine;
  }

  /**
   * Compact one room's session: pi summarises the history and keeps the tail,
   * so the conversation carries fewer tokens into each subsequent run.
   *
   * Scoped to a room because a session is. A room with nothing recorded has
   * nothing to shed, and opening a session there just to compact it would be
   * worse than saying so — but a restart empties the map while the history
   * stays on disk, so a live session is not what makes a room compactable.
   */
  async compact(roomId) {
    if (!this.sessions.has(roomId) && !this.#hasHistory(roomId)) return { compacted: false };
    return this.#onTurn(roomId, async () => {
      // Resumes the recorded session when the map is cold, which after a
      // restart is exactly the room long enough to want compacting.
      const session = await this.#getOrCreateSession(roomId);
      LogService.info("agent", `compacting ${roomId}`);
      const result = await session.compact();
      const before = result?.tokensBefore;
      const after = result?.estimatedTokensAfter;
      // So `.info` straight after `.compact` shows what the room now carries
      // rather than what it carried before.
      if (typeof after === "number") this.contextTokens.set(roomId, after);
      LogService.info("agent", `compacted ${roomId}: ${before ?? "?"} -> ${after ?? "?"} tokens`);
      return { compacted: true, before, after };
    });
  }

  /**
   * Whether a room has a session recorded on disk.
   *
   * `sessions` holds what is live in this process, which a restart empties
   * while the transcripts stay where they were. Reading the directory is how
   * the two are told apart.
   */
  #hasHistory(roomId) {
    if (!this.opts.sessionDir) return false;
    try {
      const dir = resolve(this.opts.sessionDir, encodeRoomId(roomId));
      return readdirSync(dir).some((f) => f.endsWith(".jsonl"));
    } catch {
      // No directory, or unreadable: nothing to resume either way.
      return false;
    }
  }

  /** Run exactly one prompt to completion. Callers must hold the room's turn. */
  async #runPrompt({ roomId, text, sender, missed = [], client }) {
    LogService.info("agent", `→ ${sender} in ${roomId}: ${JSON.stringify(text)}`);

    const session = await this.#getOrCreateSession(roomId);

    // Belt and braces: if anything still has the session streaming, prompting
    // now would hit the queue-and-return path this serialization exists to
    // avoid. Wait it out rather than emit a silent no-op.
    await waitUntilIdle(session);

    // Accumulate locally — never post anything until the run is done.
    //
    // Blocks, not a single string: one run emits several assistant messages
    // around each tool call, and each message's `partial` covers only itself.
    // Assigning would keep just the last one and silently drop the prose in
    // between. Recording blocks in event order also lets tool lines sit where
    // they actually happened rather than being bunched at the top.
    const buffer = { blocks: [], failure: null };

    const unsub = session.subscribe((event) => this.#onEvent(event, buffer));

    // The agent is otherwise given only the message text, so it has no way to
    // know which room it is in — "post this here" or "set up a cron that
    // reports here" are unanswerable. Tell it once per session, along with the
    // one mechanism it can actually use to send something later.
    //
    // Never in front of a leading slash: pi expands prompt templates and skill
    // commands only when the text starts with "/", so a prefix here would turn
    // `/whoami` into an ordinary message. Such a turn carries no context at
    // all — not even the sender — which is why AGENTS.md tells the agent it is
    // sometimes not told, rather than to expect it.
    const isSlashCommand = text.startsWith("/");
    let prompt = text;
    if (!isSlashCommand) {
      // Only worth fetching for the turn that names the room.
      const roomName = this.briefed.has(roomId) ? "" : await roomDisplayName(client, roomId);
      prompt = this.#preamble(roomId, sender, roomName, missed) + text;
      this.briefed.add(roomId);
    }

    try {
      await session.prompt(prompt, { streamingBehavior: "followUp" });
    } catch (err) {
      LogService.error("agent", `prompt failed in ${roomId}: ${err?.message ?? err}`);
      const note = `⚠️ ${err?.message ?? String(err)}`;
      const body = renderReply(buffer) + `\n\n_${note}_`;
      const html = renderReplyHtml(buffer) + `<p><em>${escapeHtml(note)}</em></p>`;
      await this.#post(client, roomId, body, html);
      throw err;
    } finally {
      unsub();
    }

    if (buffer.contextTokens) this.contextTokens.set(roomId, buffer.contextTokens);

    const body = renderReply(buffer);

    // Checked before the silence path, not after: a failed run produces the
    // same empty buffer as a chosen silence, and reporting one as the other is
    // how a quota limit came to look like the bot ignoring the room.
    if (buffer.failure) {
      const detail = describeApiError(buffer.failure.message);
      const attempts = buffer.failure.attempts > 1 ? ` after ${buffer.failure.attempts} attempts` : "";
      LogService.error("agent", `run in ${roomId} failed${attempts}: ${detail}`);
      const silent = isSilence(body);
      const note = `⚠️ ${silent ? "No reply" : "Cut short"} — the model provider failed${attempts}: ${detail}`;
      if (silent) {
        await this.#post(client, roomId, note);
      } else {
        await this.#post(
          client,
          roomId,
          `${body}\n\n_${note}_`,
          renderReplyHtml(buffer) + `<p><em>${escapeHtml(note)}</em></p>`,
        );
      }
      return;
    }

    if (isSilence(body)) {
      // A normal outcome, not a failure: AGENTS.md tells the agent that silence
      // is a reply, which is what keeps it out of a conversation between other
      // people.
      LogService.info("agent", `run in ${roomId} said nothing`);
      return;
    }
    await this.#post(client, roomId, body, renderReplyHtml(buffer));
  }

  /** @param {any} event */
  #onEvent(event, buffer) {
    switch (event.type) {
      case "message_update": {
        const sub = event.assistantMessageEvent;
        if (sub.type === "text_delta") {
          // Deltas restate the whole message, so replace the open block rather
          // than concatenating — but only the block belonging to this message.
          openTextBlock(buffer).text = extractText(sub.partial);
        } else if (sub.type === "thinking_delta") {
          // Internal reasoning — not surfaced.
        }
        break;
      }
      case "tool_execution_start": {
        buffer.blocks.push({
          type: "tool",
          text: `⏺ ${event.toolName}(${summarizeArgs(event.args)})`,
          done: false,
        });
        break;
      }
      case "tool_execution_end": {
        // Match the most recent unfinished tool block; tools can nest or
        // overlap, so the last one is not necessarily the right one.
        for (let i = buffer.blocks.length - 1; i >= 0; i--) {
          const b = buffer.blocks[i];
          if (b.type === "tool" && !b.done) {
            b.text += event.isError ? "  ✗" : "  ✓";
            b.done = true;
            break;
          }
        }
        break;
      }
      case "message_end": {
        // Seal this message's text block so the next message opens a new one.
        if (event.message?.role === "assistant") {
          const block = openTextBlock(buffer);
          block.text = extractText(event.message);
          block.done = true;
          // pi records an API failure on the message and then resolves the
          // prompt, so the caller's catch never sees it. Without this the
          // buffer is merely empty — which is also how the agent declines to
          // speak, so a run that never reached the model would be posted as a
          // deliberate silence.
          // Zero usage is what an errored turn reports; recording it would
          // wipe a real measurement with a number that means "no reply".
          const tokens = event.message.usage ? calculateContextTokens(event.message.usage) : 0;
          if (tokens > 0) buffer.contextTokens = tokens;
          if (event.message.stopReason === "error") {
            const attempts = (buffer.failure?.attempts ?? 0) + 1;
            buffer.failure = { message: event.message.errorMessage, attempts };
          } else {
            // A later attempt succeeded, so the earlier failure is history.
            buffer.failure = null;
          }
        }
        break;
      }
      case "auto_retry_start": {
        // Only for the count and the reason: pi retries internally, and if one
        // of those attempts succeeds the message_end above clears this again.
        buffer.failure = {
          message: event.errorMessage,
          attempts: event.attempt ?? (buffer.failure?.attempts ?? 0) + 1,
        };
        break;
      }
      case "auto_retry_end": {
        if (event.success) buffer.failure = null;
        else if (event.finalError) {
          buffer.failure = {
            message: event.finalError,
            attempts: event.attempt ?? buffer.failure?.attempts ?? 1,
          };
        }
        break;
      }
      default:
        break;
    }
  }

  async #post(client, roomId, body, html = null) {
    try {
      const content = { msgtype: "m.notice", body };
      // Fall back to treating the body itself as markdown for simple notices.
      const formatted = html ?? renderMarkdown(body);
      if (formatted && formatted !== body) {
        content.format = "org.matrix.custom.html";
        content.formatted_body = formatted;
      }
      await client.sendMessage(roomId, content);
    } catch (err) {
      LogService.error("agent", `sendMessage failed in ${roomId}: ${err?.message ?? err}`);
    }
  }

  /**
   * The extensions this bot is running, as far as it can know.
   *
   * Once a session exists, what actually initialised. Before that, what
   * `settings.json` asks for — marked as such, because configured is not the
   * same as loaded and the difference is exactly what goes wrong.
   *
   * @returns {{ names: string[], failed: string[], live: boolean }}
   */
  describeExtensions() {
    if (this.extensions) return { ...this.extensions, live: true };
    return { names: this.#configuredPackages(), failed: [], live: false };
  }

  /** `packages` from settings.json, named the way a person would say them. */
  #configuredPackages() {
    if (!this.agentDir) return [];
    try {
      const settings = JSON.parse(readFileSync(resolve(this.agentDir, "settings.json"), "utf8"));
      const packages = Array.isArray(settings?.packages) ? settings.packages : [];
      return packages.map((p) => String(p).replace(/^npm:/, ""));
    } catch {
      return [];
    }
  }

  /**
   * The model in use for a room, and everything available.
   *
   * A room never messaged has no session yet, so it reports the manager's
   * default — what the next session would start with.
   */
  async describeModel(roomId) {
    await this.#ensureModel();
    const available = [...(await this.runtime.getAvailable())];
    const session = this.sessions.has(roomId) ? await this.sessions.get(roomId) : null;
    const current = session?.model ?? this.model;
    return {
      current: current ? `${current.provider}/${current.id}` : "(none)",
      live: Boolean(session),
      available: available.map((m) => `${m.provider}/${m.id}`),
    };
  }

  /**
   * Switch the model, as pi's `/model <provider/model>` does, and remember it.
   *
   * Applies to every live session and to any created later, and is recorded so
   * it survives a restart — this is how the model is configured, not a per-room
   * override that quietly reverts.
   *
   * @returns {Promise<{ ok: boolean, model?: string, applied?: number, available?: string[] }>}
   */
  async setModel(want) {
    await this.#ensureModel();
    const available = [...(await this.runtime.getAvailable())];
    const hit = matchModel(available, want);
    if (!hit) {
      return { ok: false, available: available.map((m) => `${m.provider}/${m.id}`) };
    }

    this.model = hit;
    let applied = 0;
    for (const [roomId, pending] of this.sessions) {
      try {
        const session = await pending;
        await session.setModel(hit);
        applied += 1;
      } catch (err) {
        LogService.warn("agent", `setModel failed for ${roomId}: ${err?.message ?? err}`);
      }
    }
    this.#writeState({ model: `${hit.provider}/${hit.id}` });
    LogService.info("agent", `Model set to ${hit.provider}/${hit.id} (${applied} live session(s)).`);
    return { ok: true, model: `${hit.provider}/${hit.id}`, applied };
  }

  /** Recorded choices, or an empty object when nothing has been set yet. */
  #readState() {
    if (!this.stateFile) return {};
    try {
      const saved = JSON.parse(readFileSync(this.stateFile, "utf8"));
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  }

  /** Merge a change into the recorded state. */
  #writeState(patch) {
    if (!this.stateFile) return;
    try {
      const next = { ...this.#readState(), ...patch };
      mkdirSync(dirname(this.stateFile), { recursive: true });
      // Write-then-rename so a crash cannot leave a half-written record.
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(tmp, this.stateFile);
    } catch (err) {
      // Not fatal: the change still applies to this process, it just will not
      // survive a restart.
      LogService.warn("agent", `Could not record agent state: ${err?.message ?? err}`);
    }
  }

  /**
   * pi's `/reload`, applied to every live session.
   *
   * `AgentSession.reload()` re-reads keybindings, extensions, skills, prompts,
   * themes and context files in place, keeping the session and its history.
   * Those resources are read when a session is created, so without this a
   * running bot keeps whatever was installed at its first message.
   *
   * Every room is reloaded, not just the one asking: extensions and prompts
   * live in `PI_AGENT_DIR` and are shared, so reloading one room would leave
   * the rest stale.
   *
   * @returns {Promise<{ reloaded: number, failed: Array<{ roomId: string, error: string }> }>}
   */
  async reload() {
    const failed = [];
    let reloaded = 0;
    for (const [roomId, pending] of this.sessions) {
      try {
        const session = await pending;
        await session.reload();
        reloaded += 1;
      } catch (err) {
        failed.push({ roomId, error: err?.message ?? String(err) });
        LogService.error("agent", `reload failed for ${roomId}: ${err?.message ?? err}`);
      }
    }
    LogService.info("agent", `Reloaded ${reloaded} session(s)${failed.length ? `, ${failed.length} failed` : ""}.`);
    return { reloaded, failed };
  }

  /** Stop tracking a room (e.g., on shutdown). */
  /**
   * Drop one room's session, for a room the bot is leaving.
   *
   * Sessions are cached for the process lifetime, so a room the bot has walked
   * out of would otherwise hold one until shutdown. Nothing is lost that was
   * not already lost: with sessionDir set the conversation is on disk and
   * resumes if the bot is invited back.
   *
   * @returns {Promise<boolean>} true if there was a session to drop
   */
  async disposeRoom(roomId) {
    const pending = this.sessions.get(roomId);
    this.briefed.delete(roomId);
    if (!pending) return false;
    this.sessions.delete(roomId);
    try {
      (await pending).dispose();
    } catch {
      /* never finished being created, or already gone */
    }
    return true;
  }

  async dispose() {
    for (const p of this.sessions.values()) {
      try {
        const s = await p;
        s.dispose();
      } catch {
        /* ignore — session may not have been created yet */
      }
    }
    this.sessions.clear();
  }
}

/**
 * A readable name for a loaded extension.
 *
 * pi reports a path where an extension declares no name of its own, and that
 * path is the whole install location — so the useful part is the package it
 * came from, scope included.
 */
export function extensionName(e) {
  if (e?.name) return String(e.name);
  const path = String(e?.path ?? "");
  const at = path.lastIndexOf("node_modules/");
  if (at < 0) return path || "?";
  const parts = path.slice(at + "node_modules/".length).split("/");
  return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * A room's name, flattened to something safe to put in a prompt.
 *
 * Whoever made the room chose it, and it lands inside the [context] block — so
 * a name carrying a newline or a bracket could forge the end of that block and
 * have the rest read as instruction rather than as a room's name. Brackets go,
 * whitespace collapses to single spaces, and the result is short.
 *
 * Returns "" for an unnamed room, which 404s, and for any other failure: a
 * missing name costs a little context, and nothing else.
 */
async function roomDisplayName(client, roomId) {
  try {
    const event = await client.getRoomStateEvent(roomId, "m.room.name", "");
    const raw = typeof event?.name === "string" ? event.name : "";
    return raw.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  } catch {
    return "";
  }
}

/**
 * The provider's error, short enough to put in a room.
 *
 * pi hands over the transport's raw string: a status code, then whatever JSON
 * the provider sent, then a request id. The status and the provider's own
 * sentence are the useful parts — a reader wants "quota exhausted", not an
 * envelope. Anything that does not parse is passed through, truncated, on the
 * grounds that an ugly message beats no message.
 */
export function describeApiError(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "no reason given";
  const status = text.match(/^(\d{3})\b/)?.[1] ?? "";
  const at = text.indexOf("{");
  if (at >= 0) {
    try {
      const parsed = JSON.parse(text.slice(at));
      const err = parsed?.error ?? parsed;
      if (typeof err?.message === "string" && err.message) {
        const label = [status, err.type].filter(Boolean).join(" ");
        return label ? `${label}: ${err.message}` : err.message;
      }
    } catch {
      // Not JSON after all; the raw text below is the best we have.
    }
  }
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Whether a finished run amounts to saying nothing.
 *
 * Empty is the obvious case. A lone full stop is the other: a model cannot
 * literally emit nothing — it has to end its turn somehow — so AGENTS.md asks
 * for "." and this drops it. Told instead to "produce no text at all", one ran
 * `bash true` twice looking for a way to do nothing, then sent "." anyway,
 * which went to the room because it is not empty.
 */
function isSilence(body) {
  // Punctuation and nothing else. The instruction asks for one `.`, and models
  // variously send `..`, `. .` or an ellipsis; a body with no letters in it
  // carries nothing either way. It does not rescue a reply that explains the
  // silence in words — that one is a message, and only AGENTS.md can prevent it.
  return /^[.。·…\s]*$/.test(body.trim());
}

/**
 * Wait for a session to stop streaming, so the next prompt starts a real run
 * instead of being queued as a follow-up. Bounded: if it never settles we go
 * ahead anyway rather than wedging the room forever.
 */
async function waitUntilIdle(session, timeoutMs = 120_000) {
  if (!session.isStreaming) return;
  LogService.warn("agent", "session still streaming at turn start; waiting for it to settle");
  const deadline = Date.now() + timeoutMs;
  while (session.isStreaming && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (session.isStreaming) {
    LogService.error("agent", `session still streaming after ${timeoutMs}ms; prompting anyway`);
  }
}

/**
 * Resolve "provider/id" or a bare "id" against the available models.
 *
 * A bare id matches on id alone. PI_PROVIDER used to break the tie, back when
 * the model came from the environment and an interactive `pi` run exports the
 * two halves separately — but the model is typed into a room now, so letting a
 * shell export steer what a chat message resolves to is influence nobody can
 * see. `.model` reports the full provider/id it settled on.
 *
 * Returns null when nothing matches, leaving the caller to decide whether that
 * is a warning or an error.
 */
function matchModel(available, want) {
  if (!want) return null;
  let provider = null;
  let id = String(want).trim();
  if (id.includes("/")) {
    const [p, ...rest] = id.split("/");
    provider = p;
    id = rest.join("/");
  }
  const exact = available.find((m) => m.id === id && (!provider || m.provider === provider));
  if (exact) return exact;
  // Model ids are typed by hand here, so fall back to a case-insensitive match.
  return (
    available.find(
      (m) =>
        m.id.toLowerCase() === id.toLowerCase() &&
        (!provider || m.provider.toLowerCase() === provider.toLowerCase()),
    ) ?? null
  );
}

/** The trailing text block for the message currently streaming, creating it if needed. */
function openTextBlock(buffer) {
  const last = buffer.blocks[buffer.blocks.length - 1];
  if (last && last.type === "text" && !last.done) return last;
  const block = { type: "text", text: "", done: false };
  buffer.blocks.push(block);
  return block;
}

/**
 * Blocks in the order they happened. Consecutive tool lines stay tight
 * together; anything else gets a blank line so prose and tool traces read as
 * separate paragraphs.
 */
/**
 * Explain *why* no provider resolved, based on what is actually on disk.
 *
 * Both pi and ModelRuntime.create() write an empty `{}` auth.json the moment
 * they start, so the file existing proves nothing — an operator who launches pi
 * and exits sees auth.json appear and reasonably concludes they logged in. The
 * three states need three different fixes, so name which one it is.
 */
function describeMissingAuth(agentDir) {
  const dir = agentDir ?? "~/.pi/agent";
  const authPath = agentDir ? resolve(agentDir, "auth.json") : "~/.pi/agent/auth.json";

  let state = "missing";
  let providers = [];
  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    providers = Object.keys(parsed ?? {});
    state = providers.length ? "populated" : "empty";
  } catch {
    state = "missing";
  }

  const detail =
    state === "populated"
      ? `${authPath} has credentials for ${providers.join(", ")}, but none are usable — ` +
        `they may be expired, incomplete, or for a provider with no available models.`
      : state === "empty"
        ? `${authPath} exists but is empty ({}). Both pi and this bot create that file on ` +
          `startup, so its presence does not mean a login succeeded — a credential only ` +
          `lands after a /login completes.`
        : `No auth.json in ${dir}.`;

  return (
    `No models with complete auth are available in ${dir}. ${detail}\n` +
    `Fix it either way:\n` +
    `  1. Log in, which stores the credential in ${authPath} — pi accepts a pasted API key, ` +
    `so this works headless for api-key providers (only OAuth needs a browser):\n` +
    `       PI_CODING_AGENT_DIR=${agentDir ?? "<dir>"} npx pi     then /login <provider>\n` +
    `     Note that is pi's OWN variable. PI_AGENT_DIR is this bot's, and the pi CLI ignores ` +
    `it — writing to its own default instead (from piConfig.configDir in whichever pi ` +
    `build you run; ~/.pi/agent for the npm package), which looks like success.\n` +
    `  2. Or put a provider API key in the environment, e.g. ANTHROPIC_API_KEY=... ` +
    `(in .env.local, or exported before starting). Fewer steps, but it puts the key in a file ` +
    `or your shell history rather than pi's credential store.`
  );
}

function renderReply({ blocks }) {
  const parts = [];
  let prevType = null;
  for (const b of blocks) {
    const text = (b.text ?? "").trim();
    if (!text) continue;
    if (parts.length) parts.push(prevType === "tool" && b.type === "tool" ? "\n" : "\n\n");
    parts.push(text);
    prevType = b.type;
  }
  return parts.join("");
}

/**
 * The same blocks as HTML for formatted_body.
 *
 * Text blocks go through markdown. Tool lines deliberately do NOT: their args
 * are raw JSON, and markdown would read `_` and `*` inside a command as
 * emphasis and mangle it. They are escaped and wrapped in <code> instead, which
 * also renders them monospace — closer to what they are.
 */
function renderReplyHtml({ blocks }) {
  const out = [];
  let run = []; // consecutive tool lines, grouped into one <p>

  const flushTools = () => {
    if (!run.length) return;
    out.push(`<p>${run.map((t) => `<code>${escapeHtml(t)}</code>`).join("<br/>")}</p>`);
    run = [];
  };

  for (const b of blocks) {
    const text = (b.text ?? "").trim();
    if (!text) continue;
    if (b.type === "tool") {
      run.push(text);
      continue;
    }
    flushTools();
    const html = renderMarkdown(text);
    if (html) out.push(html);
  }
  flushTools();

  return out.join("\n");
}

/** Matrix room IDs are safe-ish on disk, but colons and bangs make for ugly paths. */
function encodeRoomId(roomId) {
  return roomId.replace(/[!@:/\\]/g, "_");
}

/** Concatenate all text blocks in an assistant message. */
function extractText(message) {
  if (!message?.content) return "";
  return message.content
    .filter((c) => c?.type === "text")
    .map((c) => c.text || "")
    .join("");
}

/** Short summary of tool args for the inline status line. */
function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  try {
    const json = JSON.stringify(args);
    return json.length > 80 ? json.slice(0, 77) + "…" : json;
  } catch {
    return "";
  }
}
