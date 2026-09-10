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

# Everything the bot must not lose lives outside the image. Created here so
# they exist and belong to the runtime user even when nothing is mounted over
# them; see docs/containerization.md for what each one is.
ENV DATA_DIR=/data \
    SESSION_DIR=/sessions \
    INBOX_DIR=/inbox \
    OUTBOX_DIR=/outbox \
    BOT_CWD=/workspace
RUN mkdir -p /data /sessions /inbox /outbox /workspace \
  && chown -R node:node /data /sessions /inbox /outbox /workspace

# uid 1000, which matches the host account this is developed on, so a bind
# mount needs no ownership juggling.
USER node

CMD ["node", "src/index.js"]
