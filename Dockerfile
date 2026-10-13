FROM eclipse-temurin:25-jre-jammy AS java-runtime

FROM node:22-bookworm-slim AS client-build

WORKDIR /build
COPY package*.json ./
RUN npm install --ignore-scripts
COPY tsconfig.client.json vite.config.ts ./
COPY src/client ./src/client
RUN npm run typecheck:client && npm run build:client

FROM node:22-bookworm-slim

ARG SIGNAL_CLI_VERSION=0.14.7
ARG SIGNAL_CLI_SHA256=0e1eefdf4a2109edf7c899c9d1667167c54ac12c3ec824f27db7c1dac4fa7506
ARG WACLI_VERSION=0.17.1
ARG WACLI_LINUX_AMD64_SHA256=cbd5e74d5b805550cc36c7479aca552970cc1b314c5c08e02367e08b785714fd
ARG WACLI_LINUX_ARM64_SHA256=8e5d21f8d5f097e5d3a883cdb42848a9e50a7383e4de049c807cc44e6e7c81b6

COPY --from=java-runtime /opt/java/openjdk /opt/java/openjdk

ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gosu sqlite3 \
    && curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" -o /tmp/signal-cli.tar.gz \
    && echo "${SIGNAL_CLI_SHA256}  /tmp/signal-cli.tar.gz" | sha256sum -c - \
    && mkdir -p /opt/signal-cli \
    && tar -xzf /tmp/signal-cli.tar.gz -C /opt/signal-cli --strip-components=1 \
    && printf '%s\\n' '#!/bin/sh' 'exec /opt/signal-cli/bin/signal-cli "$@"' > /usr/local/bin/signal-cli \
    && chmod 0755 /usr/local/bin/signal-cli \
    && architecture="$(dpkg --print-architecture)" \
    && case "$architecture" in \
         amd64) wacli_arch="amd64"; wacli_sha256="$WACLI_LINUX_AMD64_SHA256" ;; \
         arm64) wacli_arch="arm64"; wacli_sha256="$WACLI_LINUX_ARM64_SHA256" ;; \
         *) echo "Unsupported wacli architecture: $architecture" >&2; exit 1 ;; \
       esac \
    && wacli_archive="wacli_${WACLI_VERSION}_linux_${wacli_arch}.tar.gz" \
    && curl -fsSL "https://github.com/openclaw/wacli/releases/download/v${WACLI_VERSION}/${wacli_archive}" -o "/tmp/${wacli_archive}" \
    && echo "${wacli_sha256}  /tmp/${wacli_archive}" | sha256sum -c - \
    && mkdir -p /tmp/wacli-release \
    && tar -xzf "/tmp/${wacli_archive}" -C /tmp/wacli-release \
    && wacli_binary="$(find /tmp/wacli-release -type f -name wacli -print -quit)" \
    && test -n "$wacli_binary" \
    && install -m 0755 "$wacli_binary" /usr/local/bin/wacli \
    && rm -f /tmp/signal-cli.tar.gz \
    && rm -f "/tmp/${wacli_archive}" \
    && rm -rf /tmp/wacli-release \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.mjs ./
COPY push-service.mjs ./
COPY telegram-service.mjs ./
COPY whatsapp-service.mjs ./
COPY signal-cli-updater.mjs ./
COPY --from=client-build /build/public-next ./public
COPY docker-entrypoint.sh /usr/local/bin/cloudphone-signal-entrypoint

RUN mkdir -p /data/signal-cli /data/app /data/telegram /data/whatsapp \
    && chown -R node:node /data /app \
    && chmod 0755 /usr/local/bin/cloudphone-signal-entrypoint

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["cloudphone-signal-entrypoint"]
CMD ["node", "server.mjs"]
