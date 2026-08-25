# tradebots-matrix

A small Matrix bot that talks to pi (the coding agent) over IM.

This is being built incrementally. The current state is **step 1**:
the bot logs in, receives messages, and echoes them back — but renders
any Markdown you send via Matrix's HTML formatted body. This proves the
connection, the Markdown pipeline, and the streaming-edit primitives
work before we wire in the agent.

## Setup

```sh
cd matrix
npm install              # already done if you cloned
cp .env.example .env
$EDITOR .env             # fill in MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_PASSWORD
node src/index.js
```

Then DM your bot from one of the `MATRIX_ALLOWED_USERS` accounts.

## Environment

| Variable                 | Required | Notes                                                      |
| ------------------------ | -------- | ---------------------------------------------------------- |
| `MATRIX_HOMESERVER`      | yes      | e.g. `https://matrix.org` or your Synapse URL              |
| `MATRIX_USER_ID`         | yes      | bot's full MXID, e.g. `@andybot:matrix.org`                |
| `MATRIX_PASSWORD`        | one of   | password login                                             |
| `MATRIX_ACCESS_TOKEN`    | one of   | pre-issued token (preferred for long-running bots)         |
| `MATRIX_ALLOWED_USERS`   | no       | comma-separated MXIDs; empty = warn-everyone (insecure)    |
| `MATRIX_DEVICE_ID`       | no       | keep stable across restarts (e.g. `TRADEBOTS_MATRIX_BOT`)  |
| `BOT_CWD`                | no       | cwd for the agent; defaults to `process.cwd()`             |
| `SESSION_DIR`            | no       | persist per-room sessions here (added in step 2)           |
| `LOG_LEVEL`              | no       | `debug` \| `info` \| `warn` \| `error`                     |

## Roadmap

- [x] Step 1: login, message loop, Markdown rendering, streaming edit primitives
- [ ] Step 2: wire up `createAgentSession` so messages become prompts
- [ ] Step 3: per-room session persistence (so conversations have memory)
- [ ] Step 4: slash commands (`/new`, `/compact`, `/model`, `/thinking`)
- [ ] Step 5: systemd unit + Dockerfile for VPS/NAS deployment
