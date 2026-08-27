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

## Getting started

Requires Node 20+ (developed on 24) and a Matrix account for the bot to log in
as. Every step below is needed on a fresh clone; skipping one fails at a
different point, so they are in dependency order.

### 1. Install

```sh
npm install
```

If npm declines to run install scripts, approve the crypto binding — it is not
optional, see [step 2](#2-check-the-crypto-binding-landed).

### 2. Check the crypto binding landed

```sh
ls node_modules/@matrix-org/matrix-sdk-crypto-nodejs/*.node
node -e "require('@matrix-org/matrix-sdk-crypto-nodejs'); console.log('crypto binding OK')"
```

No `.node` file means npm skipped the postinstall. Approve that one package and
re-install:

```sh
npm install-scripts approve @matrix-org/matrix-sdk-crypto-nodejs
npm install
```

### 3. Configure

```sh
cp .env .env.local
$EDITOR .env.local
```

`MATRIX_HOMESERVER` and `MATRIX_USER_ID` are required; `MATRIX_PASSWORD` is
needed for the first login and for `cross-sign`. **Set `MATRIX_ALLOWED_USERS`** —
empty means everyone, and the agent runs shell commands.

### 4. Give the agent a model provider

The bot reads pi's credentials from `PI_AGENT_DIR` (default `data/pi`), **not**
`~/.pi/agent`. A working interactive `pi` login on the same machine does not
carry over. Skip this and the bot starts, joins, and then fails on the first
message with `No models with complete auth are available in …`.

You do not need pi installed or logged in. Pick whichever fits:

**a. Log in** — stores the credential in `data/pi/auth.json`, pi's own store,
rather than in a project file. pi accepts a pasted API key, so this works on a
headless host; only OAuth providers need a browser:

```sh
PI_CODING_AGENT_DIR=./data/pi npx pi
# then inside pi:  /login <provider>
```

> **Note the variable.** `PI_CODING_AGENT_DIR` is pi's own; `PI_AGENT_DIR` is
> this bot's. The pi CLI ignores `PI_AGENT_DIR` and silently writes to its own
> default instead, which looks like success and leaves the bot finding nothing.
> An `auth.json` containing `{}` means exactly this — the file is created at
> startup, so its presence does not mean a login completed.
>
> Setting `PI_CODING_AGENT_DIR` also avoids having to know where that default
> is. It comes from `piConfig.configDir` in whichever pi build you are running —
> `~/.pi/agent` for the npm package, but a standalone install can differ (one
> reported `~/.config/pi`). Check with `command -v pi` and `npx pi --version` if
> you need to find an existing credential.

**b. An API key in the environment** — fewer steps, but it puts the key in a
file or your shell history rather than pi's credential store. `dotenv-flow` puts
it in the environment and pi picks it up, writing `data/pi/auth.json` on first
use:

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.local
```

Recognised keys include `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY`,
`CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`,
`XAI_API_KEY`.

**c. Reuse an existing login** on this machine — copy from wherever your pi
keeps it (see the note above; `~/.pi/agent` for the npm package):

```sh
mkdir -p data/pi && cp ~/.pi/agent/auth.json data/pi/
```

Check it worked before starting:

```sh
node -e "import('@earendil-works/pi-coding-agent').then(async m=>{
  const rt = await m.ModelRuntime.create({ authPath:'./data/pi/auth.json', modelsStorePath:'./data/pi/models-store.json' });
  const a = await rt.getAvailable();
  console.log(a.length ? 'available: '+a.map(x=>x.provider+'/'+x.id).join(', ') : 'NONE — see step 4');
})"
```

Set `PI_MODEL` in `.env.local` to pin one, e.g. `anthropic/claude-opus-4-5`.
Left empty, the bot uses the first available.

### 5. First start

```sh
npm start
```

It logs in with `MATRIX_PASSWORD` and writes `data/token.json` (mode 0600).
After this the password is no longer needed to run.

Start it from the repo root: `dotenv-flow` resolves `.env` from the working
directory, and relative paths in it resolve from there too.

### 6. Cross-sign the device

```sh
npm run cross-sign
```

Otherwise Element shows *"Encrypted by a device not verified by its owner"* on
everything the bot sends. Needs `MATRIX_RECOVERY_KEY` in `.env.local`. Run it
once per fresh login — rare, since the crypto store persists.

### 7. Invite and test

Invite the bot from an allowlisted account; it autojoins. Send it a message.

## Troubleshooting a fresh install

| Symptom | Cause |
| --- | --- |
| `Cannot find module '…-linux-x64-gnu'` | Install script skipped — step 2 |
| `Missing config: matrix.homeserver` | `.env.local` missing or unfilled — step 3 |
| `Missing config: agent.cwd (BOT_CWD)` | Started from a directory where `dotenv-flow` finds no `.env` — step 5 |
| `No models with complete auth are available in …` | pi provider not authenticated in `PI_AGENT_DIR` — step 4. If you logged in with `PI_AGENT_DIR=… pi`, the credential went to pi's own default instead: pi's variable is `PI_CODING_AGENT_DIR` |
| `Allowing … — MATRIX_ALLOWED_USERS is empty` | Anyone can drive the agent — step 3 |
| "Encrypted by a device not verified by its owner" | Not cross-signed — step 6 |

## Why the crypto binding needs an install script

`@matrix-org/matrix-sdk-crypto-nodejs` ships no binary. Its `postinstall`
(`download-lib.js`) fetches a ~22 MB native library from GitHub Releases for
your platform, and `index.js` loads it from next to itself. Without it,
`require()` fails with `Cannot find module '…-linux-x64-gnu'` and the bot cannot
start — no crypto binding, no E2EE.

npm may decline to run it:

```
npm warn install-scripts  @matrix-org/matrix-sdk-crypto-nodejs@0.4.0 (postinstall: node download-lib.js)
```

The commands are in [step 2](#2-check-the-crypto-binding-landed).

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
PI_CODING_AGENT_DIR=./data/pi npx pi   # authenticate a provider (pi's own var)
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
| `BOT_CWD` | yes | Working directory the agent operates in. `.env` defaults it to `/tmp/piagent-workspace`; the bot refuses to start if unset |
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
VERBOSE=1 npm run cross-sign   # full SDK/crypto logging, if it goes wrong
```

The run prints a step per phase and verifies the signature against the server,
ending in `SUCCESS — device is cross-signed.` Some `[RustBackupManager]` and
`sync …` lines still appear; they are informational.

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
