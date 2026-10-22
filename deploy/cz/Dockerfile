# Kantor Claude bersama (cz): daemon + tmux + Claude Code dalam satu container, tanpa akses ke host.
# Lihat deploy/cz/README.md.
FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      zsh tmux git openssh-client lsof procps python3 make g++ ca-certificates curl jq ripgrep less \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/lsof /usr/sbin/lsof

# EnviOps tooling: weasyprint (npm run buku), poppler (look at generated PDFs), fonts for Indonesian PDFs,
# and psql/pg_dump 18 to match the dev database (Debian ships 15)
RUN install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends \
      weasyprint poppler-utils zip unzip sqlite3 fonts-noto-core fonts-liberation postgresql-client-18 \
    && apt-get purge -y postgresql-client-15 || true \
    && rm -rf /var/lib/apt/lists/*

# same version as the owner's Mac; the agents' user cannot upgrade it (installed as root)
ARG CLAUDE_VERSION=2.1.308
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION} && npm cache clean --force

# Playwright Chromium for e2e tests and screenshots; must match the project's @playwright/test (EnviOps: 1.62.1)
ARG PLAYWRIGHT_VERSION=1.62.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
    && apt-get install -y --no-install-recommends fonts-noto-color-emoji \
    && chmod -R a+rX /ms-playwright && rm -rf /var/lib/apt/lists/* /root/.npm

# a uid that is nobody on the host, so the bind mounts belong to no real host user
RUN groupadd -g 10501 kantor && useradd -m -u 10501 -g 10501 -s /bin/bash kantor

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN chmod +x deploy/cz/entrypoint.sh

USER kantor
ENV HOME=/home/kantor TERM=xterm-256color LANG=C.UTF-8 LC_ALL=C.UTF-8
EXPOSE 4317
ENTRYPOINT ["/app/deploy/cz/entrypoint.sh"]
