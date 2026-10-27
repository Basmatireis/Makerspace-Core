# syntax=docker/dockerfile:1

# The dependency install and the Vite build run once on the build platform: the static output does
# not depend on the target architecture, so only the final nginx stage is per platform (and it only
# copies files).
FROM --platform=$BUILDPLATFORM node:26.12.1-alpine3.24 AS base

WORKDIR /workspace/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml frontend/.pnpmfile.cjs ./
# Node 25+ no longer bundles corepack; install the pnpm version pinned in package.json directly.
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")"
# The frozen install below is the only install. Without this, pnpm compares the files copied in later stages
# (newer timestamps, e.g. .pnpmfile.cjs) with this layer before `pnpm run` and tries to reinstall.
ENV pnpm_config_verify_deps_before_run=false
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

FROM nginxinc/nginx-unprivileged:1.31.7-alpine3.24 AS final

COPY frontend/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY frontend/nginx/security-headers.conf frontend/nginx/csp-app.conf frontend/nginx/csp-player.conf /etc/nginx/snippets/
COPY --from=build /workspace/frontend/dist/ /usr/share/nginx/html/
COPY LICENSE NOTICE /licenses/

EXPOSE 8080
