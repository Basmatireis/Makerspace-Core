# syntax=docker/dockerfile:1

# The dependency install and the Vite build run once on the build platform: the static output does
# not depend on the target architecture, so only the final nginx stage is per platform (and it only
# copies files).
FROM --platform=$BUILDPLATFORM node:24.21.0-alpine3.24 AS base

WORKDIR /workspace/frontend
RUN corepack enable

COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN --mount=type=cache,id=makerspace-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM base AS development

COPY frontend/ ./
EXPOSE 5173
CMD ["pnpm", "dev"]

FROM base AS build

COPY frontend/ ./
COPY api/ /workspace/api/
RUN pnpm generate:api && pnpm build

FROM nginxinc/nginx-unprivileged:1.31.6-alpine3.24 AS final

COPY frontend/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY frontend/nginx/security-headers.conf frontend/nginx/csp-app.conf frontend/nginx/csp-player.conf /etc/nginx/snippets/
COPY --from=build /workspace/frontend/dist/ /usr/share/nginx/html/
COPY LICENSE NOTICE /licenses/

EXPOSE 8080
