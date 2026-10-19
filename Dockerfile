# FNOL platform image for Cloud Run. Zero-dependency core; optional AI SDKs are
# installed from package-lock.json when present.
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8080 \
    FNOL_DB_PATH=/data/fnol.db

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund || npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts
COPY tenants ./tenants
# Synthetic generator used by scripts/seed.mjs and scripts/demo-data.mjs.
COPY tests/synthetic ./tests/synthetic

# /data holds the SQLite file (ephemeral on Cloud Run, see docs/deployment.md);
# /app/.secrets receives master.key from a Secret Manager volume mount.
RUN mkdir -p /data /app/.secrets && chown -R node:node /app /data
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# PoC start: seed + demo data on a new (ephemeral) database, then serve on 0.0.0.0.
# devMode follows NODE_ENV; the fnol-poc deploy sets NODE_ENV=development.
ENV HOST=0.0.0.0
CMD ["node", "--disable-warning=ExperimentalWarning", "scripts/dev.mjs"]
