// Bot commands: a short, explicit allowlist — not a passthrough to pi.
//
// pi's TUI exposes a lot behind `/` and `!`, but most of it either needs a
// back-and-forth the room cannot give, or hands a chat message more reach than
// it should have (`!` runs bash in the TUI). Only these are recognised, and
// anything unrecognised is treated as an ordinary prompt so a message that
// merely begins with a slash — a path, say — still reaches the agent.
//
// Both `/name` and `.name` are accepted, but only `.` is advertised. Element
// intercepts a leading `/` for its own commands, so `/help` opens Element's
// help rather than reaching the bot at all; `/` is honoured only for clients
// that pass it through.
//
// Commands belong to the main room. Every one of them either reconfigures the
// bot for all rooms (`.model`, `.thinking`, `.reload`) or reports on it
// (`.rooms`, `.help`), so the bot's control channel is where they go. A working
// room may hold people who are not the bot's admin. It gets `.info` and nothing
// else — and the refusals say nothing about why, or about a main room, so the
// control channel's existence stays where it belongs.

/**
 * Commands the bot answers to, and what each is for.
 *
 * `everywhere` marks the ones a room other than the main room may use.
 */
export const COMMANDS = {
  info: { what: "Show the model and thinking level in use", everywhere: true },
  reload: { what: "pi's /reload — re-read extensions, skills, prompts and context files" },
  rooms: { what: "List the rooms the bot is in; `.rooms leave <roomId>` leaves one" },
  model: { what: "Show the model, or switch it: `.model <provider/id>`" },
  thinking: { what: "Show the thinking level, or set it: `.thinking <level>`" },
  // advertised as .help — /help is Element's own
  help: { what: "List these commands" },
};

/**
 * Whether a room may run a command.
 *
 * With no main room established there is nothing to defer to, so this allows
 * everything rather than leaving the bot with one usable command.
 */
export function mayCommand(name, roomId, mainRoomId) {
  if (COMMANDS[name]?.everywhere) return true;
  return !mainRoomId || roomId === mainRoomId;
}

const PATTERN = new RegExp(`^\\s*[/.](${Object.keys(COMMANDS).join("|")})\\b\\s*([\\s\\S]*)$`, "i");

/**
 * Recognise a bot command, or return null for ordinary text.
 * @returns {{ name: string, args: string } | null}
 */
export function parseCommand(text) {
  const m = typeof text === "string" ? text.match(PATTERN) : null;
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

/**
 * The reply for `.help`, listing what is available here rather than in pi.
 *
 * Main room only, so it lists everything — a room that cannot run `.help` never
 * sees this.
 *
 * Only the `.` form is advertised. A leading `/` is still accepted, but Element
 * intercepts it for its own commands — telling someone to type `/help` sends
 * them to Element's help instead of the bot's.
 */
export function helpText({ prompts = [], skills = [] } = {}) {
  const lines = ["**Commands**", ""];
  for (const [name, entry] of Object.entries(COMMANDS)) {
    lines.push(`- \`.${name}\` — ${entry.what}`);
  }
  if (prompts.length) {
    lines.push("", `Prompt templates installed: ${prompts.map((p) => `\`${p}\``).join(", ")}`);
  }
  if (skills.length) {
    lines.push("", `Skills installed: ${skills.map((s) => `\`/skill:${s}\``).join(", ")}`);
  }
  lines.push(
    "",
    "Anything else is sent to the agent as a prompt.",
  );
  return lines.join("\n");
}
