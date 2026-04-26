FROM debian:trixie-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    BUN_INSTALL=/usr/local \
    PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg \
        git tar unzip rsync \
        sqlite3 tini \
    && rm -rf /var/lib/apt/lists/*

RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
       | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && . /etc/os-release \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash \
    && rm -rf /var/lib/apt/lists/*

ARG RAILPACK_VERSION=0.23.0
RUN env RAILPACK_VERSION="${RAILPACK_VERSION}" \
        bash -c "curl -fsSL https://railpack.com/install.sh | bash -s -- --bin-dir /usr/local/bin --yes" \
    && railpack --version

ARG BUN_VERSION=1.3.11
RUN env BUN_INSTALL=/usr/local SHELL=/bin/bash \
        bash -c "curl -fsSL https://bun.sh/install | bash -s -- 'bun-v${BUN_VERSION}'" \
    && bun --version

RUN set -eux \
    && mkdir -p /tmp/prewarm-node /tmp/prewarm-python /tmp/prewarm-go \
    && printf '{"name":"prewarm","engines":{"node":">=18"}}\n' \
        > /tmp/prewarm-node/package.json \
    && printf 'flask\n' > /tmp/prewarm-python/requirements.txt \
    && printf 'module prewarm\n\ngo 1.22\n' > /tmp/prewarm-go/go.mod \
    && for d in /tmp/prewarm-node /tmp/prewarm-python /tmp/prewarm-go; do \
         railpack info "$d" --format json > /dev/null 2>&1 || true; \
       done \
    && rm -rf /tmp/prewarm-node /tmp/prewarm-python /tmp/prewarm-go

WORKDIR /workspace

FROM base AS deps

COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY tooling/package.json ./tooling/
COPY packages/typescript-config/package.json ./packages/typescript-config/

RUN bun install --frozen-lockfile

FROM deps AS final

COPY . .

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "apps/api/src/bin.ts"]
