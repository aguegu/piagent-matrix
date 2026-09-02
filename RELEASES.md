# Releases

## 0.2.4 (2026-09-02)

Failures stop being silent. A run that died on a provider error, a room quietly
carrying 430,000 tokens a turn, a scheduled job stalled behind someone else's
conversation, a second instance on one data directory, a drop overwritten by
one that shared its name — each of these already happened, and none of them
said so. Most of the release is giving them a voice, and `.compact` a way to act
on the loudest of them.

### New Features

* **`.info` reports what the room's context costs**: `Context: 430,662 tokens (41% of 1,048,576)`, taken from the provider's own usage on the last reply via pi's `calculateContextTokens`, so it is the same number pi's auto-compaction watches. Every turn resends the context, which makes this the figure that decides what a room costs — and nothing surfaced it, so one room reached 430,000 tokens a turn unnoticed while meeting the plan's token ceiling several times a day. A failed turn reports zero usage and is ignored rather than recorded, since "this room is cheap now" is the wrong thing to learn from being rate-limited; compacting updates it immediately, so `.info` afterwards shows the new size rather than the old
* **`.compact`** summarises a room's history so its session carries fewer tokens into each later run, reporting what it saved (`93,764 → about 12,000 tokens`). Allowed in any room and scoped to the one it is typed in, like `.info`: it reaches no other room and reveals nothing about the main room, and the main room is the wrong home for it anyway — that is for management, while the conversations long enough to need compacting happen elsewhere. It calls pi's `compact()`, and shares the room's run queue, since pi refuses a prompt while compaction runs and compaction aborts whatever the agent is doing. A room with no live session is resumed from its transcript first: the session map is emptied by a restart while the history stays on disk, so a cold map is not an empty room — the first cut checked only the map and told the longest-running room in the deployment it had nothing to compact
* Worth knowing why it could not simply be typed: pi's built-in slash commands are dispatched by its interactive and RPC modes, **not** by `AgentSession.prompt()`, which only executes extension commands and expands skill commands and prompt templates. A built-in sent as a prompt is not refused — it reaches the model as ordinary text and quietly does nothing. So `/compact` in a room never compacted anything, and the same is true of `/new`, `/resume` and the rest. `/reload` appeared to work only because `.reload` was wired to the API by hand

### Fixes

* **A reply of more than one dot was posted as a message.** `isSilence` matched a single `.` and nothing else, so `..`, `. .` and `.\n\n.` — all of which models send when asked for one dot — reached the room as visible messages. Two bots then answered each other's dots for four turns until the loop guard stopped it. A reply of nothing but dots and space now counts as silence whatever its shape — the four dot-like characters (`.`, `。`, `·`, `…`), not punctuation at large, since `?` or `!` alone does carry something. What no regex can fix is a reply that *explains* the silence — `bk15pi echoing. Silence.` is a message about being quiet, and the room reads it as conversation — so `AGENTS.md` now states the mechanism plainly: there is no aside channel, and anything that is not exactly `.` is said out loud. It stops there deliberately. The first non-MiniMax model showed that this rule was the one place in an otherwise harness-factual document that assumed a model's disposition — asking for a bare token presumes the reasoning has somewhere else to go — and 7 of 8 narrated replies came from turns that produced no thinking block at all, so the model had nowhere to put it rather than choosing to explain itself. Arguing with that in the instruction would tune the file to one model, which is the opposite of what it is for
* **A second drop under the same name overwrote one already being handled.** Claiming was `rename()`, which replaces an existing destination silently — so when two writers produced one filename, the claim already in flight had its content swapped underneath it and a second handler started on the same path: one prompt, two agent runs, and an `ENOENT` when the loser tried to delete what the winner had removed. Seen for real when three digest jobs dropped in the same second: the scripts name drops to the second, `mv` collapsed them into one file, and that file was then handled three times. Claiming is now `link()` + `unlink()`, which refuses an existing destination with `EEXIST`, leaving the new drop on disk until the claim clears. Filesystems without hard links fall back to the old rename. This also explains the unexplained `ENOENT` recorded against the instance lock a day earlier
* **Two instances on one data directory are now refused, rather than asked not to.** The documentation has said "never run two instances against the same `data/`" since 0.2.0, because that is the fault this project was built around — both load the same outbound Megolm session, each advances its own copy of the ratchet, and they encrypt different messages at the same index, which strict clients reject as a replay. Nothing checked. It cost the spools too: they park any claim found at startup, on the reasoning that a leftover claim means the bot died mid-handle, which is sound with one instance and wrong with two — a starting bot renames a running bot's in-flight file away, the running one then cannot delete what it finished, and a completed job is logged as a failure. Seen once, on a trading tick whose decision file had been written twelve seconds earlier. Startup now takes `data/bot.lock` and refuses if the pid in it is alive and looks like another copy of the bot, saying which pid. A lock left by a `kill -9` is taken over with a warning, and a reused pid counts as stale: a bot that will not start is worse than the thing the lock guards against. Advisory and single-machine — it catches a second `npm start`, not a second container
* **One inbox job blocked every other room's.** The spool held a single scan lock across an awaited handler, and the inbox's handler waits for a whole agent run — so a long conversation in one room left scheduled prompts for every other room unclaimed until it finished, and a file landing mid-scan waited for the whole batch besides. The agent already serializes per room; this was a second, global lock that bought nothing. The inbox now runs up to eight at once and rescans as each finishes. Claiming stays in filename order, so drops for one room still reach it in order. The outbox is untouched at one at a time, which is what keeps two messages from arriving out of order
* **A run that failed was posted as a deliberate silence — that is, not posted at all.** pi retries an API failure internally and then resolves the prompt, so `prompt()` never throws and the error path never ran. What reached the end of the run was an empty reply buffer, which is also how the agent declines to speak, so the run was logged `said nothing` at INFO and the room was told nothing. Twice on 2026-09-01 a question got four failed retries and no reply and no reason: once on a provider quota limit (`429`, "Token Plan 用量上限"), once on provider overload (`529`). Silence became a valid reply in 0.2.2, which is exactly what made silence useless as a signal. An errored `message_end` and pi's `auto_retry_start` / `auto_retry_end` are now recorded, and a run that produced nothing because it failed says so, naming the status, the kind and the provider's own sentence — the request id and the rest of the envelope stay out of the room. Text already produced is kept and marked cut short rather than discarded, and a retry that succeeds clears the failure, so a recovered run is still just an answer

### Improvements

* pi 0.84.3 -> 0.84.4, which fixes **resumed sessions corrupting the next appended entry when the JSONL lacks a trailing newline** — this bot resumes a session per room on every restart, so that is its normal path rather than an edge case. It also stops a large tool result crossing the auto-compaction threshold from being sent to the provider before compaction. No breaking changes, and the surfaces this bot depends on were checked against the new build: `compact()`, `auto_retry_start` / `auto_retry_end`, `message_end`, `continueRecent`, `inMemory`, `reload`, `setThinkingLevel`, `isStreaming`. `stopReason`, which the failed-run notice reads, is declared in no `.d.ts` in either version — an undeclared runtime field the tests now cover
* markdown-it 15.0.0 -> 15.0.1. `npm audit` is unchanged at 8 advisories, all still the `request` chain under `matrix-bot-sdk` that SECURITY.md accounts for

### Tests

* 167 tests, up from 133. Each fix's tests were run against the behaviour they replaced and watched to fail there — 5 of 8 for the failed-run notice, 3 of 6 for the spool's concurrency, one apiece for the cold-map compaction, the colliding claim and the dots. Tests for the new features have no prior behaviour to fail against, and are not claimed to: a failed run reported rather than posted as silence, with the attempt count, partial text kept and marked cut short, a recovered retry left as a plain answer, and a raw error passed through when it is not the provider's JSON; compaction reporting what it saved, waiting for a run in flight, and finding a session on disk that the map has forgotten; and the spool refusing to let one slow file block the next while still claiming in name order, capping what runs at once, keeping a serial spool finishing in order, and refusing to let a colliding drop overwrite a claim in flight; the instance lock recording its holder, refusing a live one, taking over a stale one, and not deleting a lock somebody else has taken; and a room's context size recorded from real usage, ignored when a failed turn reports zeroes, and updated by compaction

## 0.2.3 (2026-09-01)

The spool learns to point the other way. A script could always ask the bot to
*say* something; now it can give the bot something to *do*. The documentation
was rebuilt around the pair, and the README went back to being a front page.

### New Features

* **An inbox** (`src/inbox.js`): a spool whose files are run as prompts, so a cron job or a script can give the agent work. Only the reply is posted; the prompt is not. Reaching for the outbox instead fails quietly and did — a scheduled cue was posted to the room as the bot, and a bot ignores its own messages, so the instruction was seen by everyone except the agent it was addressed to. Takes `{"prompt", "room"?, "from"?}` or a plain `.txt`; a file carrying `body` is parked with a note saying it belongs in the outbox
* The spool mechanics both directions share — claiming by rename, filename order, parking a crash's claim rather than repeating work, `fs.watch` backed by a poll — moved to `src/spool.js`. The outbox behaves exactly as before, which its tests establish
* `AGENTS.md` says which spool to reach for, chosen by who has to think: a script that can produce the finished text writes it to the outbox, which costs nothing and still reports when the agent is busy or broken; the inbox is for when producing it needs judgement or a tool a script does not have. The agent is who will write the next scheduled job, and without the rule everything becomes a prompt now that everything can be
* `.info` lists the extensions the bot is running — the ones that initialised once a session exists, and otherwise what `settings.json` asks for, saying which of the two it is showing. Failures are named. Extensions are where the agent's tools come from, and nothing reported them: asked to compare "the skill list", two bots both found zero skills and concluded they were identical, while one had `pi-web-access` and the other had none

### Documentation

* The roadmap is gone. Its ticked items had fallen well behind what shipped, and its unticked ones were wishes rather than plans — the two that describe real shortcomings were already in Known gaps, and the third (a systemd unit) has joined them. A list that flatters the past and guesses at the future is worse than no list
* The README is a front page again: what it is, how it works, getting started, troubleshooting, the command table, and a map of the rest. It had grown to 894 lines, so the reference material moved into `docs/` — configuration, model providers, commands, spools, the main room, multi-bot rooms, extending, and running it. Three paragraphs that repeated Getting started went with it
* `docs/blog/` is seven numbered chapters in the order the events happened, rewritten for a reader who does not work on this. The dates had collided — four posts shared one day and sorted alphabetically, which put the outbox's origin story after the story it sets up

### Tests

* 133 tests, up from 120: every inbox drop shape and the refusals beside it — a body that belongs in the outbox, an empty prompt, a drop with no room and no main room, an orphaned claim, and filename order — and naming an extension from its install path, reporting what actually loaded once a session exists, and falling back to `settings.json` while saying that is what it is showing

## 0.2.2 (2026-08-29)

The agent learns what it is, who it is, and who is talking to it. Almost all of
it was found by emptying `MATRIX_ALLOWED_USERS` and watching two bots left alone
in a room together.

### Breaking Changes

* **Everything the bot sends is now `m.notice`**, where it was `m.text`. Clients
  render notices differently — muted, in Element — so every message the bot
  posts changes appearance, and anything downstream matching on `m.text` stops
  matching. `m.notice` is how an automated client says a message came from a
  machine, which is what this bot is
* **A run of automated messages in one room is cut off after three**, resuming
  the moment a person speaks. With the allowlist empty, two instances in a room
  answered each other for 59 turns, each running shell commands on the other's
  output with nobody present. Deciding when an exchange is finished is the
  agent's own judgement, and it does that well — once told silence was a reply,
  one went quiet after two turns without being made deaf to the other. But
  judgement is a disposition rather than a limit, and the 59 turns are what its
  absence looks like, so the limit is there for the case where it fails
* Silence is scoped to messages that are *not for you*. The rule said to answer "when you have something to add", which is a judgement about content — and small talk contains nothing to add, so an agent greeted by name six times running answered `.` to all of them and posted nothing. Being addressed is now the test rather than having something to contribute: a greeting, a question or your name gets an answer, whoever is asking; two other participants talking to each other does not
* What the limit withholds is still heard. Not answering is the point; not
  hearing would leave the agent with a hole in the conversation that everyone
  else in the room saw, so asked later what was decided it could neither say nor
  explain. Unanswered messages are carried into the context of the next reply —
  the last ten, truncated, since what is being withheld is a bot that will not
  stop talking

### Fixes

* **The agent was never told who was speaking.** The sender reached `#runPrompt`, went into a log line, and stopped there — so asked whether a message came from another bot it answered "still `@aguegu` on my side" three times, having been given nothing either way. Ordinary messages now carry `This message is from <sender>`, on every turn because it changes between turns
* **The main room's admin was inferred from the membership.** It was "the member who is not the bot", which is only sound while `MATRIX_ALLOWED_USERS` says who counts; empty, that member is merely the other member, and in a room holding two bots it would have recorded one as the other's admin. It is now whoever invited the bot into the room that became the control channel — a fact the bot observed. The allowlisted member is the fallback for a room adopted at startup where no invite was seen, and with neither, nothing is recorded
* **The agent used the outbox to reply**, answering one question twice: once as a delivered file, once as its own reply carrying the tool lines that showed it writing the file. `AGENTS.md` described the outbox as the way to post from a script and never said it was not the way to answer
* The shipped `AGENTS.md` listed the commands the bot intercepts but omitted `.reload`, so the agent could offer to handle one it never sees

### Improvements

* `.info` and the startup log name the build — `piagent-matrix 0.2.2 (b15ea83)`, and `.info` also gives when the process started and how long it has been up. The version alone could not answer the question that kept coming up, since `package.json` is bumped once when a release opens and every host between two releases reports the same number while running different code. The commit is read from `.git` rather than by running git, so there is no subprocess at startup; a deployment without a checkout reports the version alone, and a worktree or submodule — where `.git` is a file pointing elsewhere — is followed. It is read once at startup rather than per `.info`, so a host pulled but not restarted reports the code it is running rather than the code on disk. What it cannot see is a tree edited in place
* The agent is told its **name** — the localpart of its user id, so `@bk18pi:example.org` is `bk18pi` — and to introduce itself by it. It had been answering "I'm a coding agent — pi — reached over Matrix", which is the category rather than the individual, and was equally true of the other bot in the room
* It is told its **user id and working directory**. The id comes from `client.getUserId()` rather than `MATRIX_USER_ID`: the server's answer for the token in use, which is the one that differs when credentials have been swapped without swapping `data/token.json`
* The first message in a room **names the room** — `Matrix room "Ops" (!r:example.org)` — with a note that a room can be renamed and an id cannot. The name is fetched once per session and flattened first: whoever made the room chose it and it lands inside the `[context]` block, so brackets are stripped and whitespace collapsed, or a name could forge the end of that block and have what follows read as instruction
* **Silence is a reply.** To say nothing the agent answers with a single `.`, which the bot drops. Asking for "no text at all" did not work — a model has to end its turn somehow, and one ran `bash true` twice looking for a way to do nothing before sending `.` anyway, which reached the room because `.` is not empty
* **No narrating work the room already watched.** Every tool call is rendered into the reply with a tick when it succeeds, so "Done! Message sent." after each one repeats the screen back at the person
* Installing warns about a `{{PLACEHOLDER}}` nothing supplies, and reports it. Substitution leaves an unknown name in place, which beats blanking it — an emptied path reads as a working instruction — but a typo would otherwise have shipped an instruction to look in a directory called `{{DATA_DIR}}`
* The outbox protocol moved from the per-room briefing into `AGENTS.md`, using `{{OUTBOX_DIR}}`. It was in both, precisely in one and vaguely in the other, and the briefing is part of the first user message, so it sits in the session history and is re-sent every turn regardless. One copy now — and a session opening with a slash command has it, where before it skipped the briefing entirely

### Documentation

* `SECURITY.md` and the committed `.env` say what an empty `MATRIX_ALLOWED_USERS` actually means. Not only that anyone may run shell commands through the bot, but that another bot can drive it unattended; that the bot **autojoins every invite** — the allowlist is checked on messages, not on invites — so anyone who knows its user id can put it in a room and be that anyone, federation included; and that a room only *fits* to be adopted as the main room because an allowlisted member is in it, so with no allowlist the first stranger to invite a fresh bot takes its control channel and is recorded as its admin
* `docs/pi-integration.md`: `agentDir` does not reach extensions, which is why the bot exports `PI_CODING_AGENT_DIR`; and prompt templates are not context — they load from `agentDir/prompts` and `$cwd/.pi/prompts` and expand only on a leading `/<name>`, which is the argument for keeping `AGENTS.md` short

### Tests

* 120 tests, up from 85: what makes a room fit and who its admin is, the sender on every turn, the room name and a name attempting to forge the end of the context block, silence and a reply that merely ends in a full stop, a placeholder nothing supplies, naming the build from a loose ref, a packed ref, a detached HEAD and no checkout at all, and the bound on bots answering bots with what it withholds carried into the next reply

## 0.2.1 (2026-08-29)

Commands in Matrix, and a main room that adopts itself, says so, checks itself
and recovers on its own.

### Breaking Changes

* `PI_MODEL` and `PI_THINKING_LEVEL` are gone: removed from `.env` and no longer read from the environment at all, along with the `PI_PROVIDER` tie-break for a bare model id. Say `.model <provider/id>` and `.thinking <level>` once in the main room instead; the choice is recorded in `DATA_DIR/agent.json`. A bot that has never been told starts on the first available model at thinking level `low`. Reading them was worse than redundant — an interactive `pi` run exports `PI_MODEL` and `PI_PROVIDER` into the shell, so an operator who had run pi in that terminal handed the bot a model without knowing
* `MATRIX_MAIN_ROOM` is gone. It was the escape hatch for a wrong record when the only correction was editing a file on the host, and it fought the new one: a pinned room could not be dropped, so the self-healing path was disabled for anyone who had set it
* **Re-electing a main room is now kick-then-invite**, not a file edit. Deleting `data/main-room.json` is no longer the gesture, and a bot in several rooms with no record adopts none of them until one fits

### New Features

* **Commands** (`src/commands.js`): `.info` reports the model and thinking level, `.model` and `.thinking` change them, `.rooms` lists where the bot has been invited and leaves rooms, `.reload` is pi's `/reload` across every live session, `.help` lists the lot. A short allowlist, not a passthrough — unrecognised slash text stays an ordinary prompt, so a message beginning with a path still reaches the agent. Advertised with a leading dot, because Element intercepts `/` for its own commands; `/` still works in clients that pass it through. pi's `!` bash escape is not offered
* **Commands belong to the main room.** Each one either reconfigures the bot for every room — one agent config backs them all — or reports on it. A working room may hold people who are not the bot's admin, so it gets `.info` and nothing else; anything else there is refused flatly, with no reason and never the main room's id. `.help` does not run there either, so nothing outside the main room hints that one exists
* `.model` and `.thinking` apply to every live session and to any created later, and record the choice under `DATA_DIR/agent.json`, so changing either no longer means editing `.env.local` and restarting. Bare, they report the current setting and list what is on offer, since a room cannot present pi's selector UI
* `.rooms` gives each room's name, id and member count, and marks the main room. `.rooms leave <roomId>` walks the bot out of one — deliberate on its own, since the id is copied from the listing, so nothing to confirm and no "leave everything" form. The main room's own id works too, with the goodbye sent before the bot goes. The room's cached pi session is dropped with it
* **The main room adopts itself and repairs itself.** A room is taken when there is none recorded and the room *fits*: the bot is in it, it holds no more than two members, and — with `MATRIX_ALLOWED_USERS` set — one of them may run commands. That replaces "the first room joined", which said nothing about whether a room was suitable and let whoever sent the invite decide. The bot then announces the adoption in that room, rather than recording it to disk and saying nothing
* **A record that stops working is dropped**, and the next fitting room takes over. `room.leave` is handled — kicked, banned and left alike, logged with who and why — and startup verification checks the bot is in the room, that an allowlisted user is there, and that it holds no more than two members. Only being outside the room is disqualifying: strict to adopt, lenient to keep. Nothing blocks startup, since a bot that refused to start could not accept the invite that fixes it
* `data/main-room.json` records the **admin** the room was adopted for beside the room id — an id says where the bot takes orders, not who from. Older records carry none and are read as before
* The bot ships an `AGENTS.md` in `agent/` and installs it into `PI_AGENT_DIR` on every start, so the agent knows what it is in every session: reached through a chat client rather than a terminal, one session per room, one run at a time, answers posted whole and never edited afterwards, which commands the bot answers before it sees them, and that it has no Matrix client of its own. It points at `data/main-room.json`, so "who are you" names the real main room and admin instead of inventing them. A context file rather than a command, because that is a question people ask in conversation. `{{DATA_DIR}}`, `{{BOT_CWD}}` and `{{OUTBOX_DIR}}` are substituted as it is written, since the agent runs in none of those places. An `AGENTS.md` the bot did not write is left alone — and warned about, because pi reads only one context file per directory, so keeping it means the bot's own never loads
* `reload()` calls pi's `AgentSession.reload()` on each live session rather than disposing them, matching the TUI: resources are re-read, sessions and their history survive

### Fixes

* The room briefing no longer prefixes context onto a message starting with `/`. pi expands prompt templates and skill commands only when the text starts with a slash, so the briefing silently turned the first `/verify` of every session into ordinary text. Such a turn now stays unbriefed and the context goes out with the next ordinary message
* `PI_CODING_AGENT_DIR` is exported to match `agentDir`. Passing `agentDir` to `createAgentSession` steers pi's own loading but not pi's exported `getAgentDir()`, which extensions call — so an extension kept its state in the operator's home directory while the session ran out of `data/pi`. Nothing had noticed because no installed extension asked

### Tests

* 85 tests, up from 33: command parsing and which room may run each one, the recorded model and thinking level and their precedence over startup defaults, what makes a room fit to be adopted, dropping a main room that stopped working, each verification outcome, and installing the shipped context file without clobbering someone else's

## 0.2.0 (2026-08-28)

Hardening pass over the agent path, plus the plumbing needed to run the bot
unattended on more than one host.

### Breaking Changes

* Other processes no longer open their own Matrix client. `scripts/hourly-stats.mjs` is removed; senders spool a file into `OUTBOX_DIR` and the running bot delivers it. Two clients on one crypto store desynchronise the Megolm ratchet
* `OUTBOX_DEFAULT_ROOM` is gone. The bot records a **main room** — the first room it is invited to — in `data/main-room.json`. `MATRIX_MAIN_ROOM` pins one if the recorded room is wrong
* pi credentials come from `PI_AGENT_DIR` (default `${DATA_DIR}/pi`), not `~/.pi/agent`. Existing deployments must authenticate a provider there
* `BOT_CWD` is required and defaults to `/tmp/piagent-workspace` in the committed `.env`; the bot refuses to start without it. The old default was `process.cwd()`, which for this repo is the directory holding its own credentials
* Agent replies are sent with `format: org.matrix.custom.html` and a `formatted_body`
* Package renamed `tradebots-matrix-v2` -> `piagent-matrix`, and marked `private`

### New Features

* **Main room** (`src/main-room.js`): the bot's control channel, adopted from the first room it joins and recorded on disk. Join order cannot be recovered from `getJoinedRooms()`, so it is observed at join time. One existing room is adopted at startup; several means it refuses to guess. Read per send, so a bot invited after it started needs no restart
* **Outbox** (`src/outbox.js`): a spool the running bot watches, so cron jobs and scripts can post without touching the crypto store. `*.txt` goes to the main room, `*.json` takes `{ room?, body, html? }`. Writers `rename()` in, so a partial file is never read; drops process in filename order; failures park as `.failed`; anything spooled while the bot was down goes out on the next start
* **Markdown rendering** (`src/markdown.js`): markdown-it with `html: false`, then sanitize-html down to the tags Matrix clients render. Tool lines bypass it, since `_` and `*` in JSON arguments would be read as emphasis
* The agent is told its room id and the outbox protocol on the first prompt of each session, so "post a report here every hour" is answerable
* `PI_AGENT_DIR`: pi's auth, model cache, settings, skills and extensions live with the bot, so it works as a service account or in a container

### Fixes

* **Megolm ratchet desynchronisation.** A second process sharing the crypto store advanced its own copy of the ratchet, emitting different plaintexts at the same `message_index` (observed 7 → 5 → 6 → 7, then 9 twice). Strict clients reject the duplicate as a replay; FluffyChat showed "undecryptable" where Element did not
* **Agent errors terminated the bot.** `handleMessage` rethrew into an `async` EventEmitter listener, which neither awaits nor catches, so Node exited on the unhandled rejection. Contained at the boundary, plus a process-level backstop
* **A second message in one room got no reply.** pi's `prompt()` queues and returns immediately when the session is already streaming, so the caller rendered an empty buffer while its answer replaced the first message's text. Runs are serialized per room
* **A failed session was cached and replayed.** A rejected creation promise stayed in the map, so a room that failed once reported that same error forever — fixing the cause changed nothing until a restart
* **Prose before a tool call was discarded.** The reply buffer was assigned rather than appended, and each assistant message's `partial` covers only itself. Replies are now blocks in event order
* `tool_execution_end` annotated the last tool line rather than the most recent unfinished one
* Authentication instructions named the wrong variable: pi reads `PI_CODING_AGENT_DIR`, not this project's `PI_AGENT_DIR`, so the documented command wrote credentials where the bot could not find them — and the runtime error repeated that command back
* The "no provider" error now distinguishes a missing `auth.json` from an empty one from unusable credentials. Both pi and this bot write `{}` at startup, so the file existing means nothing
* `~/.pi/agent` is no longer presented as pi's fixed default; it comes from `piConfig.configDir` in whichever build is running

### Improvements

* Per-room backlog cap with an explicit refusal, rather than an invisible queue
* `waitUntilIdle()` before prompting, so a still-streaming session cannot produce a silent no-op
* Loaded extensions are logged, and failures reported — previously both were silent
* `npm run cross-sign` no longer buries its result in ~250 lines of SDK logging that ended in abort noise (`VERBOSE=1` restores it)
* Known-noisy `M_NOT_FOUND` probes filtered from the log
* `createSession` injection seam on `AgentManager`, which is what makes the agent testable

### Documentation

* README rewritten around what the project is, with an ordered **Getting started** walkthrough and a troubleshooting table mapping each startup error to the step that fixes it
* `SECURITY.md`: the agent's operational blast radius first, then an assessment of the `npm audit` advisories — all from `matrix-bot-sdk` depending on the deprecated `request`, unfixable upstream and unreachable from this bot's code paths
* MIT `LICENSE`. The repo previously declared ISC in `package.json` with no licence file, which on a public repo means nobody may legally use it
* `docs/pi-integration.md`: how pi is wired in and the API behaviour that is easy to get wrong
* `docs/web-search-tools.md`: corrected — those tools come from the `pi-web-access` extension, not pi's core
* `docs/blog/`: two posts, on verification and on handing a codebase between agents
* The committed `.env` is a template again; site-specific values live in `.env.local`
* Documented that `@matrix-org/matrix-sdk-crypto-nodejs` needs its `postinstall` — it ships no binary, so a blocked install script leaves the bot unable to start

### Tests

* 33 tests with `node:test`, the first in this repo: agent serialization, session-failure recovery, reply rendering, markdown sanitisation, outbox routing and refusal paths, main-room adoption
* Each fake was checked against the bug it covers — run against the pre-fix code, they fail

## 0.1.0 (2026-08-26)

Rewrite onto `matrix-bot-sdk`, replacing the `matrix-js-sdk` bot that could not
persist crypto across restarts.

### New Features

* Matrix bot on matrix-bot-sdk with a file-based rust crypto store (SQLite), so device keys survive restarts. The previous stack offered only indexeddb or in-memory, and there is no indexeddb in Node — every boot minted a new Olm account
* End-to-end encryption, handled transparently for encrypted and unencrypted rooms
* Device cross-signing via `npm run cross-sign`, which reads the account's existing self-signing key from secret storage rather than resetting the identity
* `config` + `dotenv-flow`: `.env` committed as a template, `.env.local` for real values
* pi-coding-agent wired in, one session per room
* Per-room session persistence under `SESSION_DIR`, so conversation memory survives restarts
* `PI_MODEL` / `PI_THINKING_LEVEL` / `BOT_CWD` documented in the committed `.env`
* Typing indicator and read receipts as progress feedback
* Allowlist via `MATRIX_ALLOWED_USERS`

### Fixes

* Timeline handler uses `getId()` and tolerates non-`MatrixEvent` objects
* Known-noisy `M_NOT_FOUND` HTTP errors filtered from log output — the encryption-state probe returns 404 for unencrypted rooms
