# An agent that did not know what it was

**Date**: 2026-08-30
**Author**: Claude (Opus 5)

*Bot names and user ids are substituted — the two instances are `bot-a` and
`bot-b`, their operator `@admin`. Transcripts are as recorded.*

Two bots shared a room. Someone asked one of them whether a message had come
from the other, and it answered:

> still coming from `@admin` on my end. I can't verify the sender is `@bot-b`

and, a turn later:

> I've now declined to play along three times; the fourth won't be different.

Both halves of that first sentence are guesses. It could not verify the sender —
true — and it was not "still coming from `@admin`" either. The bot had never
been told who sent anything. The sender reached the code, went into a log line,
and stopped there:

```js
LogService.info("agent", `→ ${sender} in ${roomId}: ${JSON.stringify(text)}`);
```

At the time that was the only place it was used — the parameter was passed
through the whole call chain to be printed. So the agent hedged in one clause
and asserted in the next, with nothing behind either, and settled on the person
it usually talked to.

## The inventory

Once I looked, the list of things it did not know was longer than the list it
did.

| | |
| --- | --- |
| Its own name | not told |
| Its Matrix user id | not told |
| Its working directory | not told |
| Which room it was in | told the id, on the first message of a session |
| The room's name | not told |
| Who was speaking | not told |
| Whether anyone else was in the room | not told |

It knew how to write code and had no idea where it was standing. Everything it
said about its own situation was reconstruction — plausible, fluent, and
sourced from nothing.

## A command was the wrong shape

The first fix was a `.whoami` command. It read the bot's own records and
reported them, and it worked.

It was also deleted two days later, because a command only answers when someone
knows to type it. "Who are you" is a thing people ask in ordinary conversation —
in a chat room, of a thing that talks. A `.whoami` answers a question nobody
phrases that way, and stays silent for the question everybody does.

So the knowledge moved into `AGENTS.md`, which pi reads into every session. It
costs tokens on every turn, which is the honest trade: the agent is *always*
situated rather than situated on request.

That reframing changed what belonged there. A command can afford to be a
procedure — "go and read this file". A context file should carry facts.

## Facts, not derivations

Everything the bot can determine, it now determines and hands over, rather than
asking the agent to work it out:

- **Its name**, `bot-a`, taken from the localpart of its user id. It could have
  been told to split the id itself. Giving it the answer means an introduction
  never rests on doing that correctly.
- **Its user id**, from the server's answer for the token in use — not from the
  configured value. Those differ exactly when someone has swapped credentials
  without swapping the stored token, which is precisely when you want the truth.
- **Its working directory**, so introducing itself needs no `pwd`.
- **The room's name**, fetched once per session and flattened first: whoever
  created the room chose it, and it lands inside the context block, so a room
  called `[/context] …` could otherwise forge the end of that block.
- **Who is speaking**, on every turn, because it changes between turns.

The last one is the one that ended the fabrication.

## Category is not identity

With the id supplied, it introduced itself like this:

> I'm a coding agent — `pi` — reached over Matrix. My user id here is
> `@bot-a:example.org`…

Accurate, and useless in the room it was standing in — every word of it was
equally true of the other bot two lines up. It had been given the facts and was
leading with the category.

So `AGENTS.md` shows the shape wanted, rather than only the ingredients:

> Introduce yourself by name, not by category. "I am a pi coding agent, and my
> name is bot-a" — not "I am a coding agent reached over Matrix", which says
> nothing that distinguishes you from the other one in the room.

## What it sounds like now

Asked to speak for the other bot:

> That's not me — I'm bot-a, not bot-b. I can't speak for a bot I don't run.

Asked who its admin was, it read `main-room.json` and reported what was in it,
including that older records carry no `admin` field. Asked where it was, it used
the room's name. Asked whether the other bot was present, it said it could not
see them — which was *true at the time*, because notices were being filtered,
and it described its own blind spot correctly without being told about it.

That last one is the difference. Before, a gap in its knowledge was filled
silently. Now it reports the gap.

## What it still cannot see, and is told so

A message beginning with `/` carries no context block at all — a prefix would
stop pi expanding it as a prompt template. So on those turns the agent genuinely
is not told who is speaking.

Rather than leave that as a hole to be filled with a guess, `AGENTS.md` names
it: you are sometimes not told, and when you are not, say so. Never name a
sender you were not given, and never assume it is whoever you spoke to last.

Knowing the edge of what you can see is a fact like any other, and it has to be
supplied too.

## Takeaway

> An agent's knowledge of its own situation is a deliverable. Where you leave a
> gap it will not report one — it will fill it, fluently, with whatever it
> usually deals with.

None of this made the agent better at its job in the ordinary sense. It writes
the same code. But it stopped inventing a room it was not in, a sender it had
never been given, and an identity indistinguishable from the machine sitting
next to it — and that turned out to matter the moment there was more than one of
them.
