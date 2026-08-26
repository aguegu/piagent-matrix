# tradebots-matrix v2

A Matrix bot built on [`matrix-bot-sdk`](https://github.com/turt2live/matrix-bot-sdk),
with end-to-end encryption and a crypto store that survives restarts.

Right now it echoes back what allowed users send. The agent is not wired in yet.

## Why v2 exists

v1 (`../src`, built on `matrix-js-sdk`) worked within a single run but could not
survive a restart. `matrix-js-sdk`'s rust crypto layer offers only two storage
options — `useIndexedDB: true` or in-memory — and there is no indexeddb in Node.
So every boot logged `Created a new Olm account`, minting fresh device keys under
the same stored device id. Other clients cached keys that no longer matched.

`matrix-bot-sdk` wraps the same rust crypto SDK but exposes a **file-based**
store, which is the whole difference:

```js
const cryptoStore = new RustSdkCryptoStorageProvider(CRYPTO_PATH, StoreType.Sqlite);
const client = new MatrixClient(homeserver, accessToken, storage, cryptoStore);
```

Everything v1 did by hand — `initRustCrypto`, secret-storage bootstrap, recovery
key generation and persistence, key-backup loading, and a "send hello on startup"
hack to force an outbound Megolm session — collapses into that one constructor
argument. Encrypted and unencrypted rooms are handled transparently; nothing in
`src/` branches on it.

| | v1 | v2 |
| --- | --- | --- |
| Lines of source | 774 | ~190 |
| Crypto setup | ~100 lines | one constructor argument |
| Survives restart | no | yes |
| Runtime dependencies | 4 | 3 |

## Setup

Requires Node 20.6+ (developed on 24).

```sh
npm install
cp .env .env.local     # then fill in .env.local
npm start
```

`.env` is a committed template holding keys and comments but no values.
`.env.local` holds the real values and is gitignored. `dotenv-flow` loads `.env`
first and lets `.env.local` override every key. Real environment variables win
over both.

On first start the bot logs in with `MATRIX_PASSWORD` and writes
`data/token.json` (mode 0600). After that it reuses the stored token and never
needs the password again.

Invite the bot to a room from an allowed account and it will autojoin.

## Configuration

Config lives in `config/default.js` ([node-config](https://github.com/node-config/node-config)),
which bootstraps `dotenv-flow` and exposes a tree the code reads via
`config.get(...)`.

| Variable | Required | Notes |
| --- | --- | --- |
| `MATRIX_HOMESERVER` | yes | Base URL, e.g. `https://matrix.example.org` |
| `MATRIX_USER_ID` | yes | Full MXID, e.g. `@mybot:example.org` |
| `MATRIX_PASSWORD` | first run | Only for the initial login and for `cross-sign` |
| `MATRIX_ALLOWED_USERS` | no | Comma-separated MXIDs. **Empty means everyone is allowed** |
| `MATRIX_DEVICE_NAME` | no | Shown in Element's session list |
| `MATRIX_RECOVERY_KEY` | no | Only used by `npm run cross-sign`; the bot never reads it |
| `DATA_DIR` | no | Where `token.json`, `sync.json` and `crypto/` live. Default `./data` |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error` |

`MATRIX_HOMESERVER` and `MATRIX_USER_ID` are checked explicitly at startup.
`config.get()` alone would not catch them, because the template defines every key
as an empty string and `""` counts as defined.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run the bot |
| `npm run cross-sign [DEVICE_ID]` | Cross-sign the bot's device (see below) |
| `npm test` | `node --test` over `test/**/*.test.js` (no tests yet) |

## Cross-signing

Without this, Element shows **"Encrypted by a device not verified by its owner"**
on everything the bot sends. Encryption still works; the warning is about trust,
not secrecy.

Fixing it means signing the bot's device with the account's self-signing key,
which lives encrypted in secret storage (4S). `matrix-bot-sdk` and the rust
bindings under it have **no secret-storage support at all**, so the bot cannot do
what Element does. `matrix-js-sdk` can, so it is a `devDependency` used only by
`scripts/cross-sign.mjs`. Nothing in `src/` imports it.

```sh
npm run cross-sign        # defaults to the device in data/token.json
```

Run it once after any fresh login — a new device is never cross-signed. Since the
crypto store now persists, that is rare.

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
config/default.js      dotenv-flow bootstrap + config tree
src/index.js           the bot
src/status.js          typing indicator + edit-in-place helper
scripts/cross-sign.mjs provisioning, matrix-js-sdk only
docs/agent-handoff.md  notes for wiring in the pi agent
data/                  the bot's identity        (gitignored)
.env                   committed template, no secrets
.env.local             real values, gitignored
```

v2 is self-contained. Nothing in `src/`, `config/` or `scripts/` reaches outside
this directory, so v1 (`../src`, `../data`) can be deleted without affecting it.

## What lives in `data/`

`DATA_DIR` defaults to `./data`, relative to this project. It is **not** shared
with v1 — v1 keeps only a `bot-state.json` of credentials and never persisted any
crypto state at all, which is exactly why it minted a new Olm account on every
boot.

| Path | Size | Contents |
| --- | --- | --- |
| `token.json` | ~140 B | `accessToken`, `deviceId`, `userId`. Mode 0600 |
| `sync.json` | ~160 B | `syncToken` and filter state, from `SimpleFsStorageProvider` |
| `crypto/matrix-sdk-crypto.sqlite3` | ~140 KB | The rust crypto store: Olm account, device keys, Megolm sessions |
| `crypto/…sqlite3-wal`, `…-shm` | up to a few MB | SQLite write-ahead log and shared memory |
| `crypto/bot-sdk.json` | ~270 B | matrix-bot-sdk metadata: device id, per-room encryption config (room ids are hashed) |

The SQLite store is the whole reason v2 exists. It is what turns
`Created a new Olm account` on every start into `Reusing stored device …`.

Things worth knowing:

- **A multi-megabyte `-wal` file is normal**, not bloat. SQLite journals there
  while the bot holds the database open and checkpoints it back into the main
  file. It is also why concurrent access corrupts the store.
- **`token.json` and `crypto/` are a matched pair.** The token binds to a device,
  and that device's keys live in the store. Delete one without the other and the
  bot loses its identity: it will log in fresh, get a new device, and need
  `npm run cross-sign` again.
- **Never run two instances against the same `data/`.** Both SDKs warn that
  concurrent access to one crypto store causes corruption and decryption
  failures.
- **Only `token.json` is mode 0600.** The crypto store holds this device's
  private keys but is created world-readable. On a shared machine, tighten it:
  `chmod -R go-rwx data/`.
- Backing up `data/` backs up the bot's identity. It contains live credentials
  and private keys — treat it like `.env.local`.

## Known gaps

- `M_NOT_FOUND: Event not found` is logged at ERROR on startup and per room. It
  is `RoomTracker` probing `m.room.encryption` state and the server truthfully
  answering "no such event" for unencrypted rooms. Harmless, but noisy enough to
  mask a real error.
- Events predating startup are not filtered. Harmless while `sync.json` persists
  the sync token, but clearing `data/` makes the bot reply to old history.
- No Markdown rendering. `matrix-bot-sdk` has `sendHtmlText`, so this is small.
- No way to make the running bot post on demand — sending to an encrypted room
  needs the crypto store, which the running process holds. An input channel
  (HTTP endpoint or watched file) would fix it.
- `matrix-bot-sdk` still depends on the deprecated `request`, which carries
  unpatchable advisories including a critical one in `form-data`. Practical
  exposure is low for a text-only bot talking to a homeserver you control.

## Roadmap

- [x] Login, persistent crypto store, E2EE round-trip, restart survival
- [x] `config` + `dotenv-flow`
- [x] Cross-signing provisioning
- [ ] Quieten expected 404s; ignore pre-startup events
- [ ] Markdown rendering
- [ ] Wire in the agent
- [ ] systemd unit for deployment
