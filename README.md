# piagent-matrix

A Matrix bot that fronts the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
over instant messaging. Message it from an allowlisted account and your text
becomes a prompt; the agent's answer comes back as a formatted Matrix message.

Built on [`matrix-bot-sdk`](https://github.com/turt2live/matrix-bot-sdk) with
end-to-end encryption and an on-disk crypto store, so the bot keeps its device
identity across restarts.

## Quick start

A published image and one directory. Nothing to build, no checkout, and no
Node on the host — everything the bot *is* ends up under the directory you
make here, which is also the thing you back up.

**You need** Docker with compose, a Matrix account for the bot (its own, not
yours), and a model provider you can log in to. For a verified device, turn on
recovery for that account in Element first and keep the recovery key.

**linux/amd64 only** — the crypto binding has no musl or arm64 build.

### 1. Make a directory for it

```sh
mkdir -p ~/containers/mybot/{data/inbox,data/outbox,data/pi,sessions,workspace}
cd ~/containers/mybot
```

Make them first — Docker creates a missing one as `root`, which the container
then cannot write.

### 2. Write two files

`compose.yml`:

```yaml
services:
  bot:
    image: aguegu/piagent-matrix:latest
    container_name: mybot
    env_file: .env
    init: true                 # the agent spawns shells constantly; reap them
    stop_grace_period: 30s     # shutdown releases the lock and disposes sessions
    restart: unless-stopped
    volumes:
      - ./data:/data           # identity, provider credentials, spools, schedule
      - ./sessions:/sessions   # per-room memory
      - ./workspace:/workspace # the agent's own ground
```

`.env`, then `chmod 600 .env`:

```sh
MATRIX_HOMESERVER=https://matrix.example.org
MATRIX_USER_ID=@mybot:matrix.example.org
MATRIX_PASSWORD=<needed for the first login only>
MATRIX_ALLOWED_USERS=@you:matrix.example.org
MATRIX_RECOVERY_KEY=<for cross-signing, step 5>
LOG_LEVEL=info
```

**Set `MATRIX_ALLOWED_USERS`.** Empty means everyone, and the agent runs shell
commands with no approval gate.

Set nothing else — the image points `DATA_DIR`, `BOT_CWD` and the spool paths
at the volumes above.

### 3. Log a model provider in

```sh
docker compose run --rm bot pi        # then, inside pi:  /login <provider>
```

`data/pi/auth.json` appears when it worked.

### 4. Start it

```sh
docker compose up            # foreground for the first run
```

Expect, in order: a password login, `Crypto ready=true`, and `Rooms: 0`.
`data/token.json` appears on the host, after which the password is no longer
needed.

### 5. Invite it, then verify its device

Invite the bot from an allowlisted account. It autojoins, and since this is its
first room it adopts it as the [main room](docs/main-room.md) and says so —
that message is the proof of the whole chain: login, encryption, sync, join.
Talk to it, or send `.help`.

Then, so Element stops flagging everything it sends:

```sh
docker compose run --rm bot node /app/scripts/cross-sign.js
```

Ends in `SUCCESS — device is cross-signed.` Safe to run while the bot is up.

---

That is the whole path. **[Container quickstart](docs/container-quickstart.md)**
walks the same ground in more detail and adds what comes next: scheduling,
running pi's own commands, changing what the agent is told, moving an existing
host bot in, and a table of the failures this actually hits.

Prefer to run it from a clone? **[From source](docs/from-source.md)**.

## It is still pi

A container changes the command, not the tool. The image carries pi's own CLI,
and everything it writes lands in `data/pi` on your side of the bind mount, so
extensions, skills, prompt templates and credentials persist and survive the
container being recreated. Prefix what you would have typed:

```sh
docker compose exec bot pi install npm:pi-web-access   # add an extension
docker compose exec bot pi list                        # what is installed
docker compose exec bot pi update                      # extensions and model catalogs
docker compose exec bot pi auth check --provider <name>
```

A newly installed extension needs a restart — `.reload` does not pick up a
package that did not exist when the process started:

```sh
docker compose restart bot
```

Then `.info` in any room says which extensions actually loaded.

The agent's standing instructions are `data/pi/AGENTS.md`, assembled at every
start from sections you can edit in `data/parts-enabled/` — a markdown file,
no rebuild and no image of your own. See
**[extending the agent](docs/extending.md)**.

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

## Commands

A short allowlist, recognised before the agent sees the message. **Commands
belong to the main room** — see below.

| Command | Where | What it does |
| --- | --- | --- |
| `.info` | any room | Shows the model, thinking level, context size, build, uptime and extensions |
| `.reload` | main room | pi's `/reload` — re-reads extensions, skills, prompts and context files |
| `.compact` | any room | Summarises this room's history so the session carries less of it |
| `.session` | any room | What this room's session has cost: messages, tokens, money |
| `.rooms` | main room | Lists the rooms the bot is in; `.rooms leave <roomId>` leaves one |
| `.model` | main room | Shows the model and what else is available; `.model <provider/id>` switches it |
| `.thinking` | main room | Shows the thinking level; `.thinking <level>` sets it |
| `.help` | main room | Lists the commands, and the prompt templates and skills installed |

**Use a leading dot, not a slash.** Element intercepts `/` for its own commands,
so `/help` opens Element's help and never reaches the bot. A leading `/` is
still accepted for clients that pass it through, but `.` is the reliable form.

Each is explained in **[docs/commands.md](docs/commands.md)**, including why
everything except `.info`, `.compact` and `.session` — the three scoped to the
room they are typed in — is answered only in the main room.

## Working on it

Clone it, `npm install`, `npm test` — the setup in full, and what to do when a
fresh install goes wrong, is in **[from source](docs/from-source.md)**. There
is no build step; `npm start` runs `src/index.js` directly.

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
src/scheduler.js        supercronic as a child, when CRONTAB_FILE is set
src/instance-lock.js    one bot per data directory
src/version.js          which build this is, for .info and the startup log
src/loop-guard.js       bounds a run of bots answering bots
src/status.js           typing indicator (+ an unused edit-in-place helper)
agent/AGENTS.template.md  the standing instructions, before substitution
agent/parts/            the sections that depend on the deployment
scripts/cross-sign.js   provisioning, matrix-js-sdk only
docs/                   the longer form; see Documentation below
test/                   node:test suites
Dockerfile              the published image
```

Running from a clone also creates `data/`, `sessions/`, `inbox/` and `outbox/`
here, all gitignored. In a container those are the mounted volumes instead,
which is the main structural difference between the two ways of running it.

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

**Getting it running**

| | |
| --- | --- |
| [Container quickstart](docs/container-quickstart.md) | the quick start above in full, plus scheduling, pi's own commands, and moving an existing host bot in |
| [From source](docs/from-source.md) | the other way: a clone, `npm install`, and the failures a fresh one hits |
| [Configuration](docs/configuration.md) | every environment variable, and why the crypto binding needs an install script |
| [Model providers](docs/model-providers.md) | the three ways to give the agent a provider, and how to check one resolved |
| [Running it](docs/operations.md) | cross-signing, what lives in `data/`, known gaps |

**Using it**

| | |
| --- | --- |
| [Commands](docs/commands.md) | what each command does, and why the main room holds the controls |
| [The main room](docs/main-room.md) | how the bot adopts a control channel, checks it, and repairs it |
| [Spools](docs/spools.md) | the outbox (text to post) and the inbox (work to do) |
| [Extending the agent](docs/extending.md) | extensions, skills, prompt templates, and the shipped `AGENTS.md` |
| [More than one bot in a room](docs/multi-bot.md) | `m.notice`, and bounding a run of bots answering bots |

**Why it is like that**

| | |
| --- | --- |
| [In a container](docs/containerization.md) | base image, what must survive, and where the scheduler ended up after two wrong answers |
| [pi integration](docs/pi-integration.md) | pi API notes and the behaviour that is easy to get wrong |
| [SECURITY.md](SECURITY.md) | blast radius, and the dependency advisories |
| [Releases](RELEASES.md) · [blog](docs/blog/) | what changed, and a few things worth writing up |
