# Debian, not Alpine. The crypto binding ships as
# matrix-sdk-crypto.linux-x64-gnu.node and declares no musl variant, so a musl
# image builds cleanly, starts, joins rooms, and then dies on the first message
# with "Cannot find module '…-linux-x64-gnu'".
FROM node:24-bookworm-slim

# What the agent reaches for, chosen from what it has actually run rather than
# from taste. Counting bash tool calls across this deployment's session
# history: curl 2162, jq 1223, python3 1044 — the three most-used commands by
# a wide margin, and all three absent from a slim image. procps is `free`,
# `ps` and `top`, which it uses to answer questions about the machine.
#
# pi's own `grep` tool shells out to ripgrep, which every host has had and so
# never looked like a dependency; without it one tool errors while the bot
# appears healthy. ca-certificates is also what lets it reach a homeserver
# over TLS.
#
# Deliberately absent: `at` and `cron`. Both accept work and silently never
# run it unless their daemon is running, which is the failure mode this
# project has spent two releases removing. Scheduling is a decision of its
# own — see docs/containerization.md.
#
# wget and bsdextrautils (`column`) are the exceptions to the counting: zero
# and one use respectively. They are here because a container is a sandbox
# rather than a host — a tool the agent reaches for and does not find costs it
# a turn, and the blast radius inside a boundary already drawn is nil. That
# reasoning is about the sandbox, not the tools, and does not extend to the
# host deployment, which has the whole machine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash bsdextrautils ca-certificates curl git jq procps python3 ripgrep wget \
  && rm -rf /var/lib/apt/lists/*

# supercronic: cron built for containers — one foreground process, jobs logged
# to stdout, no root, and -inotify to reload the crontab when it changes. The
# schedule is a file the agent can edit with the tools it already has, which
# suits it better than driving `crontab -e` ever did.
#
# Pinned by digest, and verified: a53ae23… was computed from the download
# rather than copied from the release page. amd64 only — on another
# architecture this fails loudly at exec with "exec format error", which is
# the right way to find out.
ARG SUPERCRONIC_VERSION=v0.2.49
ARG SUPERCRONIC_SHA256=a53ae236602c7338aba3fbaff40bda6300eae3b9fedb8261eb06cfe3724430c1
RUN curl -fsSLO "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
  && echo "${SUPERCRONIC_SHA256}  supercronic-linux-amd64" | sha256sum -c - \
  && chmod +x supercronic-linux-amd64 \
  && mv supercronic-linux-amd64 /usr/local/bin/supercronic \
  && supercronic -version

WORKDIR /app

COPY package.json package-lock.json ./

# Install scripts stay off, with one deliberate exception: the crypto binding
# is *fetched* by its own postinstall (`node download-lib.js`), so a build that
# skips it produces an image that looks fine until the first message. Rebuild
# that package alone, then prove the binding actually loaded — failing here is
# far cheaper than failing in a room.
# Not --omit=dev. The single devDependency is matrix-js-sdk, which
# cross-signing needs, and an image published to a registry has to be able to
# provision itself — needing a git checkout to finish setting up a container
# is not a deployment. It costs ~14MB against a 188MB image.
RUN npm ci --ignore-scripts \
  && npm rebuild @matrix-org/matrix-sdk-crypto-nodejs \
  && node -e "require('@matrix-org/matrix-sdk-crypto-nodejs'); console.log('crypto binding OK')"

COPY . .

# Two volumes, by lifetime rather than by kind. Created here so they exist and
# belong to the runtime user even when nothing is mounted over them.
# See docs/containerization.md.
#
# /data is everything the bot cannot lose and cannot regenerate: the device
# identity, the provider credentials, and — because the container is the
# sandbox — the spools too. They were a host interface when cron lived outside;
# inside, they are the bot's own plumbing, and putting them here means one
# thing to persist and one place the parked `.failed` files can be read from.
#
# /sessions is kept apart on purpose: it is large and churning where /data is
# small and precious, and losing it costs memory rather than identity. That is
# a different backup policy, so it gets a different volume.
#
# PI_AGENT_DIR is spelled out rather than left to default. It already resolves
# to ${DATA_DIR}/pi through a `||` in config/default.js, and the bot then sets
# pi's own PI_CODING_AGENT_DIR from it — four steps and two confusable names to
# arrive somewhere this file never mentions. Wrong, pi falls back to ~/.pi,
# which here is an unmounted path: the provider credentials would vanish on
# restart and the bot would ask to be logged in again.
# Both names, deliberately. PI_AGENT_DIR is this bot's; PI_CODING_AGENT_DIR is
# pi's own, and the pi CLI reads only the latter. Set just ours and an
# interactive `pi /login` writes to ~/.pi/agent inside the container — an
# unmounted path — so the login looks like it worked and is gone on the next
# run. The bot sets pi's variable at runtime anyway; this makes the CLI agree.
ENV DATA_DIR=/data \
    PI_AGENT_DIR=/data/pi \
    PI_CODING_AGENT_DIR=/data/pi \
    SESSION_DIR=/sessions \
    INBOX_DIR=/data/inbox \
    OUTBOX_DIR=/data/outbox \
    BOT_CWD=/workspace \
    CRONTAB_FILE=/data/crontab \
    AGENT_SANDBOX=container
RUN mkdir -p /data/inbox /data/outbox /sessions /workspace \
  && chown -R node:node /data /sessions /workspace

# The app lives in /app; the agent lives in /workspace, and that is where a
# shell should start. `npx pi` run in here would otherwise land in /app and ask
# to trust the bot's own source tree. node-config resolves its directory from
# the working directory, so it has to be told where the app's is.
ENV NODE_CONFIG_DIR=/app/config

# The pinned pi on PATH, so `pi` works from the workspace and always means the
# version this image was built against. Without it, `npx pi` from a directory
# with no node_modules goes to the registry and offers to install an unrelated
# public package called `pi` — a stranger's code, one keystroke away.
ENV PATH=/app/node_modules/.bin:$PATH

WORKDIR /workspace

# uid 1000, which matches the host account this is developed on, so a bind
# mount needs no ownership juggling.
USER node

CMD ["node", "/app/src/index.js"]
