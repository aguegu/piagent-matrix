# The main room

The bot's control channel: normally the room holding just the bot and its admin.
Unaddressed `*.txt` outbox drops go here, and it is where operational output
belongs.

**It is recorded, not configured**, in `data/main-room.json`. There is no
environment variable for it: an override existed while a wrong record could only
be corrected on the host, and now that kicking the bot out drops the record, a
second source of truth would only be something to argue with. Recording means a
bot started before it was invited anywhere picks a room up as soon as it joins,
with no restart.

**A room is adopted when there is no main room and the room fits**: the bot is
in it, it holds no more than two members, and — when `MATRIX_ALLOWED_USERS` is
set — the other one may run commands. That last part is what makes adoption
safe. A stranger cannot hand the bot a control channel by inviting it somewhere,
and a busy working room cannot become one by accident.

The room's **admin** is recorded alongside it — whoever invited the bot into the
room that became its control channel:

```json
{
  "roomId": "!abc:example.org",
  "admin": "@admin:example.org",
  "recordedBecause": "first room that fits"
}
```

A room id on its own says where the bot takes orders, not who from. The invite
is used rather than the room's membership because it is a fact the bot observed,
and because membership answers nothing when `MATRIX_ALLOWED_USERS` is empty:
everyone is allowed then, and the other member may be another bot. The
allowlisted member is the fallback for a room adopted at startup, where no
invite was seen; with neither, no admin is recorded, since unrecorded reads as
unknown where a guess reads as established.

The startup log and `.rooms` both name the admin, and the room is flagged at
startup if they are no longer in it — a control channel outliving the person it was adopted for
is worth noticing, even though it still works. Records written before this
simply carry no `admin`, and are read as before.

| Situation | What happens |
| --- | --- |
| Invited to a room that fits, with none recorded | Adopted, and the bot says so in that room |
| Invited to a room that does not fit | Not adopted; logged with the reason |
| No main room at startup, one joined room fits | Adopted |
| No main room at startup, several fit | Refuses to guess; warns |

**The record is dropped as soon as it stops being usable** — the bot is kicked
from the main room, or starts up to find itself no longer in it. A pointer to a
room the bot cannot reach is worse than no pointer at all: commands run in the
main room and nowhere else, so the bot goes silent while looking healthy, and
every alternative is declined because a room is *already* recorded. Dropping it
lets the next room that fits take over, so recovering never means editing a file
on the host.

So to move the control channel: kick the bot from the main room, then invite it
to the one you want. The invite is the signal — a room just joined wins outright
if it fits, which is how an admin re-elects without touching the host.

**Strict to adopt, lenient to keep.** A main room that later grows past two
members, or whose admin steps out, is warned about but not dropped: it still
works. Only being outside the room is disqualifying, because only that stops it
working.

**The bot says so when it adopts.** It posts in the room it just took —
commands run here, later output arrives here, other rooms get `.info` only.
Otherwise adoption is invisible: it happens on join and goes straight to disk,
and the room that gets the powers should be told it has them. A failed notice is
logged, not thrown; the adoption still stands.

**It is checked at every start.** A recorded room used to be trusted on sight,
so one the bot had been kicked from looked healthy right up until every command
was refused and outbox drops piled up as `.failed`. Four things are checked: the
bot is in it (dropping the record if not), an allowlisted user is in it, the
recorded admin is still in it, and it has no more than two members. The
warning goes to the log always, and into the main room only when there is
someone there to act on it — never to a room the bot is not in, and never to one
holding no allowed user, since a room of strangers is the last place to announce
that it is the bot's control channel.

The main room is read per send rather than captured at startup, so a room
adopted later takes effect immediately.

---

[← README](../README.md)
