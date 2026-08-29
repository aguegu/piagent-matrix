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
 * @param {number} limit consecutive automated messages answered per room
 */
export function createLoopGuard(limit = 3) {
  /** roomId -> consecutive automated messages seen since a person last spoke. */
  const streak = new Map();

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

    /** Consecutive automated messages in a room, for logging. */
    streakOf(roomId) {
      return streak.get(roomId) ?? 0;
    },

    /** Forget a room, on leaving it. */
    forget(roomId) {
      streak.delete(roomId);
    },
  };
}
