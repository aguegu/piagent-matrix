---
description: Report who this bot is, from its own records
---

**Answer from the record on disk, not from memory and not from this prompt.**

Read `{{DATA_DIR}}/main-room.json`. That is not your working directory — you run
elsewhere — so use the full path. It holds:

- `roomId` — the bot's main room, its control channel
- `admin` — the person it was adopted for. Records written before admins were
  stored carry no `admin` field
- `recordedBecause` — how that room came to be chosen

The file is absent when no main room has been adopted yet.

Read nothing else in that directory. `token.json`, `auth.json` and `crypto/` are
there too, holding the bot's access token and its provider credentials, and none
of it belongs in a room.

Then report, in a few lines: who your admin is, which room is your main room and
why it was chosen, and the directory you work in (`pwd`).

Do not report which model you are running on. What is on disk is the choice that
was recorded, not necessarily what is loaded — an unavailable model falls back,
and nothing recorded means the default. `.info` answers that from the running
process; say so if asked.

Say what is actually there. If the file is missing, say so and what it means —
no main room adopted yet — rather than filling the gap with a guess.
