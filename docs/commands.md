# Commands

A short allowlist, recognised before the agent sees the message. **Commands
belong to the main room** — see below.

| Command | Where | What it does |
| --- | --- | --- |
| `.info` | any room | Shows the model, thinking level, build, uptime and extensions |
| `.reload` | main room | pi's `/reload` — re-reads extensions, skills, prompts and context files |
| `.rooms` | main room | Lists the rooms the bot is in; `.rooms leave <roomId>` leaves one |
| `.model` | main room | Shows the model and what else is available; `.model <provider/id>` switches it |
| `.thinking` | main room | Shows the thinking level; `.thinking <level>` sets it |
| `.help` | main room | Lists the commands, and the prompt templates and skills installed |

**Use a leading dot, not a slash.** Element intercepts `/` for its own commands,
so `/help` opens Element's help and never reaches the bot. A leading `/` is
still accepted for clients that pass it through, but `.` is the reliable form.

## The main room holds the controls

Every command but `.info` either reconfigures the bot for *all* rooms
(`.model`, `.thinking`, `.reload`) or reports on it (`.rooms`, `.help`). One
agent config backs every room, so a switch made in a working room would
reconfigure the others without their knowing, and only the room that did it
would see the confirmation. That belongs in the bot's control channel.

A working room may hold people who are not the bot's admin, so it gets `.info`
and nothing else. Anything else there is answered with a flat
`` `.model` is not available here. `` — no reason, and **never the main room's
id**. Nothing outside the main room hints that one exists: `.help` does not run
there either, so the listing above is never shown to a room that cannot use it.

If no main room is established, everything is allowed rather than leaving the
bot with one usable command.

## What each one does

`.info` is the whole command surface of a working room: the model, the thinking
level, the build — `piagent-matrix 0.2.2 (b15ea83)` — and when the process
started, with how long it has been up. It reads; it changes nothing.

The uptime is computed per call, unlike the build: the point of it is that it
moves. Between them they answer the two questions asked of a deployment — which
code is this, and did it actually restart when I restarted it.

It also lists the **extensions**, which answer the third: what can it actually
do. Once a session exists those are the ones that initialised; before that they
are what `settings.json` asks for, and the line says which it is showing —
configured is not loaded, and an extension that fails to initialise is
configured too. Failures are named. Asked to compare "the skill list", two bots
both reported zero and agreed they matched, while one had `pi-web-access` and
the other had nothing; this is the line that answers that in one message.

The commit is there because the version cannot answer the question people
actually ask. `package.json` is bumped once when a release opens, so every host
between two releases reports the same number while running different code, and
"has this one been upgraded yet?" stays unanswerable. It is read from `.git`
rather than by running git, so there is no subprocess at startup; a deployment
without a checkout reports the version alone, and one without `package.json`
either reports just the name. A worktree or submodule, where `.git` is a file
pointing elsewhere, is followed.

It is read **once, at startup**, not per `.info`. Reading it live would report
whatever is checked out now, so a host pulled but not restarted would name the
new commit while running the old code — the one case this exists to catch. What
it still cannot see is a tree edited in place: the commit says where the
checkout is, not that the files match it. The same line opens the startup log.

There is deliberately no caveat about whether the room has a live session:
sessions are in-memory, so a room chatted in for days would report none after a
restart, and the values are the same either way.

`.reload` calls `AgentSession.reload()` on every live session, not just the room
that asked — extensions and prompts live in the shared `PI_AGENT_DIR`, so
reloading one room would leave the rest stale. Sessions and their history
survive; only the resources are re-read. It is the restart that the *Extending
the agent* section would otherwise require.

`.rooms` answers "where has this bot been invited", which is otherwise visible
only in the startup log. Each line gives the room's name, its id and how many
members it has, and marks the main room. Names are written by whoever made the
room, so they print in a code span rather than rendered — the sanitiser already
blocks anything dangerous, but a room called `**urgent**` should not shout in
the listing.

`.rooms leave <roomId>` leaves one room, straight away. Naming an id copied out
of the listing is deliberate on its own, so there is nothing to confirm; a
copied pair of backticks is stripped, since the listing prints ids in code
spans. Naming the main room's own id works too — whoever can type it there can
kick the bot out anyway, and more easily. The goodbye goes out before the bot
leaves, since afterwards there is no room to send it to; the record goes with
the room, so the next fitting room becomes the control channel and is told so.

There is no "leave everything" form. Leaving is visible to everyone in those
rooms, getting back in needs a fresh invite, and the bot cannot read anything
said while it is away — so it happens one named room at a time, where each one
is a choice rather than a consequence of a word.

The room's cached pi session is dropped as the bot goes; with `SESSION_DIR` set
the conversation is still on disk and resumes if it is invited back.

`.model` and `.thinking` are how the agent is configured — there is no env var
for either. Bare, they report where you are and list what is on offer, since a
room cannot present pi's selector UI. With an argument, they apply the change to
every live session and **record it under `DATA_DIR/agent.json`**, so it survives
a restart. A bot that has never been told starts on the first available model at
thinking level `low`.

Neither is read from the environment, on purpose. An interactive `pi` run
exports `PI_MODEL` and `PI_PROVIDER` into the shell, so honouring them let a
stray export decide the bot's model — invisible influence, and pointless once
the choice is a command away.

Anything unrecognised is an ordinary prompt. `/login` and `/compact`
are deliberately **not** wired up: they need a back-and-forth a room cannot give,
or hand a chat message more reach than it should have. pi's TUI also treats `!`
as "run bash", which is not offered here for the same reason.

---

[← README](../README.md)
