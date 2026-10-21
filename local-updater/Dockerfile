# syntax=docker/dockerfile:1

# The optional updater sidecar of the local-service bundles (see docs/hosting.md). Compiled on the build
# platform and cross-compiled for the target platform; tests run in CI before publishing.
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine3.24 AS dependencies

ENV CGO_ENABLED=0
WORKDIR /workspace/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download

FROM dependencies AS build

ARG VERSION=dev
ARG TARGETOS
ARG TARGETARCH
COPY backend/ ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X main.Version=${VERSION}" -o /out/local-updater ./cmd/local-updater

# Alpine's docker CLI and Compose plugin are about half the size of the official docker:cli image.
FROM alpine:3.24.2 AS final

RUN apk add --no-cache ca-certificates docker-cli docker-cli-compose

WORKDIR /app
COPY --from=build /out/local-updater /app/local-updater
COPY LICENSE NOTICE /app/

# Runs as root: it talks to the Docker socket and replaces the bundle's .env with its owner kept.
ENTRYPOINT ["/app/local-updater"]
