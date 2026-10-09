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
  each other; a run of automated messages with nobody else speaking stops being
  *answered* after a few turns, and a message from a person resumes it. The
  unanswered ones are still read into the next reply's context, so an agent's
  view of a room matches everyone else's — bounded to the last few, truncated. That bounds the
  cost of a runaway, not who may cause one — the allowlist is what decides who
  may drive the agent.
- **The spools are as powerful as a message.** Anything that can write to
  `OUTBOX_DIR` speaks as the bot; anything that can write to `INBOX_DIR` gives
  the agent instructions, which is the same reach as sending it a message —
  shell included, and without passing the allowlist, which only governs Matrix
  senders. Both default under the repo; put them somewhere only the bot's user
  can write.
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

`npm audit` names 12 packages, which overstates it: **7 carry advisories** and
5 are listed only because they depend on one. The pass-through names are
`matrix-bot-sdk` itself, `express`, `body-parser`, `request-promise` and
`request-promise-core` — each with zero advisories of its own.

The 11 real advisories (3 critical, 1 high, 7 moderate) have **two** root
causes, both under `matrix-bot-sdk`, and none is currently fixable:

```
matrix-bot-sdk -> request (deprecated 2020) -> form-data, qs, tough-cookie, uuid
matrix-bot-sdk -> express 4                 -> body-parser, morgan, proxy-addr
```

`request` was deprecated in 2020 and will not be patched, so those advisories
report "No fix available". The express ones are fixable upstream in principle,
but `matrix-bot-sdk@0.8.0` is the latest release and still declares both.

**This list was wrong for a while, and the way it was wrong is worth keeping.**
It said *all* the advisories were the `request` chain, and stopped being true
twice over: express arrived without anyone noticing, and pi pinned a vulnerable
`undici` — ten advisories, two of them high, including a TLS certificate
validation bypass. The undici ones were real and *fixable*, and sat here
unnoticed because the count was being read as a number rather than a set. They
cleared when pi went to 1.1.0. Read the set, not the total.

### Assessed exposure

The `request` chain, reached only as an HTTP *client* talking to one homeserver:

| Advisory | Severity | Reachable here? |
| --- | --- | --- |
| `form-data` — unsafe boundary randomness; CRLF injection via unescaped multipart field names | critical / high | **No.** Both require multipart requests. `matrix-bot-sdk/lib` contains no multipart or form-data usage, and this bot sends text only — it never uploads media |
| `qs` — arrayLimit bypasses, DoS via attacker-controlled `isBuffer` | moderate | **No.** All three affect servers parsing untrusted query strings. This is a client |
| `request` — server-side request forgery | moderate | **Unlikely.** Requires an attacker to choose the request target. The bot requests only the homeserver in its configuration; a hostile homeserver redirecting it elsewhere is the residual case, which is the `tough-cookie` scenario below |
| `tough-cookie` — prototype pollution | moderate | **Unlikely.** Requires a malicious server response; the bot talks to one homeserver you control |
| `uuid` — missing buffer bounds check in v3/v5/v6 | moderate | **No.** Only when a `buf` argument is passed; nothing here does |

The express chain, which is **never instantiated**:

| Advisory | Severity | Reachable here? |
| --- | --- | --- |
| `proxy-addr` — IP spoofing via IPv4-mapped IPv6 trust subnet | critical | **No.** Express's trust-proxy handling, which requires an HTTP server receiving requests |
| `morgan` — log forging and log injection via unescaped separators and quotes | moderate | **No.** Express request-logging middleware, reached only by a running server |

`matrix-bot-sdk` ships express for its appservice and webhook features. This bot
uses none of them: it is a `MatrixClient` that syncs outbound. Checked rather
than assumed — there is no reference to `appservice`, `webhook`, `express`,
`.listen(` or `createServer` anywhere in `src/` or `scripts/`, and the running
container holds no listening socket of its own (the only entry in
`/proc/net/tcp` is Docker's embedded DNS resolver at `127.0.0.11`).

That is the whole assessment for those two: an advisory in a server framework
that never serves is unreachable, and would become reachable the moment this
bot grew a webhook endpoint.

### Why it is not "fixed"

- `npm audit fix --force` resolves this by downgrading or replacing
  `matrix-bot-sdk`, which is the whole E2EE stack. Do not run it.
- An `overrides` entry forcing newer `form-data`/`qs` is possible, but `request`
  pins those majors deliberately. That trades an unreachable advisory for a real
  risk of breaking the HTTP layer carrying encrypted traffic.

The genuine fix is upstream: `matrix-bot-sdk` dropping `request` and moving off
express 4.

### What would change this assessment

- This bot gaining media upload, which would exercise the `form-data` multipart
  path and make that critical advisory reachable.
- This bot gaining any HTTP endpoint — a webhook, a health check, an appservice
  — which would instantiate express and make `proxy-addr` and `morgan` live.
- Pointing the bot at a homeserver you do not control, which raises the
  `tough-cookie` and `request` SSRF exposure.
- `matrix-bot-sdk` publishing a release without `request` — at which point
  upgrade.
- **A new name appearing in the list.** The two chains above are what is
  assessed; anything else is unassessed by definition. `npm audit` after a
  dependency bump is worth reading by package name, not by count.
