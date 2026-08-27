# piagent-matrix

A Matrix bot that fronts the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
over instant messaging. Message it from an allowlisted account and your text
becomes a prompt; the agent's answer comes back as a formatted Matrix message.

Built on [`matrix-bot-sdk`](https://github.com/turt2live/matrix-bot-sdk) with
end-to-end encryption and an on-disk crypto store, so the bot keeps its device
identity across restarts.

## How it works

```
Matrix room ──► room.message ──► allowlist ──► AgentManager ──► pi AgentSession
                                     │                              │
                                read receipt                    text + tool events
                                typing indicator                    │
                                     ▼                              ▼
                             one formatted reply ◄──────────── buffered blocks

cron / scripts ──► outbox/ spool ──► the running bot ──► Matrix
```

- **One pi session per room.** Rooms are the conversation boundary; with
  `SESSION_DIR` set, each room's history survives restarts.
- **Runs are serialized per room.** pi queues a prompt issued mid-run and
  returns immediately, so overlapping messages would silently lose a reply.
  Each message waits its turn and owns a complete run.
- **Progress is a typing indicator**, not a placeholder message. Nothing is
  posted until the run finishes, and replies are never edited after the fact.
- **Only this process touches the crypto store.** Anything else that needs to
  post goes through the outbox.

## Setup

Requires Node 20+ (developed on 24).

```sh
npm install
cp .env .env.local     # then fill in .env.local
npm start
```

### The crypto binding needs its install script

`@matrix-org/matrix-sdk-crypto-nodejs` ships no binary. Its `postinstall`
(`download-lib.js`) fetches a ~22 MB native library from GitHub Releases for
your platform, and `index.js` loads it from next to itself. Without it,
`require()` fails with `Cannot find module '…-linux-x64-gnu'` and the bot cannot
start — no crypto binding, no E2EE.

npm may decline to run it:

```
npm warn install-scripts  @matrix-org/matrix-sdk-crypto-nodejs@0.4.0 (postinstall: node download-lib.js)
```

Approve that one and re-install:

```sh
npm install-scripts approve @matrix-org/matrix-sdk-crypto-nodejs
npm install
```

Then check it actually landed, before starting the bot:

```sh
ls node_modules/@matrix-org/matrix-sdk-crypto-nodejs/*.node
node -e "require('@matrix-org/matrix-sdk-crypto-nodejs'); console.log('crypto binding OK')"
```

The other scripts npm flags are safe to leave unapproved: `@google/genai`'s
preinstall is a literal no-op, and `protobufjs`'s postinstall is not needed by
consumers.

Two things that bite on servers:

- The download happens **at install time** and reaches
  `github.com/matrix-org/matrix-rust-sdk-crypto-nodejs/releases`. Restricted
  egress breaks the install; the script honours `https_proxy` / `HTTPS_PROXY`.
- It selects by `process.platform` / `process.arch`, with a musl check. On
  arm64 or Alpine it fetches a different build, so confirm one exists for your
  target.

`.env` is a committed template: keys, comments, and non-secret defaults.
`.env.local` holds the real values and is gitignored. `dotenv-flow` loads `.env`
first and lets `.env.local` override every key; real environment variables win
over both.

On first start the bot logs in with `MATRIX_PASSWORD` and writes
`data/token.json` (mode 0600). After that it reuses the stored token and never
needs the password again. Run `npm run cross-sign` once afterwards.

The agent needs a model provider of its own. It reads `PI_AGENT_DIR`
(default `data/pi`) rather than `~/.pi/agent`, so the bot does not depend on
whoever runs it having logged into pi, and keeps working as another user or in
a container:

```sh
PI_AGENT_DIR=./data/pi pi          # authenticate a provider
# or, to reuse an existing login:
cp ~/.pi/agent/auth.json data/pi/
```

Invite the bot to a room from an allowed account and it will autojoin.

## Configuration

`config/default.js` ([node-config](https://github.com/node-config/node-config))
bootstraps `dotenv-flow` and exposes a tree the code reads via `config.get(...)`.

| Variable | Required | Notes |
| --- | --- | --- |
| `MATRIX_HOMESERVER` | yes | Base URL, e.g. `https://matrix.example.org` |
| `MATRIX_USER_ID` | yes | Full MXID, e.g. `@mybot:example.org` |
| `MATRIX_PASSWORD` | first run | Initial login, and `cross-sign` |
| `MATRIX_ALLOWED_USERS` | no | Comma-separated MXIDs. **Empty means everyone is allowed** |
| `MATRIX_DEVICE_NAME` | no | Shown in Element's session list |
| `MATRIX_RECOVERY_KEY` | no | Only for `npm run cross-sign`; the bot never reads it |
| `DATA_DIR` | no | Identity and crypto store. Default `./data` |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error` |
| `PI_MODEL` | no | `provider/model-id`, or a bare id. Default: first available |
| `PI_THINKING_LEVEL` | no | `off`…`max`. Default `low` |
| `PI_AGENT_DIR` | no | pi's auth and settings. Default `${DATA_DIR}/pi` |
| `BOT_CWD` | yes | Working directory the agent operates in. `.env` defaults it to `./workspace`; the bot refuses to start if unset |
| `SESSION_DIR` | no | Persist each room's conversation here. Unset = memory only |
| `OUTBOX_DIR` | no | Spool watched for outgoing messages. Default `./outbox` |
| `OUTBOX_DEFAULT_ROOM` | no | Room for `*.txt` drops |

`MATRIX_HOMESERVER` and `MATRIX_USER_ID` are checked explicitly at startup:
`config.get()` alone would not catch them, because the template defines every
key as an empty string and `""` counts as defined.

## Posting from other processes

A second process must never open its own client against the bot's crypto store.
Two clients load the same outbound Megolm session and each advances its own copy
of the ratchet, so both encrypt at the same `message_index`. Strict clients
reject the duplicate as a replay and show "undecryptable", and the same keystream
ends up covering two different plaintexts.

Instead, drop a file in the outbox and the running bot sends it:

```sh
# Write elsewhere first, then rename() in — the bot must never see a partial file.
tmp="$OUTBOX_DIR/.tmp-$$"
printf 'deploy finished\n' > "$tmp"
mv "$tmp" "$OUTBOX_DIR/$(date -u +%Y%m%dT%H%M%SZ)-deploy.txt"
```

| File | Meaning |
| --- | --- |
| `*.txt` | Body is the whole file, sent to `OUTBOX_DEFAULT_ROOM` |
| `*.json` | `{ "room"?: "!id:server", "body": "...", "html"?: "..." }` |

Files are processed in filename order, so a timestamp prefix preserves ordering.
Messages spooled while the bot is down go out on the next start. A failed send is
parked as `.failed` rather than retried forever; a file left `.sending` after a
crash is parked too, since we cannot tell whether it reached the server and
re-sending risks a duplicate.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run the bot |
| `npm test` | `node --test` over `test/**/*.test.js` |
| `npm run cross-sign [DEVICE_ID]` | Cross-sign the bot's device |

## Cross-signing

Without this, Element shows **"Encrypted by a device not verified by its owner"**
on everything the bot sends. Encryption still works; the warning is about trust,
not secrecy.

Fixing it means signing the device with the account's self-signing key, which
lives encrypted in secret storage (4S). `matrix-bot-sdk` and the rust bindings
under it have **no secret-storage support at all**, so the bot cannot do what
Element does. `matrix-js-sdk` can, so it is a `devDependency` used only by
`scripts/cross-sign.mjs`. Nothing in `src/` imports it.

```sh
npm run cross-sign        # defaults to the device in data/token.json
```

Run it once after any fresh login — a new device is never cross-signed. Since the
crypto store persists, that is rare.

Two things the script deliberately does:

- **Logs in as a throwaway device and logs out at the end.** It must not reuse
  the bot's access token: `matrix-js-sdk` would build its own crypto store for
  that device id and re-upload different device keys, clobbering the identity the
  running bot depends on.
- **Refuses to run unless it can first read the existing self-signing key from
  4S.** Otherwise `bootstrapCrossSigning` may mint a *replacement* identity and
  reset trust for every session on the account. `setupNewCrossSigning` is never
  passed, so it defaults to `false`.

## Layout

```
config/default.js       dotenv-flow bootstrap + config tree
src/index.js            entry point: client, handlers, shutdown
src/agent.js            per-room pi sessions, serialization, reply rendering
src/markdown.js         markdown -> sanitized HTML for formatted_body
src/outbox.js           spool watcher for other processes
src/status.js           typing indicator (+ an unused edit-in-place helper)
scripts/cross-sign.mjs  provisioning, matrix-js-sdk only
docs/agent-handoff.md   pi API notes and past failure modes
test/                   node:test suites
data/                   the bot's identity          (gitignored)
outbox/                 outgoing spool              (gitignored)
sessions/               per-room agent history      (gitignored)
```

## What lives in `data/`

| Path | Size | Contents |
| --- | --- | --- |
| `token.json` | ~140 B | `accessToken`, `deviceId`, `userId`. Mode 0600 |
| `sync.json` | ~160 B | `syncToken` and filter state |
| `crypto/matrix-sdk-crypto.sqlite3` | ~140 KB | Olm account, device keys, Megolm sessions |
| `crypto/…-wal`, `…-shm` | up to a few MB | SQLite write-ahead log and shared memory |
| `crypto/bot-sdk.json` | ~270 B | Device id and per-room encryption config (room ids hashed) |

- **A multi-megabyte `-wal` file is normal**, not bloat. SQLite journals there
  while the bot holds the database open and checkpoints it back.
- **`token.json` and `crypto/` are a matched pair.** The token binds to a device
  and that device's keys live in the store. Delete one without the other and the
  bot loses its identity: it logs in fresh, gets a new device, and needs
  `npm run cross-sign` again.
- **Never run two instances against the same `data/`.** Concurrent access to one
  crypto store causes corruption and decryption failures.
- **Only `token.json` is mode 0600.** The crypto store holds this device's
  private keys but is created world-readable. On a shared machine:
  `chmod -R go-rwx data/`.
- Backing up `data/` backs up live credentials and private keys — treat it like
  `.env.local`.

## Blast radius

See [SECURITY.md](SECURITY.md) for the full picture, including the dependency
advisories `npm audit` reports and why they are not reachable here.

The agent runs with pi's default toolset — **read, bash, edit, write, with no
approval gate** — in `BOT_CWD`. Anyone who can message the bot can therefore run
shell commands and modify files there, including the bot's own source.

`MATRIX_ALLOWED_USERS` is the only thing containing that, and **an empty
allowlist means everyone**. Set it. Scope `BOT_CWD` to the narrowest useful
directory, and consider passing an explicit `tools` allowlist to
`createAgentSession` if the full toolset is more than the job needs.

## Known gaps

- Events predating startup are not filtered. Harmless while `sync.json` persists
  the sync token, but clearing `data/` makes the bot replay old history — which
  now means *executing* it, not echoing it.
- No timeout on an agent run. A wedged run holds its room's queue until the
  process restarts.
- The `M_NOT_FOUND` log filter drops *every* such error from `MatrixHttpClient`,
  not just the expected encryption-state probe.
- Sessions are never evicted from memory; the map only grows.
- `BOT_CWD` in the committed `.env` is an absolute path from one machine.
- `matrix-bot-sdk` depends on the deprecated `request`, which carries
  unpatchable advisories including a critical one in `form-data`. Practical
  exposure is low for a text-only bot talking to a homeserver you control.

## Roadmap

- [x] Persistent crypto store, E2EE, restart survival, cross-signing
- [x] `config` + `dotenv-flow`
- [x] pi agent wired in, per-room sessions and serialization
- [x] Outbox for other processes
- [x] Markdown replies
- [ ] Ignore pre-startup events; add a run timeout
- [ ] Scope the agent's tools and working directory
- [ ] systemd unit for deployment
