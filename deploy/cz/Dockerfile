# Kantor Claude bersama (cz): daemon + tmux + Claude Code dalam satu container, tanpa akses ke host.
# Lihat deploy/cz/README.md.
FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git openssh-client lsof procps python3 make g++ ca-certificates curl jq ripgrep less postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/lsof /usr/sbin/lsof

# same version as the owner's Mac; the agents' user cannot upgrade it (installed as root)
ARG CLAUDE_VERSION=2.1.308
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION} && npm cache clean --force

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
