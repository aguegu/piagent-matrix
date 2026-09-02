# Spools: the outbox and the inbox

Two directories other processes drop files into. The outbox posts text; the
inbox runs prompts. Both share their mechanics — see `src/spool.js`.

## Posting from other processes

A second process must never open its own client against the bot's crypto store.
Two clients load the same outbound Megolm session and each advances its own copy
of the ratchet, so both encrypt at the same `message_index`. Strict clients
reject the duplicate as a replay and show "undecryptable", and the same keystream
ends up covering two different plaintexts.

Instead, drop a file in the outbox and the running bot sends it:

```sh
# Write a dotfile inside the spool (the bot skips dotfiles, and it is the same
# filesystem so rename is atomic), then rename it in.
stamp=$(date -u +%Y%m%dT%H%M%SZ)
tmp="$OUTBOX_DIR/.tmp-$stamp.$$"

# Addressed — records the destination at write time. Reading the bot's own
# main room keeps the two in step without configuring it twice.
room=$(jq -r '.roomId // empty' "$BOT_DIR/data/main-room.json")
jq -n --arg room "$room" --arg body 'deploy finished' '{room: $room, body: $body}' > "$tmp"
mv "$tmp" "$OUTBOX_DIR/$stamp-deploy.json"

# Or unaddressed, letting the bot route it to its main room:
#   printf 'deploy finished\n' > "$tmp"
#   mv "$tmp" "$OUTBOX_DIR/$stamp-deploy.txt"
```

Prefer `*.json` for anything scheduled. A `*.txt` is resolved against the main
room when the bot drains the spool, so a report written now lands wherever the
main room happens to be then; a `*.json` lands where it was addressed.

| File | Meaning |
| --- | --- |
| `*.txt` | Body is the whole file, sent to the [main room](main-room.md) |
| `*.json` | `{ "room"?: "!id:server", "body": "...", "html"?: "..." }` |

Unaddressed `*.txt` drops go to the bot's **main room** (below). `*.json` drops
naming their own room always work, main room or not.

The agent is told this protocol in its shipped `AGENTS.md`, which pi reads every
turn, so asking it to "post a report here every hour" produces a `*.json` drop
addressed to that room rather than a `*.txt` that lands in the default. The
per-message context block carries only what changes: who is speaking, and the
room on the first turn of a session.

Files are sent in filename order, one at a time, so a timestamp prefix preserves
ordering — two messages arriving in a room out of order is a visible fault.
Messages spooled while the bot is down go out on the next start. A failed send is
parked as `.failed` rather than retried forever; a file left `.sending` after a
crash is parked too, since we cannot tell whether it reached the server and
re-sending risks a duplicate.

## Giving the agent work: the inbox

The outbox posts text. The inbox runs prompts. A cron job that wants the agent
to *do* something needs the second, and reaching for the first fails quietly:

```sh
# what does not work — the cue reaches the room, and not the agent
echo '{"room":"!r:example.org","body":"[cron] fetch the weather and post it here"}' \
  > "$OUTBOX/$(date +%s)-weather.json"
```

That posts the cue as the bot, and **a bot ignores its own messages** — it has
to, or it would answer itself forever. So everyone in the room sees the
instruction and the one agent it was meant for does not.

```sh
# what does: the file is the prompt, and only the reply is posted
tmp=$(mktemp)
echo '{"room":"!r:example.org","prompt":"fetch the weather for <your city> and post a brief report","from":"the hourly weather cron"}' > "$tmp"
mv "$tmp" "$INBOX/$(date +%s)-weather.json"
```

| | `OUTBOX_DIR` | `INBOX_DIR` |
| --- | --- | --- |
| A file is | text to post | work to do |
| Field | `body` | `prompt` |
| The room sees | the file's contents | the agent's reply |
| `.txt` goes to | the main room | the main room |

`from` is what the agent is told the prompt came from — it appears where a
sender normally would, and defaults to "a scheduled job on this host". It is
deliberately not shaped like a Matrix id: the agent is told who is speaking on
every turn, and a cron job dressed as a person would be the one lie in that
channel.

Both spools share their mechanics (`src/spool.js`): write elsewhere and
`rename()` in so a partial file is never read, files are claimed by hard link
so a second drop under the same name cannot overwrite one being handled, names
are claimed in order,
failures park as `.failed`, and a claim left by a crash is parked rather than
retried — a repeated post is a duplicate message, a repeated prompt is a
duplicate agent run.

Where they differ is how many files may be in flight. The outbox sends one at a
time, which is also what keeps its messages in order. The inbox runs up to eight,
because its handler waits for a whole agent run: serially, a long run in one room
held the spool and every other room's prompts sat unclaimed behind it — a
scheduled tick waiting on somebody else's conversation. Claiming stays ordered,
so drops for one room still reach that room in order, and the agent's own
per-room chain is what stops them overlapping.

A `.json` in the inbox carrying `body` instead of `prompt` is parked with a
message saying which spool it belongs in, rather than running someone's
announcement as an instruction.

**Choose by who has to think.** A script that can produce the finished text —
disk usage, a service's status, a count — should write it to the outbox: no
model runs, it costs nothing, and it still reports when the agent is busy or
wedged. The inbox is for when producing the text needs judgement or a tool the
shell does not have. `hourly-stats.sh` is the first kind; a weather report that
wants a real search rather than scraping whatever `curl` returns is the second.

**Anything that can write to either directory can drive the bot** — the outbox
speaks as it, the inbox thinks as it. See [SECURITY.md](../SECURITY.md).

---

[← README](../README.md)
