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
