# Running it from a checkout

The [container quickstart](container-quickstart.md) is the easier path and the
one the README leads with: a published image, no build, no Node on the host.
This is the other way — a clone, `npm install`, and the bot running as a
process you own. It is what you want for developing on it, and it is how both
of the author's bots ran until they moved into containers.

Requires Node 20+ (developed on 24) and a Matrix account for the bot to log in
as. Every step is needed on a fresh clone; skipping one fails at a different
point, so they are in dependency order.

## 1. Install

```sh
npm install
```

If npm declines to run install scripts, approve the crypto binding — it is not
optional, see [step 2](#2-check-the-crypto-binding-landed).

## 2. Check the crypto binding landed

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

## 3. Configure

```sh
cp .env .env.local
$EDITOR .env.local
```

`MATRIX_HOMESERVER` and `MATRIX_USER_ID` are required; `MATRIX_PASSWORD` is
needed for the first login and for `cross-sign`. **Set `MATRIX_ALLOWED_USERS`** —
empty means everyone, and the agent runs shell commands.

`.env.local` overrides `.env`, which is why the checked-in `.env` can hold
empty placeholders. Worth remembering if you ever copy the configuration
somewhere else — see
[moving an existing bot in](container-quickstart.md#moving-an-existing-bot-in).

## 4. Give the agent a model provider

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
**[docs/model-providers.md](model-providers.md)**.

## 5. First start

```sh
npm start
```

It logs in with `MATRIX_PASSWORD` and writes `data/token.json` (mode 0600).
After this the password is no longer needed to run.

Start it from the repo root: `dotenv-flow` resolves `.env` from the working
directory, and relative paths in it resolve from there too.

## 6. Cross-sign the device

```sh
npm run cross-sign
```

Otherwise Element shows *"Encrypted by a device not verified by its owner"* on
everything the bot sends. Needs `MATRIX_RECOVERY_KEY` in `.env.local`. Run it
once per fresh login — rare, since the crypto store persists.

## 7. Invite and test

Invite the bot from an allowlisted account; it autojoins. Since this is its
first room, it adopts it as the [main room](main-room.md) and says so — that
message is the confirmation the whole setup worked. Send it a message, or
`.help` for what it answers to.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run the bot |
| `npm test` | `node --test` over `test/**/*.test.js` |
| `npm run cross-sign [DEVICE_ID]` | Cross-sign the bot's device |

## When a fresh install goes wrong

| Symptom | Cause |
| --- | --- |
| `Cannot find module '…-linux-x64-gnu'` | Install script skipped — step 2 |
| `Missing config: matrix.homeserver` | `.env.local` missing or unfilled — step 3 |
| `Missing config: agent.cwd (BOT_CWD)` | Started from a directory where `dotenv-flow` finds no `.env` — step 5 |
| `No models with complete auth are available in …` | pi provider not authenticated in `PI_AGENT_DIR` — step 4. If you logged in with `PI_AGENT_DIR=… pi`, the credential went to pi's own default instead: pi's variable is `PI_CODING_AGENT_DIR` |
| `Allowing … — MATRIX_ALLOWED_USERS is empty` | Anyone can drive the agent — step 3 |
| "Encrypted by a device not verified by its owner" | Not cross-signed — step 6 |

## Where things live

```
data/                   the bot's identity          (gitignored)
outbox/                 outgoing spool              (gitignored)
inbox/                  incoming prompts            (gitignored)
sessions/               per-room agent history      (gitignored)
```

All four are created on first run, relative to the working directory, and all
four are configurable — see [configuration](configuration.md). In a container
they are one mounted `data/` plus `sessions/`, which is the main structural
difference between the two ways of running it.

---

[← README](../README.md)
