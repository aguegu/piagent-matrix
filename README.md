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

The bot starts on the first available. There is nothing to configure: say
**`.model <provider/id>`** in the main room to pick another, and the choice is
recorded under `DATA_DIR/agent.json` so it survives restarts.

**`/login` is the only step in the TUI the bot depends on.** pi's own `/model`
does not carry over — it records `defaultProvider` and `defaultModel` in
`data/pi/settings.json`, which the bot never reads, since `ModelRuntime` is
given `auth.json` and `models-store.json` and nothing else. Running it there is
harmless, just not what the bot picks up.

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

Invite the bot from an allowlisted account; it autojoins. Since this is its
first room, it adopts it as the [main room](#the-main-room) and says so — that
message is the confirmation the whole setup worked. Send it a message, or
`.help` for what it answers to.

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
| `PI_AGENT_DIR` | no | pi's auth and settings. Default `${DATA_DIR}/pi` |
| `BOT_CWD` | yes | Working directory the agent operates in. `.env` defaults it to `/tmp/piagent-workspace`; the bot refuses to start if unset |
| `SESSION_DIR` | no | Persist each room's conversation here. Unset = memory only |
| `OUTBOX_DIR` | no | Spool watched for outgoing messages. Default `./outbox` |

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
| `*.txt` | Body is the whole file, sent to the [main room](#the-main-room) |
| `*.json` | `{ "room"?: "!id:server", "body": "...", "html"?: "..." }` |

Unaddressed `*.txt` drops go to the bot's **main room** (below). `*.json` drops
naming their own room always work, main room or not.

The agent is told its own room id and this protocol on the first prompt of each
session, so asking it to "post a report here every hour" produces a `*.json`
drop addressed to that room rather than a `*.txt` that lands in the default.

Files are processed in filename order, so a timestamp prefix preserves ordering.
Messages spooled while the bot is down go out on the next start. A failed send is
parked as `.failed` rather than retried forever; a file left `.sending` after a
crash is parked too, since we cannot tell whether it reached the server and
re-sending risks a duplicate.

## The main room

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
set — one of them may run commands. That last part is what makes adoption safe.
A stranger cannot hand the bot a control channel by inviting it somewhere, and a
busy working room cannot become one by accident.

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
was refused and outbox drops piled up as `.failed`. Three things are checked: the bot is in it (dropping the record if
not), an allowlisted user is in it, and it has no more than two members. The
warning goes to the log always, and into the main room only when there is
someone there to act on it — never to a room the bot is not in, and never to one
holding no allowed user, since a room of strangers is the last place to announce
that it is the bot's control channel.

The main room is read per send rather than captured at startup, so a room
adopted later takes effect immediately.

## Extending the agent

Everything pi loads — extensions, skills, context files, settings — comes from
`PI_AGENT_DIR` (default `data/pi`), because the bot passes it as `agentDir`.
So you extend the bot exactly as you would extend pi, pointed at that directory.

**Note the variable is pi's own**, `PI_CODING_AGENT_DIR`, not this project's
`PI_AGENT_DIR`. The pi CLI ignores ours.

### Extensions

```sh
PI_CODING_AGENT_DIR=./data/pi npx pi install npm:pi-web-access
```

That appends to `packages` in `data/pi/settings.json`. Then send **`.reload`**
in the main room — sessions are created once per room and cached for the process
lifetime, so a running bot otherwise keeps the extension set it started with.
Restarting works too.

On startup the bot logs what loaded, and says so when one fails:

```
[agent] Extensions loaded: pi-web-access
[agent] Extension failed to load (…): …
```

### Skills

Drop a skill in `data/pi/skills/` and it is available as `/skill:<name>` in
every room, once you `.reload` (or restart).

### Context files — the closest thing to memory

pi reads `AGENTS.md` (or `CLAUDE.md`) from two places, and both persist across
sessions and restarts:

| Location | Scope |
| --- | --- |
| `data/pi/AGENTS.md` | Every room, every session — the bot's standing instructions |
| `$BOT_CWD/AGENTS.md`, and every ancestor directory | Project scope |

`data/pi/AGENTS.md` is the natural home for things the agent should always know.
Note the project-scoped one follows `BOT_CWD`, so with the default under `/tmp`
it will not survive a reboot — point `BOT_CWD` at a durable path if you intend
to keep context there.

This is distinct from conversation history, which `SESSION_DIR` persists per
room. Context files are instructions; sessions are what was said.

## Commands

A short allowlist, recognised before the agent sees the message. **Commands
belong to the main room** — see below.

| Command | Where | What it does |
| --- | --- | --- |
| `.info` | any room | Shows the model and thinking level in use |
| `.verify` | main room | Runs the `verify` prompt template from `PI_AGENT_DIR/prompts` |
| `.reload` | main room | pi's `/reload` — re-reads extensions, skills, prompts and context files |
| `.model` | main room | Shows the model and what else is available; `.model <provider/id>` switches it |
| `.thinking` | main room | Shows the thinking level; `.thinking <level>` sets it |
| `.help` | main room | Lists the commands, and the prompt templates and skills installed |

**Use a leading dot, not a slash.** Element intercepts `/` for its own commands,
so `/help` opens Element's help and never reaches the bot. A leading `/` is
still accepted for clients that pass it through, but `.` is the reliable form.

### The main room holds the controls

Every command but `.info` either reconfigures the bot for *all* rooms
(`.model`, `.thinking`, `.reload`) or hands a chat message the agent's own reach
(`.verify`). One agent config backs every room, so a switch made in a working
room would reconfigure the others without their knowing, and only the room that
did it would see the confirmation. That belongs in the bot's control channel.

A working room may hold people who are not the bot's admin, so it gets `.info`
and nothing else. Anything else there is answered with a flat
`` `.model` is not available here. `` — no reason, and **never the main room's
id**. Nothing outside the main room hints that one exists: `.help` does not run
there either, so the listing above is never shown to a room that cannot use it.

If no main room is established, everything is allowed rather than leaving the
bot with one usable command.

### What each one does

`.info` is the whole command surface of a working room: two lines, the model and
the thinking level. It reads; it changes nothing. Deliberately no caveat about
whether the room has a live session — sessions are in-memory, so a room chatted
in for days would report none after a restart, and the values are the same
either way.

`.verify` is not special-cased: the bot hands `/verify` to pi, which expands the
template and runs the agent, so the reply arrives like any other. Any prompt
template you add to `PI_AGENT_DIR/prompts` works the same way once its name is
added to `COMMANDS` in `src/commands.js`.

`.reload` calls `AgentSession.reload()` on every live session, not just the room
that asked — extensions and prompts live in the shared `PI_AGENT_DIR`, so
reloading one room would leave the rest stale. Sessions and their history
survive; only the resources are re-read. It is the restart that the *Extending
the agent* section would otherwise require.

`.model` and `.thinking` are how the agent is configured — there is no env var
for either. Bare, they report where you are and list what is on offer, since a
room cannot present pi's selector UI. With an argument, they apply the change to
every live session and **record it under `DATA_DIR/agent.json`**, so it survives
a restart. A bot that has never been told starts on the first available model at
thinking level `low`.

Neither is read from the environment, on purpose. An interactive `pi` run
exports `PI_MODEL` and `PI_PROVIDER` into the shell, so honouring them let a
stray export decide the bot's model — invisible influence, and pointless once
the choice is a command away.

Anything unrecognised is an ordinary prompt. `/login` and `/compact`
are deliberately **not** wired up: they need a back-and-forth a room cannot give,
or hand a chat message more reach than it should have. pi's TUI also treats `!`
as "run bash", which is not offered here for the same reason.

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
`scripts/cross-sign.js`. Nothing in `src/` imports it.

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
scripts/cross-sign.js  provisioning, matrix-js-sdk only
docs/pi-integration.md  pi API notes and design decisions
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
