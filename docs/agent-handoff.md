# Handoff: wiring the pi agent into v2

Notes for whoever touches the agent wiring. Written after the first attempt
in v1 (now archived as the `v1` git tag) never produced a reply, and after
v2's first working version proved out the design below. Verified against the
installed package and a live homeserver.

## Where the agent goes

`src/index.js`, inside the `room.message` handler:

```js
await client.sendReadReceipt(roomId, event.event_id).catch(() => {});

await withTyping(client, roomId, async () => {
  const agent = await getAgent();
  await agent.handleMessage({ roomId, text: body, sender: event.sender, client });
});
```

`withTyping()` (`src/status.js`) keeps a typing indicator alive for the duration
of whatever it wraps and always clears it, including on throw. The agent is a
lazy singleton (`getAgent()` in `src/index.js`); the first call pays for
`ModelRuntime.create()` (auth + models catalog from disk), subsequent calls
reuse the same `AgentManager`.

Everything upstream of that line — allowlist, msgtype filter, self-message skip,
encryption detection — is already handled.

## pi API facts (verified against `@earendil-works/pi-coding-agent@0.84.3`)

- `createAgentSession({ cwd, sessionManager, modelRuntime, model, thinkingLevel })`
  returns `{ session, extensionsResult, modelFallbackMessage }`.
- `session.subscribe(listener)` returns an unsubscribe function.
- Streaming text arrives as
  `event.type === "message_update"` → `event.assistantMessageEvent.type === "text_delta"`.
  The cleanest way to track the current text is `extractText(sub.partial)` —
  concatenating deltas works too, but the partial already carries the merged
  content, so it's idempotent across re-emissions.
- `await session.prompt(text, { streamingBehavior })` resolves when the whole run
  finishes, not when it starts. **But** if the session is already streaming it
  queues and returns *immediately* — so a caller that awaits it and then renders
  a final answer will render nothing. Subscribe to events before awaiting
  prompt() so you don't miss the start.
- `tool_execution_start` / `tool_execution_end` come through the same
  subscription and are worth surfacing: during a long tool call nothing else is
  emitted, so the room looks frozen.

## Bugs in the v1 attempt — do not repeat

1. **`Model` has no `providerId`.** The field is `provider`. v1 did
   `available.find(m => m.providerId === "anthropic")`, which never matched and
   silently fell through to `available[0]`. Real fields:
   `id, name, api, provider, baseUrl, reasoning, input, cost, contextWindow, maxTokens`.

2. **Session creation was racy.** v1's `#getOrCreateSession` awaited
   `createAgentSession` *before* storing anything in the map, so two messages
   arriving close together each created a session and the second overwrote the
   first. Observed live — two `Created new agent session` lines for one room.
   Cache the *promise* in the map, not the resolved value.

3. **`PI_MODEL` is often a bare id, not `provider/id`.** The shell exports
   `PI_MODEL=MiniMax-M3` and `PI_PROVIDER=minimax-cn` separately after a `pi`
   CLI run. A naïve `want.split("/")` yields `["MiniMax-M3"]` and the lookup
   fails. Fall back to `process.env.PI_PROVIDER` when there's no slash.

4. **No reply ever rendered.** 12 outbound messages, zero edits, no error logged
   — the run just hung. Never diagnosed, because the model situation was the
   more likely root cause and pi was parked before it was chased down.

## Design decisions made

- **No placeholder-then-edit replies.** An earlier build sent `_thinking…_` and
  edited it into the answer; the user explicitly disliked it. The typing
  indicator is the accepted progress signal. If a long agent run needs more,
  raise it rather than reinstating the placeholder.
- **Buffer everything, send one clean message at the end.** The first working
  version used `LiveMessage` (edit-in-place via `m.replace`), but Element
  renders edited messages with an inline `(edited)` marker and the user found
  that visually wrong. The current code accumulates tool-call lines and the
  final assistant text into an in-memory buffer, then sends a single
  `m.room.message` once `session.prompt()` resolves. Long tool runs are still
  visible because the tool-call status lines surface in the final reply as
  `⏺ Bash(...)  ✓` above the answer text.
- **`LiveMessage` in `src/status.js` is now unused.** It handles the
  non-obvious encrypted-room edit dance correctly: `m.relates_to` must stay
  in cleartext, because `client.sendEvent()` encrypts the whole content and
  would bury the relation. Keep it around in case edit-in-place comes back,
  but do not wire it into the reply path.
- **One session per room is the right model.** Rooms are the natural
  conversation boundary. `cwd` is global (`BOT_CWD` env, default
  `process.cwd()`); per-room cwd was explicitly out of scope for the first cut.

## Configuration

Read from env via `config/default.js` (the `node-config` package, with
`dotenv-flow` already loading `.env` then `.env.local`):

| Env var             | Default                       | Used for                       |
| ------------------- | ----------------------------- | ------------------------------ |
| `MATRIX_HOMESERVER` | (required)                    | `matrix.homeserver`            |
| `MATRIX_USER_ID`    | (required)                    | bot MXID                       |
| `MATRIX_PASSWORD`   | (only first login)            | `matrix.password`              |
| `MATRIX_DEVICE_NAME`| `tradebots-matrix`         | shown in Element session list  |
| `MATRIX_ALLOWED_USERS` | (warns if empty)           | per-message sender filter      |
| `DATA_DIR`          | `./data`                      | token / sync / crypto location |
| `MATRIX_RECOVERY_KEY` | (only used by `npm run cross-sign`) | unlock 4S for cross-signing |
| `LOG_LEVEL`         | `info`                        | `debug|info|warn|error`        |
| `BOT_CWD`           | `process.cwd()`               | `cwd` for the agent            |
| `PI_MODEL`          | (first available)             | `provider/id` or bare `id`     |
| `PI_THINKING_LEVEL` | `low`                         | `off\|minimal\|low\|medium\|high\|xhigh\|max` |

## Landmines

- **Never run two processes against the same `data/`.** Both SDKs warn that
  concurrent access to one crypto store causes corruption. This happened twice
  during development; symptoms would be decryption failures.
- `data/token.json` and `data/crypto/` are a matched pair. Losing one
  invalidates the other and needs re-provisioning plus `npm run cross-sign`.
- `M_NOT_FOUND: Event not found` at ERROR is expected noise — probing
  `m.room.encryption` on unencrypted rooms. Not a failure.
- Events predating startup are not filtered. Safe while `sync.json` persists,
  but clearing `data/` makes the bot reply to old history — including, once the
  agent is wired in, actually executing it.
- The bot has no input channel. Making the running process post on demand needs
  one; sending from a second process requires stopping the bot first.
- Shell-level `PI_MODEL` and `PI_PROVIDER` set by a prior `pi` CLI invocation
  leak into the bot. The current code treats them as a hint, not an override —
  the bot logs what it actually used.
