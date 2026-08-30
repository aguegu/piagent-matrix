# More than one bot in a room

Two of these can share a room and talk to each other. That is deliberate, and it
took two tries to get right.

Matrix distinguishes `m.text`, which a person sends, from `m.notice`, which an
automated client sends. Clients render notices differently — muted, in Element —
and bots are conventionally expected to ignore them, so that two machines do not
answer each other forever. This bot **sends** notices, so a well-behaved
counterpart is not drawn in, and also **accepts** them, so agents that are meant
to talk can.

Accepting them is the second try. Ignoring notices did stop a runaway, and also
left two agents sitting in a room unable to hear each other at all — which is
not what anyone wanted from them.

**Deciding what deserves an answer is the agent's job.** `AGENTS.md` gives it
one test: is this message *for me*? Being greeted, asked something or named gets
an answer, whoever is asking; two other participants talking to each other does
not. The earlier wording — answer "when you have something to add" — judged the
*content* instead, and small talk contains nothing to add, so a bot greeted by
name six times running said nothing back all six times.

What bounds it is a counter, for the case where judgement does not end an
exchange:

| | |
| --- | --- |
| Limit | three consecutive automated messages in one room |
| Reset | any message from a person |
| Scope | per room, per process — a restart forgets it |
| Withheld | not answered, but not unheard — carried into the next reply |

**What is withheld is still heard.** Declining to *answer* is the point;
declining to *hear* would leave the agent with a hole in the conversation that
everyone else in the room saw, so asked later what was decided it could not say
and would not know why. Messages it does not answer ride along in the context of
the next one it does — the last ten, truncated, since the thing being withheld
is by definition a bot that will not stop talking.

Before that rule existed the same pair ran **59 turns**, each running shell
commands on the other's output with nobody in the room. A different model, or a
prompt that nudges it, will do that again; the counter is what makes the cost
bounded rather than open-ended. The agent is told the limit exists, so ending a
conversation stays its job rather than the counter's.

The log marks which is which, so a transcript can be read back:

```
< [e2ee] [bot] @otherbot:example.org: "..."   counted toward the limit
< [e2ee] @admin:example.org: "..."            a person; resets it
```

None of this is access control. `m.notice` is a convention a hostile or careless
bot can ignore, and the counter bounds a runaway rather than preventing one —
`MATRIX_ALLOWED_USERS` is what decides who may drive the agent at all.

---

[← README](../README.md)
