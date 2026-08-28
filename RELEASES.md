# Releases

## 0.2.1 (in progress)

### New Features

* Commands (`src/commands.js`): `.verify` runs the `verify` prompt template, `.reload` is pi's `/reload` applied to every live session, `.help` lists what is installed. A short allowlist rather than a passthrough — unrecognised slash text stays an ordinary prompt, so a message beginning with a path still reaches the agent
* Advertised with a leading dot. Element intercepts `/` for its own commands, so `/help` never reaches the bot; `/` is still accepted for clients that pass it through
* `.model` and `.thinking` report where the agent is and what else is on offer, or change it. The choice applies to every live session and is recorded under `DATA_DIR/agent.json`, so it survives a restart — `PI_MODEL` and `PI_THINKING_LEVEL` are demoted to what a bot that has never been told starts with. Changing either no longer means editing `.env.local` and restarting
* `PI_MODEL` and `PI_THINKING_LEVEL` are gone from `.env` and no longer read from the environment at all, along with the `PI_PROVIDER` tie-break for a bare id. Both are runtime settings now, so an env var that a recorded choice overrides is not a knob — and an interactive `pi` run exports `PI_MODEL`/`PI_PROVIDER` into the shell, which let a stray export decide the bot's model invisibly. A bot that has never been told starts on the first available model at thinking level `low`
* **Commands belong to the main room.** Each one either reconfigures the bot for every room (`.model`, `.thinking`, `.reload`) or hands a chat message the agent's own reach (`.verify`), so the bot's control channel is where they go
* `.info` is the exception, and the whole command surface of a working room: it shows the model and thinking level and changes nothing. Anything else there gets a flat `\`.model\` is not available here.` — no reason, and never the main room's id. `.help` does not run outside the main room either, so nothing there hints a control channel exists. With no main room established, everything is allowed rather than leaving the bot with one usable command

* The bot announces adoption in the room it just took as its control channel, instead of recording it to disk and saying nothing. The room that gets the powers is told it has them
* Adoption is now a 0 → 1 transition only: the bot takes its control channel from the room it is invited to while it is in no others. Previously any join adopted as long as nothing was recorded, so a bot that had lost `data/main-room.json` handed the control channel to whichever room it next joined — an arbitrary room, chosen by whoever sent that invite. An unknown room count declines too

### Fixes

* The room briefing no longer prefixes context onto a message starting with `/`. pi expands prompt templates and skill commands only when the text starts with a slash, so the briefing silently turned the first `/verify` of every session into ordinary text. Such a turn now stays unbriefed and the context goes out with the next ordinary message

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
