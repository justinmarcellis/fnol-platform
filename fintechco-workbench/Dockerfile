# FinTechCo Agentic Engineering Workbench: Next.js 15 + Python 3 + pytest + Claude Code CLI.
# Cloud Run serves on $PORT (8080). /tmp is an in-memory, writable filesystem.

FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pytest ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Claude Code CLI for Live mode. The app falls back to Safe Mode if this is missing.
RUN npm install -g @anthropic-ai/claude-code --no-audit --no-fund || true

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    DEMO_WORKSPACE=/tmp/demo-workspace \
    PYTHONDONTWRITEBYTECODE=1
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --chown=node:node seed-workspace ./seed-workspace
COPY --chown=node:node verified-patches ./verified-patches

USER node
EXPOSE 8080
CMD ["node", "server.js"]
