// AgentManager: thin wrapper that turns incoming Matrix messages into prompts
// for a pi AgentSession, one session per room, and posts a single clean reply
// to the room when the run finishes.
//
// Design notes (from docs/agent-handoff.md):
//   * `model.provider`, never `providerId` (v1 silently fell through).
//   * Cache the createAgentSession PROMISE per room — two messages arriving
//     back-to-back must not both spawn a session and clobber each other.
//   * NO edit-in-place. An earlier build streamed into a LiveMessage and let
//     Element render the reply with an "(edited)" marker, which the user
//     disliked. The typing indicator is the accepted progress signal: we
//     buffer everything in memory, then send one m.room.message when the run
//     ends. Tool-call status lines are still surfaced inline so a long tool
//     run is visible in the final answer.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { LogService } from "matrix-bot-sdk";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import {
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
    /** @type {Map<string, Promise<import('@earendil-works/pi-coding-agent').AgentSession>>} */
    this.sessions = new Map();
    /** Per-room tail of the run chain, so prompts never overlap. @type {Map<string, Promise<void>>} */
    this.chains = new Map();
    /** Per-room count of messages queued or running. @type {Map<string, number>} */
    this.pending = new Map();
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
      throw new Error(
        `No models with complete auth are available in ${agentDir ?? "~/.pi/agent"}. ` +
          `Authenticate a provider there, e.g. PI_AGENT_DIR=${agentDir ?? "<dir>"} pi, ` +
          `or copy an existing ~/.pi/agent/auth.json into it.`,
      );
    }

    const want = this.opts.model; // e.g. "minimax-cn/MiniMax-M3" or bare "MiniMax-M3"
    // PI_PROVIDER is set by the pi CLI when invoked interactively; honour it
    // as a tie-breaker when PI_MODEL is just a bare id.
    const providerHint = process.env.PI_PROVIDER || null;
    if (want) {
      // Accept either "provider/id" or bare "id". The shell often has PI_MODEL
      // set from a prior `pi` invocation with just the model id.
      let provider = null;
      let id = want;
      if (want.includes("/")) {
        const [p, ...rest] = want.split("/");
        provider = p;
        id = rest.join("/");
      } else if (providerHint) {
        provider = providerHint;
      }
      const hit = available.find((m) => {
        if (m.id !== id) return false;
        if (provider && m.provider !== provider) return false;
        return true;
      });
      if (!hit) {
        LogService.warn(
          "agent",
          `Requested model ${want}${providerHint ? ` (provider=${providerHint})` : ""} not available. Falling back. Available: ${available
            .map((m) => `${m.provider}/${m.id}`)
            .join(", ")}`,
        );
      } else {
        this.model = hit;
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

  #thinkingLevel() {
    const want = (this.opts.thinkingLevel || "low").toLowerCase();
    return THINKING_LEVELS.includes(want) ? want : "low";
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
      const persisted = this.opts.sessionDir ? "persistent" : "in-memory";
      LogService.info("agent", `Created ${persisted} agent session for room ${roomId}`);
      return result.session;
    })();
    this.sessions.set(roomId, p);
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

    // Serialize per room. pi's prompt() does NOT run a second prompt while the
    // session is streaming: it queues via followUp and returns *immediately*,
    // so a caller that then renders its buffer renders nothing, while its text
    // silently lands in the previous run's output. Waiting for our turn means
    // every prompt owns a complete run.
    const prev = this.chains.get(roomId) ?? Promise.resolve();
    const mine = prev.then(
      () => this.#runPrompt(ctx),
      () => this.#runPrompt(ctx), // a failed predecessor must not block the queue
    );
    this.chains.set(roomId, mine.then(() => {}, () => {}));

    try {
      return await mine;
    } finally {
      this.pending.set(roomId, Math.max(0, (this.pending.get(roomId) ?? 1) - 1));
    }
  }

  /** Run exactly one prompt to completion. Callers must hold the room's turn. */
  async #runPrompt({ roomId, text, sender, client }) {
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
    const buffer = { blocks: [] };

    const unsub = session.subscribe((event) => this.#onEvent(event, buffer));

    try {
      await session.prompt(text, { streamingBehavior: "followUp" });
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

    const body = renderReply(buffer);
    if (!body.trim()) {
      // The agent finished without producing any text content — don't post an
      // empty message; just log so we can see it happened.
      LogService.warn("agent", `run in ${roomId} produced no text output`);
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
        }
        break;
      }
      default:
        break;
    }
  }

  async #post(client, roomId, body, html = null) {
    try {
      const content = { msgtype: "m.text", body };
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

  /** Stop tracking a room (e.g., on shutdown). */
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
