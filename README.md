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

cron / scripts ──► outbox/ spool ──► the running bot ──► Matrix   (text to post)
cron / scripts ──► inbox/  spool ──► AgentManager ────────► Matrix   (work to do)
```

- **One pi session per room.** Rooms are the conversation boundary; with
  `SESSION_DIR` set, each room's history survives restarts.
- **Runs are serialized per room.** pi queues a prompt issued mid-run and
  returns immediately, so overlapping messages would silently lose a reply.
  Each message waits its turn and owns a complete run.
- **Progress is a typing indicator**, not a placeholder message. Nothing is
  posted until the run finishes, and replies are never edited after the fact.
- **Only this process touches the crypto store.** Anything else that needs to
  post goes through the outbox — and anything that needs the *agent* goes
  through the inbox, whose files are run as prompts.
- **Bots can hear each other.** The bot sends `m.notice` and accepts it, so two
  agents in a room can talk; a run of automated messages with nobody else
  speaking stops after three, and a person speaking resumes it.

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
`~/.pi/agent`. Skip this and the bot starts, joins, and then fails on the first
message with `No models with complete auth are available in …`.

```sh
PI_CODING_AGENT_DIR=./data/pi npx pi
# then inside pi:  /login <provider>
```

**Note the variable**: `PI_CODING_AGENT_DIR` is pi's own, `PI_AGENT_DIR` is this
bot's, and the pi CLI ignores ours — writing to its own default instead, which
looks like success and leaves the bot finding nothing.

An API key in the environment or an existing `auth.json` work too, and there is
a one-liner to check a provider resolved before starting:
**[docs/model-providers.md](docs/model-providers.md)**.

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
first room, it adopts it as the [main room](docs/main-room.md) and says so — that
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

## Commands

A short allowlist, recognised before the agent sees the message. **Commands
belong to the main room** — see below.

| Command | Where | What it does |
| --- | --- | --- |
| `.info` | any room | Shows the model, thinking level, build, uptime and extensions |
| `.reload` | main room | pi's `/reload` — re-reads extensions, skills, prompts and context files |
| `.rooms` | main room | Lists the rooms the bot is in; `.rooms leave <roomId>` leaves one |
| `.model` | main room | Shows the model and what else is available; `.model <provider/id>` switches it |
| `.thinking` | main room | Shows the thinking level; `.thinking <level>` sets it |
| `.help` | main room | Lists the commands, and the prompt templates and skills installed |

**Use a leading dot, not a slash.** Element intercepts `/` for its own commands,
so `/help` opens Element's help and never reaches the bot. A leading `/` is
still accepted for clients that pass it through, but `.` is the reliable form.

Each is explained in **[docs/commands.md](docs/commands.md)**, including why all
but `.info` are answered only in the main room.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run the bot |
| `npm test` | `node --test` over `test/**/*.test.js` |
| `npm run cross-sign [DEVICE_ID]` | Cross-sign the bot's device |

## Layout

```
config/default.js       dotenv-flow bootstrap + config tree
src/index.js            entry point: client, handlers, command dispatch
src/agent.js            per-room pi sessions, serialization, reply rendering
src/commands.js         the command allowlist and which room may run each
src/main-room.js        adopting, verifying and dropping the control channel
src/markdown.js         markdown -> sanitized HTML for formatted_body
src/outbox.js           spool watcher: files other processes want posted
src/inbox.js            spool watcher: files run as prompts to the agent
src/spool.js            the watching, claiming and parking both share
src/resources.js        installs agent/ into PI_AGENT_DIR on start
src/version.js          which build this is, for .info and the startup log
src/loop-guard.js       bounds a run of bots answering bots
src/status.js           typing indicator (+ an unused edit-in-place helper)
agent/AGENTS.md         standing instructions that ship with the bot
scripts/cross-sign.js   provisioning, matrix-js-sdk only
docs/                   the longer form; see Documentation below
test/                   node:test suites
data/                   the bot's identity          (gitignored)
outbox/                 outgoing spool              (gitignored)
inbox/                  incoming prompts            (gitignored)
sessions/               per-room agent history      (gitignored)
```

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

## Documentation

| | |
| --- | --- |
| [Configuration](docs/configuration.md) | every environment variable, and why the crypto binding needs an install script |
| [Model providers](docs/model-providers.md) | the three ways to give the agent a provider, and how to check one resolved |
| [Commands](docs/commands.md) | what each command does, and why the main room holds the controls |
| [Spools](docs/spools.md) | the outbox (text to post) and the inbox (work to do) |
| [The main room](docs/main-room.md) | how the bot adopts a control channel, checks it, and repairs it |
| [More than one bot in a room](docs/multi-bot.md) | `m.notice`, and bounding a run of bots answering bots |
| [Extending the agent](docs/extending.md) | extensions, skills, prompt templates, and the shipped `AGENTS.md` |
| [Running it](docs/operations.md) | cross-signing, what lives in `data/`, known gaps |
| [pi integration](docs/pi-integration.md) | pi API notes and the behaviour that is easy to get wrong |
| [SECURITY.md](SECURITY.md) | blast radius, and the dependency advisories |
| [Releases](RELEASES.md) · [blog](docs/blog/) | what changed, and a few things worth writing up |

## Roadmap

- [x] Persistent crypto store, E2EE, restart survival, cross-signing
- [x] `config` + `dotenv-flow`
- [x] pi agent wired in, per-room sessions and serialization
- [x] Outbox for other processes, and an inbox that gives the agent work
- [x] Markdown replies
- [x] A main room that adopts, verifies and repairs itself
- [x] Commands in Matrix, with the controls held to the main room
- [ ] Ignore pre-startup events; add a run timeout
- [ ] Scope the agent's tools and working directory
- [ ] systemd unit for deployment
