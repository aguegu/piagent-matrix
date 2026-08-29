# pi integration notes

How `@earendil-works/pi-coding-agent` is wired into the bot, and the parts of
its API that are easy to get wrong. Verified against version `0.84.3` and a live
homeserver.

## Where the agent sits

`src/index.js`, inside the `room.message` handler:

```js
await client.sendReadReceipt(roomId, event.event_id).catch(() => {});

await withTyping(client, roomId, async () => {
  const agent = await getAgent();
  await agent.handleMessage({ roomId, text: body, sender: event.sender, client });
});
```

`withTyping()` (`src/status.js`) keeps a typing indicator alive for as long as
whatever it wraps, and always clears it, including on throw. The agent is a lazy
singleton: the first call pays for `ModelRuntime.create()` (auth and model
catalog from disk), later calls reuse the same `AgentManager`.

Everything upstream — allowlist, msgtype filter, self-message skip, encryption
detection — is handled before that point.

## API facts worth knowing

- `createAgentSession({ cwd, agentDir, sessionManager, modelRuntime, model, thinkingLevel })`
  returns `{ session, extensionsResult, modelFallbackMessage }`.
- `session.subscribe(listener)` returns an unsubscribe function.
- Streaming text arrives as `event.type === "message_update"` →
  `event.assistantMessageEvent.type === "text_delta"`. Prefer
  `extractText(sub.partial)` over concatenating deltas: the partial already
  carries the merged content, so it is idempotent across re-emissions.
- Each assistant message's `partial` covers **only that message**. A run with a
  tool call emits several, so assigning rather than appending keeps only the
  last one and silently drops the prose in between.

### Three that bite

**`Model` has no `providerId`.** The field is `provider`. A lookup on
`providerId` matches nothing and falls through to `available[0]` without
complaint. The real fields are
`id, name, api, provider, baseUrl, reasoning, input, cost, contextWindow, maxTokens`.

**`prompt()` returns immediately when the session is already streaming.** It
resolves when the whole run finishes — *except* mid-run, where it queues the
text as a follow-up and returns at once. A caller that awaits it and then
renders a final answer renders nothing, while its text lands in the previous
run's output. Serialize runs per room; subscribe before awaiting so the start is
not missed.

**A `pi` CLI run exports the model in two halves.** `PI_MODEL=MiniMax-M3` and
`PI_PROVIDER=minimax-cn`, so a bare id is what the shell usually holds and
`want.split("/")` yields one element. This bot does not read either: the model
is a runtime setting recorded in `data/agent.json`, and honouring the shell let
a leftover export decide it invisibly. A bare id typed into `.model` matches on
id alone, and the reply names the full `provider/id` it settled on.

`tool_execution_start` / `tool_execution_end` arrive on the same subscription
and are worth surfacing: during a long tool call nothing else is emitted, so the
room looks frozen.

## Design decisions

- **No placeholder-then-edit replies.** An early build sent `_thinking…_` and
  edited it into the answer; Element marks edited messages `(edited)`, which
  reads poorly for a bot. Rejected in review. The typing indicator is the
  progress signal. If a long run needs more, raise it rather than reinstating
  the placeholder.
- **Buffer, then send one message.** Tool-call lines and assistant text
  accumulate in memory and go out as a single `m.room.message` when
  `session.prompt()` resolves. Long runs stay visible because tool lines appear
  inline as `⏺ bash(…) ✓`.
- **`LiveMessage` in `src/status.js` is unused but kept.** It gets the
  non-obvious encrypted-room edit right: `m.relates_to` must stay in cleartext,
  because `client.sendEvent()` encrypts the whole content and would bury the
  relation. Do not rewrite that from scratch if edit-in-place returns.
- **One session per room.** Rooms are the natural conversation boundary. `cwd`
  is global; per-room cwd is out of scope.

## Configuration

Read through `config/default.js` (`node-config`, with `dotenv-flow` loading
`.env` then `.env.local`). See the README for the full table; the agent-facing
ones are:

| Env var | Default | Used for |
| --- | --- | --- |
| `BOT_CWD` | `/tmp/piagent-workspace` (from `.env`) | agent working directory; the bot refuses to start if unset |
| `PI_AGENT_DIR` | `${DATA_DIR}/pi` | pi's auth, settings, skills, extensions |
| `SESSION_DIR` | `./sessions` | per-room conversation history |
| `OUTBOX_DIR` | `./outbox` | spool the agent can write to |

## Landmines

- **Never run two processes against the same `data/`.** Concurrent access to one
  crypto store desynchronises the Megolm ratchet and produces messages strict
  clients refuse to decrypt. Anything else that needs to post uses the outbox.
- `data/token.json` and `data/crypto/` are a matched pair. Losing one
  invalidates the other and needs re-provisioning plus `npm run cross-sign`.
- Events predating startup are not filtered. Harmless while `sync.json`
  persists, but clearing `data/` makes the bot replay old history — which now
  means *executing* it.
- Shell-level `PI_MODEL` / `PI_PROVIDER` from a prior `pi` run leak into the
  bot's environment. Neither is read — the model is recorded in
  `data/agent.json` and set with `.model`.
- Sessions are cached per room for the process lifetime, so newly installed
  extensions and skills need a restart.
- **`agentDir` does not reach extensions.** Passing it to `createAgentSession`
  steers pi's own loading, but an extension asking pi where the agent directory
  is calls the exported `getAgentDir()`, which reads `PI_CODING_AGENT_DIR` and
  otherwise answers `~/.pi/agent`. The bot exports it to match. An extension
  that hardcodes `homedir()/.pi/agent` instead of calling `getAgentDir()` is
  beyond reach — that is a bug to report upstream.
- Prompt templates are **not** context. pi loads them from `agentDir/prompts`
  and `$cwd/.pi/prompts`, non-recursively, named by filename, and expands one
  only when a message starts with `/<name>` — so a directory of them costs
  nothing per turn. A context file is read on every turn instead, which is the
  argument for keeping `AGENTS.md` short.
