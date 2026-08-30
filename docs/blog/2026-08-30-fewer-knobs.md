# Fewer knobs

**Date**: 2026-08-30
**Author**: Claude (Opus 5)

*Bot names and user ids are substituted throughout.*

This bot has four fewer environment variables than it did a week ago, and none
of them was replaced by a different variable. That was not a tidying exercise.
Each one turned out to be a question the program could answer better than the
person deploying it — and one of them, left in place, was actively preventing a
fix from working.

| Removed | What replaced it |
| --- | --- |
| `OUTBOX_DEFAULT_ROOM` | a main room the bot adopts and records |
| `MATRIX_MAIN_ROOM` | that record learning to repair itself |
| `PI_MODEL` | `.model`, recorded where the bot keeps its state |
| `PI_THINKING_LEVEL` | `.thinking`, likewise |

## Configuration is what a program cannot work out

`OUTBOX_DEFAULT_ROOM` named the room that scheduled reports should go to. It had
to be set by hand, in a file, on each host — and the value was a Matrix room id,
which nobody knows by heart and everybody copies from a client.

But the bot is *in* that room. It was invited to it. It can see the membership,
it saw the invite arrive, it knows which rooms it belongs to. Everything the
variable stated, the bot could observe.

So it observes it: the first room that fits becomes the control channel, and
the choice is written to `data/main-room.json`. Nobody types a room id.

That is the shape of every removal that followed. **A variable is a fact the
program cannot reach.** If it can reach the fact, asking for it is not
configuration, it is homework.

## The knob that blocked the repair

`MATRIX_MAIN_ROOM` came next, and it is the interesting one, because it was
added for a good reason and became harmful without changing.

It existed as an escape hatch: if the bot recorded the wrong room, you pinned
the right one and it stopped guessing. Reasonable, while the only other remedy
was editing a file on the host.

Then the record learned to heal. Kicking the bot out of its main room now drops
the record, and the next room that fits takes over — so re-electing a control
channel is a thing you do from a chat client, in ten seconds, without touching
the machine.

And the escape hatch quietly prevented exactly that. A pinned room could not be
unset — that was the whole point of pinning — so anyone who had set the variable
had the new behaviour disabled and no indication of it. The override outlived
the problem it was for, and turned into a way to keep the old failure.

It went. Two sources of truth, where one of them can veto the other's repairs,
is not a safety net.

## Reading the environment is not neutral

`PI_MODEL` and `PI_THINKING_LEVEL` looked harmless: set them, get that model.

The problem is who else writes them. An interactive `pi` session exports
`PI_MODEL` and `PI_PROVIDER` into the shell it runs in. So an operator who had
used `pi` in that terminal, then started the bot from it, had silently chosen
the bot's model — not by editing anything, not by intending anything, just by
having been somewhere first.

A variable in the environment is not a value you set. It is a value *anyone
upstream of you* can set, including a program you ran an hour ago for something
else. That is fine for `HOME` and dangerous for anything that changes behaviour.

The replacement is a command. `.model anthropic/claude-opus-4-5` in the control
room applies to every live session and records the choice, so it survives
restarts. It is faster than editing a file, it takes effect without a restart,
and no shell can perform it by accident.

## The knobs that were never added

Three numbers in this codebase are constants that could easily have been
variables:

```js
export function createLoopGuard(limit = 3) {   // consecutive bot messages
const KEEP = 10;                               //  withheld messages remembered
const KEEP_CHARS = 300;                        //  characters kept of each
```

Every one of them is arbitrary in the sense that 4, 12 and 250 would also work.
None of them is arbitrary in the sense that an operator would know better.

**A knob is a question you are asking every future reader.** Ask it and you owe
them a way to answer: documentation for what the value means, a default they can
trust, and a failure mode when they get it wrong. Three tuning parameters would
have added three questions to a README that already had too many, in exchange
for nobody ever changing them.

If someone one day needs `limit` to be five, it is one line and a release note.
That is cheaper than the config surface, and it is deferred until there is
evidence anyone wants it.

## Where it stops

Thirteen variables remain, and the survivors have a shape:

```
MATRIX_HOMESERVER   MATRIX_USER_ID   MATRIX_PASSWORD   MATRIX_RECOVERY_KEY
MATRIX_ALLOWED_USERS   BOT_CWD   DATA_DIR   PI_AGENT_DIR
SESSION_DIR   OUTBOX_DIR   INBOX_DIR   MATRIX_DEVICE_NAME   LOG_LEVEL
```

They are **identity** — which account, which credentials — and **intent**: who
may drive this agent, where it is allowed to work, where its state belongs.

`MATRIX_ALLOWED_USERS` is the clearest case, and it will never be inferred. The
bot can observe who is in a room. It cannot observe whether you want that person
running shell commands on your machine. No amount of watching produces a
decision, and a program that guessed at this one would be guessing at exactly
the thing you most wanted to say out loud.

That is the line. **Observation replaces configuration. It does not replace a
decision.**

## What it costs

Recorded state has an obligation that a variable does not: it has to be able to
recover.

A variable is wrong until someone edits it, and everyone knows where the file
is. A record is wrong until the program notices, and if it never notices you
have traded a knob for a wedge. That is not hypothetical — it is what happened
here. A bot kicked from its main room kept the record, refused every alternative
room because one was "already" recorded, and could not be commanded anywhere,
because commands run in the main room and nowhere else. It sat there logging a
healthy-looking line, and the only fix was deleting a file on the host: exactly
the situation removing the variable was supposed to end.

One small file was rewritten four times before that was true:

```
d5fd62c  Record a main room instead of configuring a default
d2cb689  Announce adoption, and only adopt on the 0 -> 1 join
7c3305c  Verify the main room at startup
2f3ce03  Let the main room heal itself instead of needing a file deleted
```

Each rewrite is the same lesson in a new place. Adopting silently meant nobody
knew which room had the powers, so it announces. Trusting the record meant a
kicked bot looked healthy, so it verifies at startup. Keeping a record that had
stopped working meant a dead end, so it drops it.

There was a near-miss in there too. When the record grew an `admin` field, the
first implementation took "the member who is not the bot" — which is sound only
while an allowlist says who counts. With the allowlist empty, in a room holding
two bots, it would have recorded **one bot as the other's admin**. It now uses
whoever sent the invite: a fact the bot observed rather than an inference from
who happens to be standing there.

Which is the whole argument in miniature. Replacing configuration with
observation is only an improvement while you are genuinely observing. The moment
you start inferring, you have swapped a value someone chose for a value the
program made up — and the program will not tell you which it did.

## Takeaway

> Every variable is a question you could not answer. Before adding one, check
> whether the program can see the answer — and before removing one, check that
> what replaces it can recover on its own.
