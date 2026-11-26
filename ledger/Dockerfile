FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

# No npm dependencies. /data is the Fly volume; Fly mounts it owned by root,
# so fix ownership at start, then drop to the unprivileged "node" user
# (setpriv ships with util-linux, which is part of Debian's base system).
RUN mkdir -p /data

EXPOSE 8080
CMD ["sh", "-c", "chown -R node:node /data && exec setpriv --reuid=node --regid=node --init-groups node --disable-warning=ExperimentalWarning server.js"]
