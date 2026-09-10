# Running it in a container

The `Dockerfile` works: a second bot runs from it, talks in Matrix, and has a
cross-signed device. For the steps rather than the reasoning, see the
[container quickstart](container-quickstart.md). Cron is not in it yet — that is the next piece, and the
decision behind it is recorded below.

Most of what follows is constraints rather than instructions, because nearly
every one of them fails *after* a clean build rather than during one.

## The goal: a sandbox the agent owns

The container is the agent's own world. It runs `bash` with no approval gate,
so the point of the boundary is that what it reaches is what we chose to give
it — and, just as much, that it need not care about anything outside.

That decides more than it first appears. The spools stop being an interface to
the host and become the bot's own plumbing, so they live with the rest of its
state rather than being mounted through. Work that genuinely belongs to the
host — reporting on the host's own disks, say — stops being this bot's job
rather than being wired back in through a hole in the boundary.

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

**The agent's tools need binaries in the image**, and which ones is a
question with evidence rather than an opinion. Counting the commands in its
bash calls across this deployment's session history:

```
curl 2162    jq 1223    python3 1044
```

All three were absent from the first image, and the failure is quiet: the
agent adapts. Asked to schedule something it tried `at`, then `crontab`, then
fell back to `nohup bash -c 'sleep 300 && …'` and reported success — three
missing tools, no error surfaced to anyone.

`procps` (`free`, `ps`, `top`) goes in for the same reason. pi's own `grep`
tool shells out to **ripgrep**, which every host has had and so never looked
like a dependency; `ca-certificates` is what lets the bot reach a homeserver
over TLS.

```
bash bsdextrautils ca-certificates curl git jq procps python3 ripgrep wget
```

**Two are exceptions, and worth naming as such.** `wget` has zero uses
against curl's 2174; `bsdextrautils` (`column`) has one. Counting says leave
both out. They are in because a container is a sandbox rather than a host: a
tool the agent reaches for and does not find costs it a turn, and the blast
radius inside a boundary already drawn is nil. That argument is about the
sandbox, not about the tools — it does not license adding whatever a normal
image happens to have, and it does not transfer to the host deployment, which
has the whole machine.

The counting is what caught curl, jq and python3 missing in the first place,
so the default stays: **add on evidence, and record the exceptions as
exceptions.** To check what the agent actually runs before adding something:

```sh
grep -ho '"command": *"[^"]*"' sessions/*/*.jsonl | ...   # or the one-liner in git log
```

Still absent, with no uses at all: `nc`, `dig`, `ping`, `unzip`, `ssh`,
`make`, `less`, `vim`. Absence is a loud failure — `command not found`, and
the agent falls back, as it did from `at` to `crontab` to `nohup`. That is a
lost turn, not a wrong answer, which is why the bar is evidence rather than
completeness.

**`at` and `cron` are deliberately absent.** Both accept work and silently
never run it unless their daemon is running — the failure mode two releases
were spent removing. Scheduling is its own decision, below.

## What has to survive the container

Losing any of these is not "losing a cache".

| Path | Set by | What is lost if it is ephemeral |
| --- | --- | --- |
| `data/` | `DATA_DIR` | **The bot's identity.** `token.json` and `crypto/` are a matched pair; without them every start is a new device, undecryptable to everyone until `npm run cross-sign` runs again. Also holds `main-room.json`, `agent.json` and `bot.lock` |
| `sessions/` | `SESSION_DIR` | Every room's memory. The bot still runs, and answers as though it has never met anyone |
| `data/inbox`, `data/outbox` | `INBOX_DIR`, `OUTBOX_DIR` | Work in flight and text waiting to be posted. Inside `data/` deliberately — they are no longer a host interface, and a parked `.failed` is the audit trail that diagnosed the digest bug, so it belongs where the rest of the state is kept |
| the agent's workspace | `BOT_CWD` | Whatever the agent has been building |
| the crontab file | — | The agent's own schedule. A plain file, deliberately: see below. It lives in `data/` too |

`PI_AGENT_DIR` would default inside `DATA_DIR` on its own, but the image sets
it explicitly. Left implicit it arrives at `/data/pi` through a `||` in
`config/default.js` and a constructor that sets pi's own
`PI_CODING_AGENT_DIR` from it — two similarly named variables and four steps,
none of them visible in the Dockerfile. Got wrong, pi falls back to `~/.pi`,
which in a container is an unmounted path: provider credentials would disappear
on every restart. It also holds those credentials, which is worth knowing
before mounting `data/` somewhere convenient.

Two volumes, split by lifetime rather than by kind. `data/` is small, precious
and unregenerable; `sessions/` is large and churning, and losing it costs
memory rather than identity. Different backup policies, so different volumes.

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

**A job that needs the host is not this bot's job any more** — but which
jobs those are is less obvious than it looks, and worth measuring rather than
assuming. Compared on this host:

```
memory     host 4015676 kB  ==  container 4015676 kB   (/proc/meminfo is not namespaced)
disk /     host 62G         ==  container 62G          (overlay on the same disk)
processes  host 161         !=  container 4            (this one is namespaced)
```

So `free` and `df /` report the *host's* figures from inside a container, and
a memory report would be right. What is not available is anything namespaced
or absent: the process list is four entries, and there is no `docker`, no host
cron, no host filesystem. `hourly-stats.sh` began life running `docker ps`
stats, which simply cannot work in here.

That makes the failure mixed rather than clean — half the report correct, half
missing — which is worse than a job that plainly cannot run. Host monitoring
belongs to the host, by some route that is not the agent's sandbox, and the
tempting fix of mounting the inbox through puts a hole in the boundary for the
sake of one report.

That is the split: **by what a job needs to see**, and a job that needs to see
the host does not belong in here.

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

### Settled: two containers

`supercronic` is a separate process either way, so it runs in its own
container rather than beside the bot under a supervisor. They need nothing
from each other: a job's entire output is a file in `/data/inbox`, which is
the interface the spool already was. One process each, no init script holding
two services together, and a scheduler that dies does so visibly instead of
silently.

The cron container gets `/data` and the workspace, and deliberately **not** the
bot's `env_file` — the Matrix password and recovery key are no business of a
scheduler.

The concern about inotify turned out to be unfounded, which was worth checking
rather than assuming: the agent may rewrite the crontab atomically (temp file,
then rename), which normally leaves a file watch pointing at the old inode.
Both edit styles reload:

```
11:50:40  read crontab: /data/crontab     (append, in place)
11:50:44  read crontab: /data/crontab     (write temp, then mv)
```

`SIGUSR2` remains the manual fallback.

### Telling the agent, and letting it check

The agent cannot see any of this from its own container, and it does look.
Given the first version of the instruction — which said a job would be picked
up, without saying by what — it wrote the crontab correctly, then reported:

> There's a crontab entry in /data/crontab, but no cron daemon is running — so
> it's registered but won't execute.

It was wrong: the job ran on schedule, and failed on its own `awk` quoting.
But it had no way to know either, and checking and finding no daemon is better
behaviour than trusting an instruction. The fix is evidence rather than firmer
wording:

- a **heartbeat** line in the default crontab refreshes `/data/cron-alive`, so
  a recent timestamp proves the scheduler is alive and reading the file;
- jobs are told to end with `>> /data/cron.log 2>&1`, because supercronic's
  own output goes to a container the agent cannot reach. Without that, a job
  that runs and fails is indistinguishable from one that never ran.

The other caution stands: **cron hands jobs almost no environment** — no image
`ENV`, minimal `PATH`. A job that works when you run it by hand can still fail
under the scheduler, and the `%` incident is a reminder of how quietly a
crontab can be wrong.

## Logging a provider in

The container starts in `/workspace`, so an interactive pi trusts the agent's
own ground rather than the bot's source tree:

```sh
docker compose run --rm bot pi     # then /login <provider>
```

**`pi`, not `npx pi`.** `/workspace` has no `node_modules`, so npx falls
through to the registry and offers to install an unrelated public package
called `pi` — a stranger's code behind a `(y)` prompt. The image puts the
pinned binary on `PATH` instead, so `pi` always means the version this image
was built against.

The login lands in `/data/pi`, which is part of the data volume, so the sandbox
holds its own credentials rather than borrowing the host bot's.

That works only because the image sets **both** names. `PI_AGENT_DIR` is this
bot's variable; `PI_CODING_AGENT_DIR` is pi's own, and **the CLI reads only
pi's**. With just ours set, `/login` writes to `~/.pi/agent` inside the
container — an unmounted path — so it reports success, and the next run starts
with `No API key found for the selected model`. This is the same trap
[configuration](configuration.md) warns about on the host, and a container
makes it worse by discarding the evidence on exit. A provider key in the environment works too, and writes nothing to
disk.

## Cross-signing a container's device

From the image, with no checkout involved:

```sh
docker compose run --rm bot node /app/scripts/cross-sign.js
```

Everything it needs is already ambient in the container: `DATA_DIR=/data`, so
it finds this deployment's device in `/data/token.json`, and the credentials
come from the same `env_file` the bot uses. Nothing to pass, and nothing to
get wrong by passing the wrong deployment's.

This is why the image is built **without** `--omit=dev`. The single
devDependency is `matrix-js-sdk`, which cross-signing needs, and an image that
requires a git checkout to finish provisioning is not really a deployment —
particularly one pulled from a registry. It costs about 10MB.

The script is safe to run against a live container: it logs in as a *throwaway*
device, signs the target device id, and logs out. It never opens the bot's
crypto store, so none of the two-writers hazard applies.

Absolute path rather than `npm run cross-sign`, because the working directory
is `/workspace` and npm would look for `package.json` there. Node resolves a
script's imports from the script's own location, so the absolute path works
from anywhere.

The device id itself is the homeserver's, minted when the container first
logged in; `MATRIX_DEVICE_NAME` is only the label beside it in Element. Delete
`data/` and the next start gets a different device, and this has to be done
again — which is the whole reason `data/` is mounted.

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
  in it is as reachable from the container as it was from the host. Mounting
  the host's real workspace into the sandbox gives most of the boundary away,
  which is a decision worth making on purpose rather than for convenience.
- **The spools are still command channels**, wherever they live. Anything that
  can write the inbox can make the agent run a prompt; anything that can write
  the outbox can post to a room as the bot. Keeping them inside `data/` is what
  keeps that reach inside the sandbox.

---

[← README](../README.md)
