# Configuration

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
| `INBOX_DIR` | no | Spool watched for prompts to run. Default `./inbox` |

`MATRIX_HOMESERVER` and `MATRIX_USER_ID` are checked explicitly at startup:
`config.get()` alone would not catch them, because the template defines every
key as an empty string and `""` counts as defined.

`.env` is a committed template: keys, comments, and non-secret defaults.
`.env.local` holds the real values and is gitignored. `dotenv-flow` loads `.env`
first and lets `.env.local` override every key; real environment variables win
over both.

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

The commands are in [step 2 of Getting started](../README.md#2-check-the-crypto-binding-landed).

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

---

[← README](../README.md)
