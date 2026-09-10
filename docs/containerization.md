# Running it in a container

Nothing here is built yet. This is the plan and the constraints it has to
satisfy, written down first because most of them are things that fail *after* a
clean build rather than during one.

## What is being containerized

pi ships [its own containerization guide](https://pi.dev/docs/latest/containerization),
and it is worth reading, but it solves a different problem: it puts **the pi CLI**
in a container for an interactive session. This bot runs pi as a *library*
inside a long-lived process, so only some of that transfers.

| pi's guide | here |
| --- | --- |
| `npm install -g pi`, `ENTRYPOINT ["pi"]` | pi is a dependency; the app is the image |
| interactive, `--rm` | long-running, restarted in place |
| named volume for `~/.pi/agent`, optional | `data/` is the bot's Matrix identity, not a convenience |
| `-v "$PWD:/workspace"` | `BOT_CWD`, plus three more directories that must outlive the container |

The one thing to take verbatim is the base image.

## The image

**Debian, not Alpine.** The crypto binding ships as
`matrix-sdk-crypto.linux-x64-gnu.node` and declares no musl variant, so a musl
image builds fine and then fails at the first message with `Cannot find module
'…-linux-x64-gnu'`. pi's guide reaches the same base independently:

```dockerfile
FROM node:24-bookworm-slim
```

**Install scripts are needed for exactly one package.** pi's guide installs with
`--ignore-scripts`, which is right for pi and wrong for us: the crypto binding
is *fetched* by its own install script (`download-lib.js`). A Dockerfile that
inherits that flag produces an image that starts, joins rooms, and dies on the
first message. Approve that one package and no others — see
[configuration](configuration.md).

**The agent's tools need binaries in the image.** The toolset is `bash, read,
write, edit, grep, find, ls`, and pi's `grep` shells out to **ripgrep** (there
is an `rgPath` in its tool source). On this host `rg` has always been present,
so it has never been visible as a dependency. In a slim image its absence shows
up as one tool erroring rather than the bot failing, which is worse. At minimum:

```
bash ca-certificates git ripgrep
```

`git` and `ca-certificates` come from pi's own list; `ca-certificates` is also
what lets the agent reach a homeserver over TLS.

## What has to survive the container

Losing any of these is not "losing a cache".

| Path | Set by | What is lost if it is ephemeral |
| --- | --- | --- |
| `data/` | `DATA_DIR` | **The bot's identity.** `token.json` and `crypto/` are a matched pair; without them every start is a new device, undecryptable to everyone until `npm run cross-sign` runs again. Also holds `main-room.json`, `agent.json` and `bot.lock` |
| `sessions/` | `SESSION_DIR` | Every room's memory. The bot still runs, and answers as though it has never met anyone |
| `inbox/` | `INBOX_DIR` | Work in flight. This is also a **bind mount, not a named volume**, if anything on the host drops jobs |
| `outbox/` | `OUTBOX_DIR` | Text waiting to be posted, same reasoning |
| the agent's workspace | `BOT_CWD` | Whatever the agent has been building. On this deployment that is the trading workspaces |
| `/var/spool/cron/crontabs` | — | The agent's own schedule; see below |

`PI_AGENT_DIR` defaults inside `DATA_DIR`, so it is covered — but it holds
provider credentials, which is worth knowing before mounting `data/` anywhere
convenient.

## Cron

The bots schedule themselves. The hourly health report and every trading tick
exist because someone asked in a room and the agent wrote the script and the
crontab entry. Containerizing naively takes that away, so it is the first thing
to decide rather than the last.

**Jobs that only produce a spool file can live inside.** Three of the four here
touch nothing but the workspace directory, the network, and `inbox/`:

```
trading-tick, trading-digest   workspace dir → inbox
weather-cron                   curl → inbox
```

**Jobs that report on the host must stay on the host.** `hourly-stats.sh` runs
`df` and `free`. Inside a container those describe the container, so the job
would keep working and quietly report the wrong machine. Left on host cron it
writes into the bind-mounted `inbox/`, which needs no access to the container
at all — so this costs nothing.

That is the split: **by what a job needs to see**, not by convenience.

For the jobs that live inside, three options:

1. **A cron daemon in the container.** The only one that keeps `crontab -e`
   working, so the agent goes on scheduling itself. Costs a second process, so
   the image needs an init and a supervisor (`tini` plus a wrapper, or s6), and
   `/var/spool/cron/crontabs` has to be a volume or the agent's edits die with
   the container. Cron also hands jobs a bare environment — no image `ENV`,
   minimal `PATH` — which is the kind of thing that fails silently.
2. **`supercronic`.** One process, logs to stdout, built for containers. It
   reads a crontab *file*, so `crontab -e` semantics go away and the agent would
   edit a file instead. Whether it reloads on change needs checking before
   committing to it.
3. **Host cron only.** Works today unchanged, since the spool is already the
   boundary. But the agent cannot edit the host's crontab from inside, and
   bridging that back — a host watcher applying a crontab the container writes —
   hands the container arbitrary host command execution. The isolation would be
   theatre.

## Known limits

- **The instance lock does not cross machines.** `data/bot.lock` holds a pid and
  checks it with `process.kill(pid, 0)`, which is meaningless in another
  namespace. Two containers sharing one `data/` volume will both start, and that
  is precisely the fault the lock exists to prevent — see
  [operations](operations.md).
- **Isolation is not the same as safety here.** The agent runs `bash` with no
  approval gate. A container bounds what that reaches, which is worth having,
  but `MATRIX_ALLOWED_USERS` is still the thing deciding who may drive it.
- **Anything bind-mounted is not isolated.** A mounted workspace with API keys
  in it is as reachable from the container as it was from the host.

---

[← README](../README.md)
