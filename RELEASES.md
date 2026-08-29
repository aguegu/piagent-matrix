# Releases

## 0.2.2 (2026-08-29)

The agent learns what it is, who it is, and who is talking to it. Almost all of
it was found by emptying `MATRIX_ALLOWED_USERS` and watching two bots left alone
in a room together.

### Breaking Changes

* **Everything the bot sends is now `m.notice`**, where it was `m.text`. Clients
  render notices differently — muted, in Element — so every message the bot
  posts changes appearance, and anything downstream matching on `m.text` stops
  matching. The reason is that the bot also *accepts* `m.text`: with the
  allowlist empty, two instances in one room each treated the other's output as
  a prompt and answered each other for 59 turns, running shell commands on it.
  A notice marks a message as coming from an automated client, and bots are
  expected to ignore them; this bot already ignored anything that was not
  `m.text`, so the pair is closed from both ends. It is a convention, not a
  guarantee — the allowlist is still what decides who may drive the agent

### Fixes

* **The agent was never told who was speaking.** The sender reached `#runPrompt`, went into a log line, and stopped there — so asked whether a message came from another bot it answered "still `@aguegu` on my side" three times, having been given nothing either way. Ordinary messages now carry `This message is from <sender>`, on every turn because it changes between turns
* **The main room's admin was inferred from the membership.** It was "the member who is not the bot", which is only sound while `MATRIX_ALLOWED_USERS` says who counts; empty, that member is merely the other member, and in a room holding two bots it would have recorded one as the other's admin. It is now whoever invited the bot into the room that became the control channel — a fact the bot observed. The allowlisted member is the fallback for a room adopted at startup where no invite was seen, and with neither, nothing is recorded
* **The agent used the outbox to reply**, answering one question twice: once as a delivered file, once as its own reply carrying the tool lines that showed it writing the file. `AGENTS.md` described the outbox as the way to post from a script and never said it was not the way to answer
* The shipped `AGENTS.md` listed the commands the bot intercepts but omitted `.reload`, so the agent could offer to handle one it never sees

### Improvements

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

* 99 tests, up from 85: what makes a room fit and who its admin is, the sender on every turn, the room name and a name attempting to forge the end of the context block, silence and a reply that merely ends in a full stop, and a placeholder nothing supplies

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
