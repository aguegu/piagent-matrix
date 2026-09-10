# Getting started in a container

From nothing to a bot that talks in Matrix and has a verified device. Every
step here was walked through on a real deployment; the failures listed at the
end are the ones it actually hit, not ones imagined for the occasion.

For *why* it is shaped this way — the base image, the volume split, what
happens to cron — see [containerization](containerization.md).

## Before you start

- **Docker with compose.** Anything current.
- **A Matrix account for the bot**, separate from your own and from any other
  bot. Its password is needed once, for the first login.
- **A recovery key for that account**, if you want the device verified. Log
  into it in Element once and turn on recovery; that is what creates the
  secret storage cross-signing reads. Without it the bot works, and every
  message it sends is flagged "Encrypted by a device not verified by its
  owner".
- **A model provider** you can log in to.

## 1. Build the image

Not published to a registry yet, so build it from a checkout:

```sh
git clone <this repo> piagent-matrix && cd piagent-matrix
docker build -t piagent-matrix:latest .
```

The build ends by loading the crypto binding, so if it succeeds the binding is
really there — the failure that would otherwise wait until the first message
in a room.

## 2. Make a deployment directory

One directory holds everything this bot is. Nothing else on the host needs to
know about it.

```sh
mkdir -p ~/containers/mybot/{data/inbox,data/outbox,data/pi,sessions,workspace}
cd ~/containers/mybot
```

**Create the directories before the first `up`.** Docker creates a missing
bind-mount source as `root`, and the container runs as uid 1000 — it would
start and then fail to write its own token.

`compose.yml`:

```yaml
services:
  bot:
    image: piagent-matrix:latest
    container_name: mybot
    env_file: .env
    init: true                 # the agent spawns shells constantly; reap them
    stop_grace_period: 30s     # shutdown releases the lock and disposes sessions
    restart: unless-stopped
    volumes:
      - ./data:/data           # identity, provider credentials, spools
      - ./sessions:/sessions   # per-room memory
      - ./workspace:/workspace # the agent's own ground
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```

`.env` — `chmod 600` it:

```sh
MATRIX_HOMESERVER=https://matrix.example.org
MATRIX_USER_ID=@mybot:matrix.example.org
MATRIX_PASSWORD=<first login only; can be emptied afterwards>
MATRIX_ALLOWED_USERS=@you:matrix.example.org
MATRIX_DEVICE_NAME=mybot-container
MATRIX_RECOVERY_KEY=<for cross-signing>
LOG_LEVEL=info
```

**Set `MATRIX_ALLOWED_USERS`.** Empty means everyone, and the agent runs shell
commands. A container bounds what that reaches; it does not decide who may ask.

Do not set `DATA_DIR`, `BOT_CWD` or the spool paths — the image points them at
the volumes above.

## 3. Log a provider in

```sh
docker compose run --rm bot pi        # then: /login <provider>
```

`pi`, **not `npx pi`**: the working directory is `/workspace`, which has no
`node_modules`, so npx would fall through to the registry and offer to install
an unrelated public package called `pi`.

Check it landed on the host side, which is the whole point of the bind mount:

```sh
ls -l data/pi/auth.json
```

If that file is missing, the login went somewhere unmounted — see the failures
below.

## 4. Start it

```sh
docker compose up            # foreground for the first run
```

Expect, in order: `Reusing stored device` or a password login, `Crypto
ready=true`, and `Rooms: 0`. `data/token.json` appears on the host.

## 5. Invite it to a room

Invite the bot from an allowlisted account. It autojoins, and because this is
its first room it adopts it as the [main room](main-room.md) and says so. That
message is the proof of the whole chain: login, encryption, sync, join.

Then talk to it. The first message is the first model call, so a provider
problem shows up here rather than at startup.

## 6. Cross-sign the device

```sh
docker compose run --rm bot node /app/scripts/cross-sign.js
```

It reads this deployment's device from `/data/token.json` and its credentials
from the same environment the bot uses, so there is nothing to pass. Safe
against a running container: it logs in as a throwaway device, signs, and logs
out, never opening the bot's crypto store.

Ends in `SUCCESS — device is cross-signed.`, after which Element stops
flagging the session.

## Running pi's own commands

The image carries pi's CLI, so extensions and credentials are managed through
the container rather than from a checkout:

```sh
cd ~/containers/mybot
docker compose exec bot pi list                        # what is installed
docker compose exec bot pi install npm:pi-web-access   # add an extension
docker compose exec bot pi update                      # extensions and model catalogs
docker compose exec bot pi auth check --provider <name>
```

`pi auth check` prints `ready` or says what is wrong. It is the cheapest way
to confirm a provider — no model call, no room, no waiting for a message to
fail.

**`exec` or `run`.** `exec` uses the container that is already up; `run --rm`
starts a throwaway one with the same volumes, which is what to use when the
bot is stopped. Either way the writes land in `/data/pi`, which is your bind
mount, so they persist and survive the container being recreated.

These commands take a lock on `settings.json`, so the data volume has to be
writable — a read-only mount fails with `EROFS`.

**An installed extension is not loaded yet.** The bot loads extensions when a
room's session is created, so after installing one:

- `.reload` in the main room re-reads extensions, skills, prompts and context
  files for live sessions, or
- restart the container.

Then `.info` in any room reports what actually loaded, and names anything that
failed — which is the point of it. Two bots once compared notes, both found
zero skills, and concluded they matched; one had `pi-web-access` and the other
had nothing.

## When it goes wrong

| What you see | What it is |
| --- | --- |
| `Cannot find module '…-linux-x64-gnu'` | An Alpine or musl base. The crypto binding has no musl build; use `node:24-bookworm-slim` |
| Build succeeds, first message dies on the binding | Install scripts were skipped for `@matrix-org/matrix-sdk-crypto-nodejs`, which *fetches* the binding in its postinstall |
| `EACCES` writing `/data`, or the bot cannot save its token | A bind-mount directory was created by Docker as `root`. `mkdir` them yourself first, or `chown 1000:1000` |
| `No API key found for the selected model` after a successful `/login` | The login went to `~/.pi/agent` inside the container. The CLI reads `PI_CODING_AGENT_DIR`, not `PI_AGENT_DIR`; the image sets both, so this means one is missing |
| `npx` offers to install `pi@2.0.5` | That is not this pi. Run `pi` — the pinned binary is on `PATH` |
| `Configuration property "matrix" is not defined` | node-config resolves from the working directory; the image sets `NODE_CONFIG_DIR=/app/config` |
| `Allowing … MATRIX_ALLOWED_USERS is empty` on every message | Exactly what it says — step 2 |
| `EROFS: read-only file system` from a `pi` command | Those commands lock `settings.json`; the data volume must be writable |
| Two bots answering as the same account | Two containers on one `data/` volume. The instance lock stores a pid and cannot see across a PID namespace, so it will not catch this |

## What is not here yet

**Cron.** The bots schedule themselves on the host, and that does not survive
containerizing as-is. The decision is made and written up in
[containerization](containerization.md#the-decision-a-crontab-file-not-a-crontab)
— a crontab file read by `supercronic` — but it is not built.

---

[← README](../README.md)
