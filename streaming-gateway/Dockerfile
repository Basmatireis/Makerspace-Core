# syntax=docker/dockerfile:1

# Compiled on the build platform and cross-compiled for the target platform; tests run in CI before
# publishing, not in the image build.
FROM --platform=$BUILDPLATFORM golang:1.27.2-alpine3.24 AS dependencies

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
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X github.com/Basmatireis/Makerspace-Core/backend/internal/streaminggateway.Version=${VERSION}" -o /out/streaming-gateway ./cmd/streaming-gateway

FROM alpine:3.24.1 AS final

# The numeric ids are fixed because the go2rtc container reads the configuration file this process
# writes into the shared volume and has to run as the same user (see local-services/compose.yaml).
RUN apk add --no-cache ca-certificates \
    && addgroup -S -g 10001 gateway \
    && adduser -S -u 10001 -G gateway gateway \
    && mkdir -p /var/lib/makerspace-streaming-gateway /go2rtc-config \
    && chown gateway:gateway /var/lib/makerspace-streaming-gateway /go2rtc-config \
    && chmod 0700 /var/lib/makerspace-streaming-gateway /go2rtc-config

WORKDIR /app
COPY --from=build /out/streaming-gateway /app/streaming-gateway
COPY LICENSE NOTICE /app/

USER 10001:10001
VOLUME ["/var/lib/makerspace-streaming-gateway", "/go2rtc-config"]
EXPOSE 8443
HEALTHCHECK --interval=30s --timeout=3s --start-period=45s --retries=3 CMD ["/app/streaming-gateway", "healthcheck"]
ENTRYPOINT ["/app/streaming-gateway"]
