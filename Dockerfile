# Debian, not Alpine. The crypto binding ships as
# matrix-sdk-crypto.linux-x64-gnu.node and declares no musl variant, so a musl
# image builds cleanly, starts, joins rooms, and then dies on the first message
# with "Cannot find module '…-linux-x64-gnu'".
FROM node:24-bookworm-slim

# The agent's tools reach for these. pi's `grep` shells out to ripgrep, which
# has always been present on the host and so has never looked like a
# dependency; without it one tool errors while the bot appears healthy.
# ca-certificates is also what lets the bot reach a homeserver over TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./

# Install scripts stay off, with one deliberate exception: the crypto binding
# is *fetched* by its own postinstall (`node download-lib.js`), so a build that
# skips it produces an image that looks fine until the first message. Rebuild
# that package alone, then prove the binding actually loaded — failing here is
# far cheaper than failing in a room.
RUN npm ci --omit=dev --ignore-scripts \
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
ENV DATA_DIR=/data \
    PI_AGENT_DIR=/data/pi \
    SESSION_DIR=/sessions \
    INBOX_DIR=/data/inbox \
    OUTBOX_DIR=/data/outbox \
    BOT_CWD=/workspace
RUN mkdir -p /data/inbox /data/outbox /sessions /workspace \
  && chown -R node:node /data /sessions /workspace

# The app lives in /app; the agent lives in /workspace, and that is where a
# shell should start. `npx pi` run in here would otherwise land in /app and ask
# to trust the bot's own source tree. node-config resolves its directory from
# the working directory, so it has to be told where the app's is.
ENV NODE_CONFIG_DIR=/app/config
WORKDIR /workspace

# uid 1000, which matches the host account this is developed on, so a bind
# mount needs no ownership juggling.
USER node

CMD ["node", "/app/src/index.js"]
