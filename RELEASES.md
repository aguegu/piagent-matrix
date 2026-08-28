# Releases

## 0.2.1 (in progress)

A command surface for the bot, and a main room that announces itself and is
checked rather than trusted.

### Breaking Changes

* `PI_MODEL` and `PI_THINKING_LEVEL` are gone: removed from `.env` and no longer read from the environment at all, along with the `PI_PROVIDER` tie-break for a bare model id. Both are runtime settings now — say `.model <provider/id>` and `.thinking <level>` once in the main room and the choice is recorded in `DATA_DIR/agent.json`. A bot that has never been told starts on the first available model at thinking level `low`. Reading them was worse than redundant: an interactive `pi` run exports `PI_MODEL` and `PI_PROVIDER` into the shell, so an operator who had run pi in that terminal handed the bot a model without knowing
* `MATRIX_MAIN_ROOM` is gone. It was the escape hatch for a wrong record back when the only correction was editing `data/main-room.json` on the host; kicking the bot out of the main room now drops the record and the next fitting room takes over, so a second source of truth would only be something to argue with
* `data/main-room.json` records the **admin** the room was adopted for, beside the room id — the one member who is not the bot. An id alone says where the bot takes orders, not who from. The startup log and `.rooms` name them, and verification flags a main room whose recorded admin has left. Records written before this carry no `admin` and are read as before
* A room is adopted as the main room when there is none recorded and the room **fits**: the bot is in it, it holds no more than two members, and — when `MATRIX_ALLOWED_USERS` is set — one of them may run commands. That replaces "the first room joined", which said nothing about whether the room was suitable and let whoever invited the bot decide. A stranger can no longer hand it a control channel, and a busy working room cannot become one by accident

### New Features

* **Commands** (`src/commands.js`): `.info` shows the model and thinking level, `.verify` runs the `verify` prompt template, `.reload` is pi's `/reload` applied to every live session, `.model` and `.thinking` report or change the agent's settings, `.help` lists what is installed. A short allowlist rather than a passthrough — unrecognised slash text stays an ordinary prompt, so a message beginning with a path still reaches the agent. pi's `!` bash escape is not offered
* `.rooms` lists the rooms the bot is in — name, id, member count, and which one is the main room — and `.rooms leave <roomId>` walks it out of one. Naming an id copied from the listing is deliberate on its own, so it happens straight away; there is no "leave everything" form, since leaving is visible to everyone in those rooms and takes a fresh invite to undo. Naming the main room's own id works too, with the goodbye sent before the bot goes, since afterwards there is no room to reply into. The room's cached pi session is dropped with it
* The bot ships an `AGENTS.md` in `agent/` and installs it into `PI_AGENT_DIR` on every start, so the agent knows what it is in every session: reached through a chat client rather than a terminal, one session per room, one run at a time, answers posted whole and never edited afterwards, which commands the bot answers before it sees them, and that it has no Matrix client of its own. It also points at `data/main-room.json`, so "who are you" names the real main room and admin instead of being invented. A context file rather than a command, because that is a question people ask in conversation — a `.whoami` would only have answered when someone knew to type it
* `{{DATA_DIR}}`, `{{BOT_CWD}}` and `{{OUTBOX_DIR}}` are substituted as it is written — the agent runs in none of those places, so anything naming a path needs an absolute one and it differs per host. An `AGENTS.md` the bot did not write is left alone: the installed copy carries a marker line. pi reads one context file per directory — the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` — so keeping someone's file means the bot's own does not load, and the warning says to move those instructions to `$BOT_CWD/AGENTS.md`, which pi loads as well
* Advertised with a leading dot. Element intercepts `/` for its own commands, so `/help` opens Element's help and never reaches the bot; `/` is still accepted for clients that pass it through
* `.model` and `.thinking` apply to every live session and to any created later, and record the choice under `DATA_DIR/agent.json`, so changing either no longer means editing `.env.local` and restarting. Bare, they report the current setting and list what is on offer, since a room cannot present pi's selector UI
* **Commands belong to the main room.** Each one either reconfigures the bot for every room — one agent config backs them all — or hands a chat message the agent's own reach. A working room may hold people who are not the bot's admin, so it gets `.info` and nothing else. Anything else there is refused flatly, with no reason and never the main room's id, and `.help` does not run there either, so nothing outside the main room hints that one exists. With no main room established everything is allowed, rather than leaving the bot with one usable command
* The bot announces adoption in the room it has just taken as its control channel, saying what that means. Adoption was otherwise invisible — it happens on join and goes straight to disk, so the only way to learn which room the bot took commands from was to read the log
* **The main room record is dropped as soon as it stops being usable** — the bot is kicked from it, or starts up to find itself no longer in it — and the next room that fits takes over. A pointer to an unreachable room was worse than none: commands run in the main room and nowhere else, so the bot went silent while looking healthy, and every alternative was declined because a room was *already* recorded. Recovering meant deleting `data/main-room.json` on the host. Moving the control channel is now kick-then-invite: a room just joined wins outright if it fits
* `room.leave` is handled, covering kicked, banned and left alike. Leaving any room is logged with who did it and why; leaving the main room drops the record
* Strict to adopt, lenient to keep: a main room that later grows past two members, or whose admin steps out, is warned about but kept — it still works. Only being outside the room is disqualifying
* The main room is verified at every start: the bot is in it, an allowlisted user is in it, and it holds no more than two members. A recorded room was trusted on sight, so one the bot had been kicked from looked healthy right up until every command was refused and outbox drops piled up as `.failed`. No check blocks startup: a bot that refused to start could not accept the invite that fixes it. Being outside the room clears the record; the other two warn. The notice reaches the main room only where someone can act on it, and the log always gets everything
* `reload()` calls pi's `AgentSession.reload()` on each live session rather than disposing them, matching the TUI: resources are re-read, sessions and their history survive

### Fixes

* The room briefing no longer prefixes context onto a message starting with `/`. pi expands prompt templates and skill commands only when the text starts with a slash, so the briefing silently turned the first `/verify` of every session into ordinary text. Such a turn now stays unbriefed and the context goes out with the next ordinary message

### Tests

* 83 tests, up from 33: command parsing and which room may run each one, the recorded model and thinking level and their precedence over startup defaults, what makes a room fit to be adopted, dropping a main room that stopped working, and each verification outcome

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
