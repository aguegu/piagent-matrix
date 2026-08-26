# Handoff: wiring the pi agent into v2

Notes for whoever wires `@earendil-works/pi-coding-agent` into this bot. Written
after a first attempt in v1 (`../src/agent.js`, untracked) that never produced a
reply. Everything below was verified against the installed package and a live
homeserver, not inferred from docs.

## Where the agent goes

`src/index.js`, inside the `room.message` handler:

```js
await client.sendReadReceipt(roomId, event.event_id).catch(() => {});

await withTyping(client, roomId, async () => {
  await client.replyText(roomId, event, `Echo: ${body}`);   // <- replace this
});
```

`withTyping()` (`src/status.js`) keeps a typing indicator alive for the duration
of whatever it wraps and always clears it, including on throw. It already does
the right thing for a slow agent run; leave it in place.

Everything upstream of that line — allowlist, msgtype filter, self-message skip,
encryption detection — is already handled.

## pi API facts (verified)

- `createAgentSession({ cwd, sessionManager, modelRuntime, model, thinkingLevel })`
  returns `{ session, extensionsResult, modelFallbackMessage }`.
- `session.subscribe(listener)` returns an unsubscribe function.
- Streaming text arrives as
  `event.type === "message_update"` → `event.assistantMessageEvent.type === "text_delta"`
  → `.delta` is a plain string.
- `await session.prompt(text, { streamingBehavior })` resolves when the whole run
  finishes, not when it starts. **But** if the session is already streaming it
  queues and returns *immediately* — so a caller that awaits it and then renders
  a final answer will render nothing.
- `thinking_delta` and `toolcall_start` come through the same subscription and
  are worth surfacing: during a long tool call nothing else is emitted, so the
  room looks frozen.

## Bugs in v1's attempt — do not repeat

1. **`Model` has no `providerId`.** The field is `provider`. v1 did
   `available.find(m => m.providerId === "anthropic")`, which never matched and
   silently fell through to `available[0]`. The log gave it away:
   `using model undefined/MiniMax-M2.7`. Real fields:
   `id, name, api, provider, baseUrl, reasoning, input, cost, contextWindow, maxTokens`.

2. **Session creation was racy.** `#getOrCreateSession` awaited
   `createAgentSession` *before* storing anything in the map, so two messages
   arriving close together each created a session and the second overwrote the
   first. Observed live — two `Created new agent session` lines for one room.
   Cache the *promise* in the map, not the resolved value.

3. **A pending edit timer was not cleared on the error path**, so a stale flush
   could fire after the error message was written and overwrite it.

4. **No reply ever rendered.** 12 outbound messages, zero edits, no error logged
   — the run just hung. Never diagnosed, because the model situation (below) was
   the more likely root cause and pi was parked before it was chased down.

## Model / auth situation

At the time of writing only one provider was authenticated in pi:

```
minimax-cn   MiniMax-M2.7
minimax-cn   MiniMax-M2.7-highspeed
minimax-cn   MiniMax-M3
```

No `anthropic`. Check with:

```js
const rt = await ModelRuntime.create();
(await rt.getAvailable()).forEach(m => console.log(m.provider, m.id));
```

Decide explicitly which provider to use and make it configurable — v1 hardcoded
a preference that silently didn't apply. `config/default.js` is the place;
nothing reads `PI_MODEL` or `PI_THINKING_LEVEL` today.

## Design decisions already made

- **No placeholder-then-edit replies.** An earlier build sent `_thinking…_` and
  edited it into the answer; the user explicitly disliked it. The typing
  indicator is the accepted progress signal. If a long agent run needs more,
  raise it rather than reinstating the placeholder.
- `LiveMessage` in `src/status.js` implements throttled edit-in-place and is
  currently **unused**. It handles the non-obvious part correctly: in encrypted
  rooms `m.relates_to` must stay in cleartext, because `client.sendEvent()`
  encrypts the whole content and would bury the relation, making clients render
  each edit as a new message. Verified working before being taken out of the
  path. Delete it or use it, but do not rewrite that logic from scratch.
- One session per room is the right model; rooms are the natural conversation
  boundary. `cwd` was global in v1 — consider whether it should be per-room.

## Landmines

- **Never run two processes against the same `data/`.** Both SDKs warn that
  concurrent access to one crypto store causes corruption. This happened twice
  during development; symptoms would be decryption failures.
- `data/token.json` and `data/crypto/` are a matched pair. Losing one
  invalidates the other and needs re-provisioning plus `npm run cross-sign`.
- `M_NOT_FOUND: Event not found` at ERROR is expected noise — `RoomTracker`
  probing `m.room.encryption` on unencrypted rooms. Not a failure.
- Events predating startup are not filtered. Safe while `sync.json` persists,
  but clearing `data/` makes the bot reply to old history — including, once the
  agent is wired in, actually executing it.
- The bot has no input channel. Making the running process post on demand needs
  one; sending from a second process requires stopping the bot first.
