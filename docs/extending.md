# Extending the agent

Everything pi loads — extensions, skills, context files, settings — comes from
`PI_AGENT_DIR` (default `data/pi`), because the bot passes it as `agentDir`.
So you extend the bot exactly as you would extend pi, pointed at that directory.

The bot also exports `PI_CODING_AGENT_DIR` into its own environment, set to the
same path. `agentDir` steers pi's loading but not pi's exported `getAgentDir()`,
which reads that variable and otherwise answers `~/.pi/agent` — so without it an
extension keeps its state in the operator's home directory while the session runs
out of the bot's. **An extension that hardcodes `~/.pi/agent` rather than calling
`getAgentDir()` is unaffected and will still read the home directory**; that is a
bug to report upstream, not something the bot can route around.

**Note the variable is pi's own**, `PI_CODING_AGENT_DIR`, not this project's
`PI_AGENT_DIR`. The pi CLI ignores ours.

## Extensions

**Extensions are where the agent's extra tools come from** — web search, for
instance — and they are not skills. Asked to compare "the skill list", two bots
correctly reported zero each and concluded they were identical, while one had
`pi-web-access` and the other did not. Skills are markdown in
`data/pi/skills/`; tools come from `packages` in `data/pi/settings.json`.

```sh
PI_CODING_AGENT_DIR=./data/pi npx pi install npm:pi-web-access
```

That appends to `packages` in `data/pi/settings.json`. Then send **`.reload`**
in the main room — sessions are created once per room and cached for the process
lifetime, so a running bot otherwise keeps the extension set it started with.
Restarting works too.

On startup the bot logs what loaded, and says so when one fails:

```
[agent] Extensions loaded: pi-web-access
[agent] Extension failed to load (…): …
```

## Prompt templates

Drop `<name>.md` in `data/pi/prompts/` and it runs as `/<name>` in any room.
These belong to the deployment; the bot never touches them and ships none.

Adding the name to `COMMANDS` in `src/commands.js` also gives it a `.` alias,
which is worth doing only because Element eats a leading `/`. Nothing does this
today: the bot shipped a `.verify` for a template pi had written for itself,
which meant advertising a command that did nothing on any other install.

## Skills

Drop a skill in `data/pi/skills/` and it is available as `/skill:<name>` in
every room, once you `.reload` (or restart).

## Context files — the closest thing to memory

pi reads `AGENTS.md` (or `CLAUDE.md`) from two places, and both persist across
sessions and restarts:

| Location | Scope |
| --- | --- |
| `data/pi/AGENTS.md` | Every room, every session — the bot's standing instructions, shipped and installed (below) |
| `$BOT_CWD/AGENTS.md`, and every ancestor directory | Project scope — and where your own instructions go |

pi takes the **first** of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`,
`CLAUDE.md`, `CLAUDE.MD` in each directory and ignores the others, so there is
room for one file per directory, not one per purpose.

`data/pi/AGENTS.md` is the natural home for things the agent should always know.
Note the project-scoped one follows `BOT_CWD`, so with the default under `/tmp`
it will not survive a reboot — point `BOT_CWD` at a durable path if you intend
to keep context there.

**The bot ships its own `AGENTS.md`** and installs it there on every start, from
`agent/` at the repo root. It tells the agent what it is: reached through a chat
client rather than a terminal, its name and user id and working directory, one
session per room, one run at a time, answers posted whole and never edited
afterwards, which commands the bot handles before the agent sees them, and that
it has no Matrix client of its own. Without it an agent answers "who are you" as
whatever a coding agent assumes by default. It also points at
`data/main-room.json`, so the answer names the real main room and admin instead
of being invented, and carries the outbox protocol — including that the outbox
is not how it replies, which cost one double-posted answer to learn.

Two rules there exist because their absence produced something worse:

- **Silence is answering with a single `.`**, which the bot drops. Asked for
  "no text at all" the agent ran `bash true` twice hunting for an action that
  does nothing, then sent `.` anyway — and `.` reached the room, because it is
  not empty.
- **Do not narrate what the room already watched.** Every tool call is rendered
  into the reply with a tick when it succeeds, so "Done! Message sent." repeats
  the screen back at the person.

Anything that differs per room or per message goes in a `[context]` block in
front of the message instead: who sent it, on every turn because it changes
between turns, and the room's name and id on the first turn of a session. A
message beginning with `/` carries no block at all — a prefix would stop pi
expanding the template — which is why `AGENTS.md` tells the agent it is
sometimes not told the sender, and never to guess one.

This is a context file rather than a command on purpose. "Who are you" is a
thing people ask in ordinary conversation, and a `.whoami` would only have
answered when someone knew to type it.

It is installed rather than symlinked so paths can be filled in — the agent runs
in `BOT_CWD`, which is neither the repo nor `DATA_DIR`, so anything naming a path
needs an absolute one and that differs per host. `{{DATA_DIR}}`, `{{BOT_CWD}}`,
`{{OUTBOX_DIR}}`, `{{MATRIX_USER_ID}}` and `{{BOT_NAME}}` are substituted as the
file is written;
anything else is left in place and warned about, since an emptied path would read
as a working instruction. Edit `agent/`, not the installed copy: the next start
overwrites it.

**An `AGENTS.md` the bot did not write is never touched.** The installed copy
carries a marker line; a file without it is left exactly as it is, with a
warning.

That case is worth avoiding rather than living with. pi reads **one context file
per directory** — the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`,
`CLAUDE.md`, `CLAUDE.MD` — so a file of yours in `data/pi/` keeps the bot's out,
and the agent no longer knows what it is. Put your own standing instructions in
`$BOT_CWD/AGENTS.md` instead: it is a different directory, so pi loads it as
well as the bot's.

This is distinct from conversation history, which `SESSION_DIR` persists per
room. Context files are instructions; sessions are what was said.

---

[← README](../README.md)
