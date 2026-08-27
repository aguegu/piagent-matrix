# Releases

## 0.2.0 (in progress)

### Breaking Changes

* External senders no longer open their own Matrix client. `scripts/hourly-stats.mjs` removed; the cron wrapper `~/.local/bin/hourly-stats.sh` now spools to `OUTBOX_DIR` instead (original kept as `hourly-stats.sh.bak`)
* Agent replies are sent with `format: org.matrix.custom.html` and a `formatted_body`
* The agent reads its pi credentials from `PI_AGENT_DIR` (default `${DATA_DIR}/pi`) instead of `~/.pi/agent`. Existing deployments must authenticate a provider there, or copy `~/.pi/agent/auth.json` across
* Package renamed `tradebots-matrix-v2` -> `piagent-matrix`, and marked `private` so it can never be published to npm by accident

### New Features

* Outbox (`src/outbox.js`): spool directory the running bot watches, so other processes can post without touching the crypto store. `*.txt` uses the default room, `*.json` takes `{ room?, body, html? }`
* Writers hand off by `rename()` into the spool, so a partial file is never read. Files process in filename order; failures are parked as `.failed` rather than retried forever
* Messages spooled while the bot is down are sent on next start
* `OUTBOX_DIR` and `OUTBOX_DEFAULT_ROOM` config
* Markdown rendering (`src/markdown.js`): markdown-it with `html: false`, then sanitize-html down to the tags Matrix clients render
* `PI_AGENT_DIR`: pi's auth, model cache and settings live with the bot, so it no longer depends on whoever runs it having logged into pi, and works as a service account or in a container. Verified isolated — the configured directory resolves 3 models, an empty one resolves 0

### Fixes

* Stopped presenting `~/.pi/agent` as pi's fixed default. It comes from `piConfig.configDir` in whichever pi build is running — `.pi` for the npm package, but a standalone install can differ (one reported `~/.config/pi`). Setting `PI_CODING_AGENT_DIR` explicitly sidesteps the question entirely, which is now what the docs recommend
* The "no provider" error now says which of the three states it found — no `auth.json`, an empty `{}` one, or credentials that exist but are unusable. Both pi and this bot write an empty `auth.json` at startup, so an operator who opens pi and exits sees the file appear and reasonably concludes they logged in
* Guidance now leads with `/login` rather than an API key in `.env.local`. pi accepts a pasted API key, so logging in works headless for api-key providers and keeps the credential in pi's own store instead of a project file; only OAuth needs a browser
* Authentication instructions named the wrong environment variable. `PI_AGENT_DIR` is this bot's; the pi CLI reads `PI_CODING_AGENT_DIR` and ignores ours, so `PI_AGENT_DIR=./data/pi npx pi` wrote credentials to `~/.pi/agent` — appearing to succeed while leaving the bot with none. Corrected in the README, the `.env` template and the runtime error message, which had been repeating the wrong command back to the operator

* **Megolm ratchet desynchronisation.** A second process sharing the bot's crypto store loaded the same outbound session and incremented its own copy of the counter, emitting different plaintexts at the same `message_index` (observed: 7 → 5 → 6 → 7, then 9 twice). Strict clients reject the duplicate as a replay — FluffyChat showed "undecryptable" where Element did not. One process now owns the crypto store
* **Agent errors terminated the bot.** `handleMessage` rethrew into an `async` EventEmitter listener, which neither awaits nor catches, so the rejection was unhandled and Node exited. Contained at the boundary, plus a process-level `unhandledRejection` backstop
* **A second message in one room got no reply.** pi's `prompt()` queues and returns immediately when the session is already streaming, so the caller rendered an empty buffer; its answer instead replaced the first message's text, leaving the earlier question apparently unanswered. Runs are now serialized per room
* **Assistant text before a tool call was discarded.** The reply buffer was assigned rather than appended, and each message's `partial` covers only itself, so only the final message survived. Replies are now blocks rendered in event order, with tool lines where they actually occurred
* `tool_execution_end` annotated the last tool line rather than the most recent unfinished one, mismarking overlapping calls
* Tool lines bypass markdown — `_` and `*` in JSON args were being read as emphasis

### Improvements

* The agent is told which room it is in, on the first prompt of each session, along with how to reach that room later through the outbox. It previously received only the message text, so "post this here" or "set up a cron that reports here" were unanswerable — anything it scheduled wrote a `*.txt`, which goes to the configured default room regardless of where the request was made
* The outbox default room no longer guesses. With one joined room it still falls back to it; with several it refuses and warns, since `getJoinedRooms()` has no meaningful order and picking the first would deliver reports to an arbitrary room while appearing to work

* `npm run cross-sign` no longer buries its output. matrix-js-sdk logged every HTTP request and the rust crypto layer every key operation — roughly 250 lines, ending in abort errors from `stopClient()` that made a successful run look like a failure. The SDK logger is now silenced by default (`VERBOSE=1` restores it), leaving the step trace and the server-side verification

* `BOT_CWD` defaults to `/tmp/piagent-workspace` in the committed `.env` rather than falling back to `process.cwd()` in code. A subdirectory rather than `/tmp` itself: `/tmp` is mode 1777, so working there directly would expose the agent's output to every user on the box and let others plant files it reads; a subdirectory the bot creates gets the bot user's own permissions. The old default pointed the agent at whatever directory the bot was started from — for this repo, the one holding `.env.local`, `data/token.json` and `data/pi/auth.json`. The directory is created on startup and resolved to an absolute path, since pi records `cwd` in each session header and matches it on resume
* The bot refuses to start when `BOT_CWD` is unset, so a `.env` that dotenv-flow cannot find (a service started from another directory) fails loudly instead of silently reverting to the old default

* Per-room backlog cap (8) with an explicit refusal, instead of an unbounded invisible queue
* `waitUntilIdle()` guard before prompting, so a still-streaming session can never silently produce a no-op run
* `createSession` injection seam on `AgentManager` for testing
* Outbox and agent errors log with context rather than failing silently

### Documentation

* Documented setting up a provider from nothing: an API key in `.env.local` is enough, since dotenv-flow puts it in the environment and pi writes `data/pi/auth.json` on first use. No pi install, no login, no copying credentials. The earlier instructions assumed pi was already installed and authenticated
* README opens with an ordered **Getting started** walkthrough, in dependency order, plus a troubleshooting table mapping each startup error to the step that fixes it. A fresh clone previously failed one step at a time — most visibly at the first message, with `No models with complete auth are available in …`, because pi's provider must be authenticated in `PI_AGENT_DIR` rather than `~/.pi/agent`

* Documented that `@matrix-org/matrix-sdk-crypto-nodejs` requires its `postinstall` to run: it ships no binary and downloads the native crypto library at install time, so a blocked install script leaves the bot unable to start
* `SECURITY.md`: how to report a vulnerability, the agent's operational blast radius, and an assessment of the 8 `npm audit` advisories — all of which trace to `matrix-bot-sdk` depending on the deprecated `request`, are unfixable upstream, and are unreachable from this bot's code paths
* MIT LICENSE file added. The repo previously declared ISC in `package.json` with no LICENSE file at all — which meant that once published, default copyright applied and nobody could legally use it

* README rewritten around what the project is now, dropping the migration narrative. New sections for the message path, the outbox protocol, and the agent's blast radius; the config table grew from 8 rows to 14
* The committed `.env` is a pure template again. `BOT_CWD`, `PI_MODEL` and `OUTBOX_DEFAULT_ROOM` had accumulated real values, disclosing a self-hosted homeserver, a room id and a local username. They now live in `.env.local`; effective config is unchanged

### Tests

* Outbox suite: default-room routing, explicitly addressed `*.json` drops, filename ordering, delivery of messages spooled while the bot was down, and the two refusal paths — an unaddressed drop with no default room, and an orphaned `.sending` claim that must not be re-sent

* 15 tests with `node:test` — the first tests in this repo
* Fakes are checked against the bug they cover: the serialization and rendering fakes both reproduce the original failure when run against the old logic

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
