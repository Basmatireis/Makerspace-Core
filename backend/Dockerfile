# syntax=docker/dockerfile:1

# Go is always compiled on the build platform and cross-compiled for the target platform, so a
# multi-platform build never runs the Go toolchain under emulation. Tests are not run here: CI
# validates the exact commit before any image is published (see docs/ci-cd.md).

FROM --platform=$BUILDPLATFORM golang:1.26.5-alpine3.24 AS goose

ARG TARGETOS
ARG TARGETARCH
ENV CGO_ENABLED=0
# `go install` writes cross-compiled binaries to /go/bin/<os>_<arch>/, hence the search.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOOS=$TARGETOS GOARCH=$TARGETARCH go install github.com/pressly/goose/v3/cmd/goose@v3.28.0 \
    && mkdir -p /out \
    && cp "$(find /go/bin -type f -name goose)" /out/goose

# Code generators and goose for the development container. Never part of the final image.
FROM golang:1.26.5-alpine3.24 AS tools

ENV CGO_ENABLED=0
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.5.1 \
    && go install github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1
COPY --from=goose /out/goose /go/bin/goose

FROM tools AS development

WORKDIR /workspace/backend
COPY backend/go.mod backend/go.sum ./
# Not a cache mount: the downloaded modules stay in the image layer and seed the dev module volume.
RUN go mod download
COPY backend/ ./
COPY api/ /workspace/api/
EXPOSE 8080
CMD ["go", "run", "./cmd/api"]

FROM --platform=$BUILDPLATFORM golang:1.26.5-alpine3.24 AS dependencies

ENV CGO_ENABLED=0
WORKDIR /workspace/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download

FROM dependencies AS build

ARG TARGETOS
ARG TARGETARCH
COPY backend/ ./
COPY api/ /workspace/api/
RUN --mount=type=cache,target=/root/.cache/go-build \
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api \
    && GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/admin ./cmd/admin

FROM alpine:3.24.1 AS final

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S makerspace \
    && adduser -S -G makerspace makerspace \
    && mkdir -p /var/lib/makerspace/files \
    && chown makerspace:makerspace /var/lib/makerspace/files \
    && chmod 0700 /var/lib/makerspace/files

WORKDIR /app
COPY --from=build /out/api /app/api
COPY --from=build /out/admin /app/admin
COPY --from=goose /out/goose /usr/local/bin/goose
COPY backend/migrations/ /app/migrations/
COPY --chmod=0555 backend/production-entrypoint.sh /app/production-entrypoint
COPY LICENSE NOTICE /app/
COPY backend/internal/security/COMMON_PASSWORDS_LICENSE.md /app/THIRD_PARTY_NOTICES.txt

USER makerspace
EXPOSE 8080
ENTRYPOINT ["/app/api"]
