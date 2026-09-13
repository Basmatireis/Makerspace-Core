FROM node:24.21.0-alpine3.24 AS base

WORKDIR /workspace/frontend
RUN corepack enable

COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS development

COPY frontend/ ./
EXPOSE 5173
CMD ["pnpm", "dev"]

FROM base AS build

COPY frontend/ ./
COPY api/ /workspace/api/
RUN pnpm generate:api && pnpm build

FROM nginxinc/nginx-unprivileged:1.31.3-alpine3.24 AS final

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/frontend/dist/ /usr/share/nginx/html/
COPY LICENSE NOTICE /licenses/

EXPOSE 8080
