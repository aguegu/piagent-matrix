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
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export class AgentManager {
  /** @param {{ model?: string, thinkingLevel?: string, cwd: string }} opts */
  constructor(opts) {
    this.opts = opts;
    /** @type {Map<string, Promise<import('@earendil-works/pi-coding-agent').AgentSession>>} */
    this.sessions = new Map();
    /** @type {import('@earendil-works/pi-coding-agent').ModelRuntime | null} */
    this.runtime = null;
    /** @type {import('@earendil-works/pi-coding-agent').Model<any> | null} */
    this.model = null;
  }

  /** Lazily initialize ModelRuntime + pick a model. Called on first message. */
  async #ensureModel() {
    if (this.model) return;

    LogService.info("agent", "Initializing ModelRuntime...");
    this.runtime = await ModelRuntime.create();

    const available = await this.runtime.getAvailable();
    if (available.length === 0) {
      throw new Error(
        "No models with complete auth are available. Run `pi` interactively once to configure a provider.",
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
      const result = await createAgentSession({
        cwd: this.opts.cwd,
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
  async handleMessage({ roomId, text, sender, client }) {
    LogService.info("agent", `→ ${sender} in ${roomId}: ${JSON.stringify(text)}`);

    const session = await this.#getOrCreateSession(roomId);

    // Accumulate locally — never post anything until the run is done.
    const buffer = {
      text: "",
      toolLines: [],
    };

    const unsub = session.subscribe((event) => this.#onEvent(event, buffer));

    try {
      await session.prompt(text, { streamingBehavior: "followUp" });
    } catch (err) {
      LogService.error("agent", `prompt failed in ${roomId}: ${err?.message ?? err}`);
      const body = renderReply(buffer) + `\n\n_⚠️ ${err?.message ?? String(err)}_`;
      await this.#post(client, roomId, body);
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
    await this.#post(client, roomId, body);
  }

  /** @param {any} event */
  #onEvent(event, buffer) {
    switch (event.type) {
      case "message_update": {
        const sub = event.assistantMessageEvent;
        if (sub.type === "text_delta") {
          buffer.text = extractText(sub.partial);
        } else if (sub.type === "thinking_delta") {
          // Internal reasoning — not surfaced.
        }
        break;
      }
      case "tool_execution_start": {
        buffer.toolLines.push(`⏺ ${event.toolName}(${summarizeArgs(event.args)})`);
        break;
      }
      case "tool_execution_end": {
        const last = buffer.toolLines[buffer.toolLines.length - 1];
        if (last?.startsWith("⏺")) {
          buffer.toolLines[buffer.toolLines.length - 1] =
            last + (event.isError ? "  ✗" : "  ✓");
        }
        break;
      }
      case "message_end": {
        // Final text from the finished assistant message.
        if (event.message?.role === "assistant") {
          buffer.text = extractText(event.message);
        }
        break;
      }
      default:
        break;
    }
  }

  async #post(client, roomId, body) {
    try {
      await client.sendMessage(roomId, {
        msgtype: "m.text",
        body,
      });
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

function renderReply({ text, toolLines }) {
  return (toolLines.length ? toolLines.join("\n") + "\n\n" : "") + text;
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
