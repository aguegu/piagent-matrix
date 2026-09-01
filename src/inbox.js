// Inbox: a spool directory whose files become prompts to the agent.
//
// The outbox posts text to a room. That is not a way to give the agent work,
// and using it as one fails quietly in a way worth recording: a cron job wrote
// "fetch the weather and post it here" into its own bot's outbox, the bot
// posted it to the room, and the bot then ignored it — a bot skips its own
// messages, or it would answer itself forever. The cue was visible to everyone
// and acted on by nobody.
//
// So: an inbox. A file here is run as a prompt in a room, and only the agent's
// reply is posted. The prompt itself is never sent, because it is an
// instruction to the agent rather than something to say.
//
// Accepted files:
//   *.txt   the whole file is the prompt, run in the main room
//   *.json  { "prompt": "...", "room"?: "!id:server", "from"?: "..." }
//
// `from` is what the agent is told the prompt came from, defaulting to a
// scheduled job. It is not a Matrix user and should not look like one: the
// agent is told who is speaking on every turn, and a cron job pretending to be
// a person would be the one lie in that channel.
//
// Anything that can write here can make the agent run commands. That is the
// same reach the outbox already grants — see SECURITY.md.

import { LogService } from "matrix-bot-sdk";
import { watchSpool } from "./spool.js";

const DEFAULT_FROM = "a scheduled job on this host";

/**
 * @param {object} opts
 * @param {string} opts.dir  spool directory
 * @param {string|(() => string)} opts.defaultRoom  main room for unaddressed drops
 * @param {(job: {roomId: string, prompt: string, from: string}) => Promise<void>} opts.deliver
 */
export function startInbox({ dir, defaultRoom = "", deliver, pollMs = 10_000, concurrency = 8 } = {}) {
  const readDefaultRoom = () =>
    (typeof defaultRoom === "function" ? defaultRoom() : defaultRoom) || "";
  if (dir) LogService.info("inbox", `Watching ${dir} for prompts.`);

  return watchSpool({
    dir,
    label: "inbox",
    pollMs,
    // Each handler awaits a whole agent run, so a serial spool let one room's
    // long run stall every other room's prompts — a scheduled tick for one room
    // waiting on a conversation in another. Claiming stays in name order, so
    // drops for the same room still reach that room's queue in order; the
    // agent's own per-room chain is what keeps them from overlapping, and its
    // backlog cap is what bounds the work.
    concurrency,
    async handle(name, contents) {
      const { room, prompt, from } = parseJob(name, contents, readDefaultRoom());
      if (!room) {
        throw new Error(
          "no room in the file and no main room established — name the room in a " +
            ".json drop, or invite the bot to a room that can be its main room",
        );
      }
      if (!prompt.trim()) throw new Error("empty prompt");

      await deliver({ roomId: room, prompt, from });
      return `Ran ${name} in ${room} (${prompt.length} chars from ${from})`;
    },
  });
}

function parseJob(name, raw, defaultRoom) {
  if (!name.endsWith(".json")) {
    return { room: defaultRoom, prompt: raw.replace(/\n$/, ""), from: DEFAULT_FROM };
  }
  const obj = JSON.parse(raw);
  if (obj.prompt === undefined && obj.body !== undefined) {
    // The outbox takes `body`, and the two spools look alike enough to confuse.
    // Say which one this is rather than running someone's announcement as an
    // instruction, or refusing with "empty prompt" and leaving them guessing.
    throw new Error(
      'the inbox runs a "prompt"; this file has a "body", which is the outbox\'s. ' +
        "Drop it in the outbox to post it, or rename the field to run it",
    );
  }
  return {
    room: obj.room || defaultRoom,
    prompt: obj.prompt ?? "",
    from: typeof obj.from === "string" && obj.from.trim() ? obj.from.trim() : DEFAULT_FROM,
  };
}
