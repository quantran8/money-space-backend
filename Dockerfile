# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Base — Node 22 LTS on Alpine. Prisma needs OpenSSL 3 on musl
# (binaryTargets linux-musl-openssl-3.0.x, resolved automatically by
# `prisma generate` when it runs inside this image).
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
RUN apk add --no-cache openssl
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — full install (dev deps included) for the build stage.
# `postinstall` runs `prisma generate`, so prisma/ must be present first.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — compile Nest to dist/
# ---------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

# ---------------------------------------------------------------------------
# prod-deps — production-only tree with a freshly generated Prisma client.
#
# Two pnpm-specific details drive this stage:
#
# 1. `prisma` (the CLI invoked by `postinstall`) is a DEV dependency, so a plain
#    `--prod` install cannot run it → install with --ignore-scripts, then fetch
#    the CLI on its own via `pnpm dlx` pinned to the same version as the
#    devDependency, and generate explicitly.
# 2. The generated client cannot simply be copied from the `deps` stage: under
#    pnpm, `@prisma/client` resolves inside `node_modules/.pnpm/@prisma+client@
#    <version>_<peer-hash>/`, and that peer hash differs between a full and a
#    --prod tree. Generating in-place writes the client to whichever path this
#    tree actually resolves, so it is correct by construction.
# ---------------------------------------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm dlx prisma@6.19.3 generate

# ---------------------------------------------------------------------------
# runner — final image
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Shipped so `prisma migrate deploy` can be run against this image if wanted.
COPY prisma ./prisma

# Build identity, read at runtime by src/version.ts.
# Last stage and after every COPY on purpose: an ARG changes every build and
# invalidates every layer below it — higher up it would defeat the layer cache.
# See memory/infrastructure/deployment.md.
ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
ARG APP_BUILT_AT
ENV APP_VERSION=$APP_VERSION
ENV APP_COMMIT=$APP_COMMIT
ENV APP_BUILT_AT=$APP_BUILT_AT

# Standard OCI annotation keys, so `docker inspect` identifies the image
# without starting a container.
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$APP_COMMIT \
      org.opencontainers.image.created=$APP_BUILT_AT \
      org.opencontainers.image.title=money-space-backend

USER node
EXPOSE 3000

# main.ts reads process.env.PORT (default 3000).
CMD ["node", "dist/main"]
