// A bound on bots answering bots.
//
// Two agents in a room should be able to say something useful to each other,
// and deciding when to stop is the agent's own judgement — AGENTS.md tells it
// that silence is a reply, and that works: once the rule existed, one bot went
// quiet after two exchanges without being made deaf.
//
// But judgement is a disposition, not a limit. Before that rule, the same pair
// ran 59 turns. A model with a different temperament, or a prompt that nudges
// it, will do that again — and nobody is in the room to notice, because the
// exchange is entirely between machines.
//
// So the agent decides, and this only catches the case where it does not: a run
// of consecutive automated messages in one room, reset the moment a person
// speaks. It is not who-is-a-bot detection, which cannot be done reliably.
// m.notice means "an automated client sent this", and people do not send it.

/**
 * What is withheld is still remembered. Declining to *answer* is the point;
 * declining to *hear* would leave the agent with a hole in the conversation
 * that everyone else in the room saw — asked later what was decided, it could
 * not say, and would not know why. Withheld messages ride along with the next
 * one it does answer, so its view of the room stays whole.
 *
 * Bounded, because the thing being withheld is a bot that will not stop
 * talking: the last few, each truncated.
 */
const KEEP = 10;
const KEEP_CHARS = 300;

/**
 * @param {number} limit consecutive automated messages answered per room
 */
export function createLoopGuard(limit = 3) {
  /** roomId -> consecutive automated messages seen since a person last spoke. */
  const streak = new Map();
  /** roomId -> messages seen but not answered, awaiting the next answered one. */
  const withheld = new Map();

  return {
    /**
     * Whether to act on a message, and count it.
     *
     * @param {string} roomId
     * @param {boolean} automated  true for m.notice
     * @returns {boolean}
     */
    allow(roomId, automated) {
      if (!automated) {
        // A person spoke: whatever the machines were doing, it is over.
        streak.delete(roomId);
        return true;
      }
      const n = (streak.get(roomId) ?? 0) + 1;
      streak.set(roomId, n);
      return n <= limit;
    },

    /** Remember a message that was not answered, so it is not lost. */
    withhold(roomId, sender, body) {
      const kept = withheld.get(roomId) ?? [];
      kept.push({ sender, body: String(body).slice(0, KEEP_CHARS) });
      withheld.set(roomId, kept.slice(-KEEP));
    },

    /** Take what was withheld since the last answered message. */
    drain(roomId) {
      const kept = withheld.get(roomId) ?? [];
      withheld.delete(roomId);
      return kept;
    },

    /** Consecutive automated messages in a room, for logging. */
    streakOf(roomId) {
      return streak.get(roomId) ?? 0;
    },

    /** Forget a room, on leaving it. */
    forget(roomId) {
      streak.delete(roomId);
      withheld.delete(roomId);
    },
  };
}
