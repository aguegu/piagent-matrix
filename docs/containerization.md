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

### The decision: a crontab file, not a crontab

The schedule is **a file in a volume**, read by
[`supercronic`](https://github.com/aptible/supercronic), which exists for this
job: one foreground process, jobs logged to stdout, no root, and `-inotify` to
"start a watch on the crontab file, reloading it on changes". `SIGUSR2` forces a
reload if the watch ever misses one.

A file suits the agent better than `crontab -e` did. Editing a file is what its
`write` and `edit` tools already do; driving an interactive `crontab` session
never was. And persistence stops being a question about `/var/spool` ownership
and becomes one mounted path.

The rejected alternatives, for the record:

- **A real cron daemon inside.** Keeps `crontab -e`, but costs a second process
  needing an init and a supervisor, and `/var/spool/cron/crontabs` has to be
  mounted with the right ownership before an edit survives a recreate.
- **Host cron only.** Works today unchanged, since the spool is already the
  boundary — but the agent cannot edit the host's crontab from inside, and
  bridging that back (a host watcher applying a crontab the container writes)
  hands the container arbitrary host command execution. The isolation would be
  theatre.

### Still open: one container or two

`supercronic` is a separate process either way. It can run beside the bot under
an init, or in its own container sharing the volumes.

A sidecar is the better fit for a reason specific to this project: **the spool
is already the interface between "something that schedules" and "the bot".**
A cron container that mounts `inbox/` and the workspace needs no other contact
with the bot at all — no supervisor, no shared lifecycle, one process each.
That is the same boundary the outbox was built around in 0.2.0.

Two things to test before committing to it:

- **inotify across the mount.** The agent writes the crontab from the bot
  container; supercronic watches it from another. Both are the same host
  directory, so events should propagate — but if the agent writes atomically
  (temp file, then rename) the watch follows the old inode and may go deaf.
  `SIGUSR2`, or editing in place, is the fallback.
- **A bare environment.** Cron hands jobs almost no environment — no image
  `ENV`, minimal `PATH`. The `%` incident is a reminder of how quietly a
  crontab can be wrong.

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
