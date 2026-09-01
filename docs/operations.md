# Running it

Cross-signing, what the bot keeps on disk, and what is known to be missing.

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

## Known gaps

- **A failed run is indistinguishable from a deliberate silence.** pi retries an
  API failure internally and then resolves, so `prompt()` does not throw and the
  error path never runs. The reply buffer is empty, which is also how the agent
  says nothing on purpose — so the run is logged `said nothing` at INFO and the
  room is told nothing at all. Observed twice on 2026-09-01, on a provider quota
  limit (`429`) and on provider overload (`529`): a question was asked, four
  retries failed, and the sender saw no reply and no reason. pi exposes
  `auto_retry_start` and `auto_retry_end { success, finalError }`, which is the
  signal needed to tell the two apart.
- Events predating startup are not filtered. Harmless while `sync.json` persists
  the sync token, but clearing `data/` makes the bot replay old history — which
  now means *executing* it, not echoing it.
- No timeout on an agent run. A wedged run holds its room's queue until the
  process restarts.
- The `M_NOT_FOUND` log filter drops *every* such error from `MatrixHttpClient`,
  not just the expected encryption-state probe.
- Sessions are never evicted from memory; the map only grows.
- The bot-to-bot limit is per process: restarting clears the counters, so a pair
  mid-runaway resumes with a fresh allowance.
- `BOT_CWD` in the committed `.env` is an absolute path from one machine.
- No service unit. Deployments run it under whatever supervises them; there is
  no systemd unit in the repo.
- `matrix-bot-sdk` depends on the deprecated `request`, which carries
  unpatchable advisories including a critical one in `form-data`. Practical
  exposure is low for a text-only bot talking to a homeserver you control.

---

[← README](../README.md)
