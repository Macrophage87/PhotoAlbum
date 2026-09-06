# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so they must be
# supplied as build args (docker-compose.yml passes them through from .env).
ARG NEXT_PUBLIC_TILE_URL=
ARG NEXT_PUBLIC_MAP_STYLE_URL=
ARG NEXT_PUBLIC_MAP_GLYPHS_URL=
ENV NEXT_PUBLIC_TILE_URL=$NEXT_PUBLIC_TILE_URL \
    NEXT_PUBLIC_MAP_STYLE_URL=$NEXT_PUBLIC_MAP_STYLE_URL \
    NEXT_PUBLIC_MAP_GLYPHS_URL=$NEXT_PUBLIC_MAP_GLYPHS_URL
# No database is contacted during the build (the Prisma client is created lazily), but a
# syntactically valid URL keeps environment validation happy while Next collects page data.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm build

FROM base AS runner
WORKDIR /app
# NEXT_MANUAL_SIG_HANDLE lets the app finish in-flight background jobs on SIGTERM before exiting.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 NEXT_MANUAL_SIG_HANDLE=1
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
# Prisma CLI (for `migrate deploy`) and tsx (for the seed and the standalone worker) come from the full node_modules.
COPY --from=deps /app/node_modules ./node_modules
# Sources, tsconfig (for the "@/" alias) and fixtures so `prisma/seed.ts` and `scripts/worker.ts` run inside the image.
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/tests/fixtures ./tests/fixtures
COPY --from=build /app/scripts ./scripts
RUN chmod +x ./scripts/entrypoint.sh && mkdir -p /data/photos && chown -R node:node /data /app
USER node
VOLUME ["/data/photos"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["./scripts/entrypoint.sh"]
