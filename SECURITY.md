# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**) rather than opening a public issue.

This is a personal project maintained on a best-effort basis. There is no SLA.

## Operational risk: what this bot actually does

Read this before deploying it anywhere. The dependency advisories below are the
*less* important half of this document.

**The agent executes shell commands on behalf of chat messages.** It runs with
pi's default toolset — `read`, `bash`, `edit`, `write` — with **no approval
gate**. Anyone who can send it a message can run commands as the user the bot
runs as.

Consequences worth being explicit about:

- **`MATRIX_ALLOWED_USERS` is the only access control.** Leaving it empty means
  *everyone* who can reach the bot is allowed; the bot warns on every message
  when this happens. Set it.
- **Anyone can arrange to reach it: the bot autojoins every invite.**
  `AutojoinRoomsMixin` is set up unconditionally, and the allowlist is checked
  on messages, not on invites. So "anyone who can send it a message" means
  anyone who knows its user id — they invite it, it joins, and with the
  allowlist empty it does as it is told. On a federated homeserver that is not
  limited to your server. The bot's own secrets are readable by the agent (see
  below), so an empty allowlist puts the Matrix access token, the recovery key
  and the model provider credential one message away from a stranger.
- **An empty allowlist can also lose the main room.** A room is adopted when
  none is recorded and the room fits, and *fits* means an allowlisted member is
  present — except with no allowlist, where any room holding the bot and one
  other party qualifies. So on a fresh install the first person to invite the
  bot takes its control channel and is recorded as its admin, which is where
  commands run and where operational output goes. With the allowlist set, a
  stranger's room does not fit and cannot be adopted.
- **Empty also means every *bot*.** Two agents left in one room with no
  allowlist will answer each other with nobody present — observed here for 59
  turns, each running shell commands and spending tokens on the other's output.
  The bot sends `m.notice` and hears it, so agents can say something useful to
  each other; a run of automated messages with nobody else speaking is cut off
  after a few turns, and a message from a person resumes it. That bounds the
  cost of a runaway, not who may cause one — the allowlist is what decides who
  may drive the agent.
- **`BOT_CWD` is not a security boundary.** It sets the agent's working
  directory, so relative paths and file searches resolve there — useful hygiene,
  but the shell is not chrooted and absolute paths reach anything the bot's user
  can read. Keep credentials outside it, and prefer a dedicated directory over a
  home or project root.
- **The bot's own secrets are readable by the user it runs as**, including
  `.env.local` (Matrix password, recovery key), `data/token.json` (access token)
  and `data/pi/auth.json` (model provider credential). File modes do not help
  here: the agent *is* that user.
- **Give the bot its own credentials.** `PI_AGENT_DIR` keeps pi's auth with the
  bot rather than in `~/.pi/agent`, but a *copy* of your personal key is still
  your key: it cannot be revoked independently, and usage is not attributable.
  A separate provider credential bounds the damage of a leak.

For real containment, run the bot as its own unprivileged user, or pass an
explicit `tools` allowlist to `createAgentSession`.

## Encryption

- Only one process may open the crypto store. Two clients sharing it load the
  same outbound Megolm session and each advance their own copy of the ratchet,
  emitting different plaintexts at the same `message_index`. Strict clients
  reject the duplicate as a replay, and the same keystream covers two different
  messages. Other processes must post through the outbox (see README).
- `data/` is the bot's cryptographic identity. Treat a backup of it as you would
  a private key.
- Run `npm run cross-sign` after any fresh login, or Element shows
  "Encrypted by a device not verified by its owner" on everything the bot sends.

## Install scripts

npm may decline to run install scripts, which is a sensible default — but one of
them is required here. `@matrix-org/matrix-sdk-crypto-nodejs` ships no binary;
its `postinstall` downloads a native library over the network at install time,
and without it the bot cannot start.

Approve that one specifically rather than allowing scripts wholesale:

```sh
npm install-scripts approve @matrix-org/matrix-sdk-crypto-nodejs
```

The other scripts npm flags (`@google/genai`, `protobufjs`) are not needed and
can stay unapproved. Setup instructions and the verification step are in the
README.

## Known dependency advisories

`npm audit` reports 8 advisories (2 critical, 6 moderate). **All 8 have a single
root cause** and none are currently fixable:

```
matrix-bot-sdk -> request (deprecated 2020) -> form-data, qs, tough-cookie, uuid
```

`request` was deprecated in 2020 and will not be patched, so every advisory
below reports "No fix available".

**Upgrading does not help.** `matrix-bot-sdk@0.8.0` is the latest release, and
`matrix-bot-sdk@latest` still declares `request: ^2.88.2`.

### Assessed exposure

| Advisory | Severity | Reachable here? |
| --- | --- | --- |
| `form-data` — unsafe boundary randomness; CRLF injection via multipart field names | critical | **No.** Both require multipart requests. `matrix-bot-sdk/lib` contains no multipart or form-data usage, and this bot sends text only — it never uploads media |
| `qs` — arrayLimit bypass, DoS via memory exhaustion | moderate | **No.** Affects servers parsing untrusted query strings. This is an HTTP client |
| `tough-cookie` — prototype pollution | moderate | **Unlikely.** Requires a malicious server response; the bot talks to one homeserver you control |
| `uuid` — missing buffer bounds check in v3/v5/v6 | moderate | **No.** Only when a `buf` argument is passed; nothing here does |

The entire `request` chain is about 730 KB, so this is an *old* dependency
rather than a large one.

### Why it is not "fixed"

- `npm audit fix --force` resolves this by downgrading or replacing
  `matrix-bot-sdk`, which is the whole E2EE stack. Do not run it.
- An `overrides` entry forcing newer `form-data`/`qs` is possible, but `request`
  pins those majors deliberately. That trades an unreachable advisory for a real
  risk of breaking the HTTP layer carrying encrypted traffic.

The genuine fix is upstream: `matrix-bot-sdk` dropping `request`.

### What would change this assessment

- This bot gaining media upload, which would exercise the `form-data` multipart
  path and make the critical advisory reachable.
- Pointing the bot at a homeserver you do not control, which raises the
  `tough-cookie` exposure.
- `matrix-bot-sdk` publishing a release without `request` — at which point
  upgrade.
