# syntax=docker/dockerfile:1

# Compiled on the build platform and cross-compiled for the target platform; tests run in CI before
# publishing, not in the image build.
FROM --platform=$BUILDPLATFORM golang:1.26.9-alpine3.24 AS dependencies

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
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnector.Version=${VERSION}" -o /out/printer-connector ./cmd/printer-connector

FROM alpine:3.24.1 AS final

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S connector \
    && adduser -S -G connector connector \
    && mkdir -p /var/lib/makerspace-printer-connector \
    && chown connector:connector /var/lib/makerspace-printer-connector \
    && chmod 0700 /var/lib/makerspace-printer-connector

WORKDIR /app
COPY --from=build /out/printer-connector /app/printer-connector
COPY LICENSE NOTICE /app/

USER connector
VOLUME ["/var/lib/makerspace-printer-connector"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=45s --retries=3 CMD ["/app/printer-connector", "healthcheck"]
ENTRYPOINT ["/app/printer-connector"]

