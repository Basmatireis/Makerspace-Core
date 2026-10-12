FROM golang:1.26.5-alpine3.24 AS dependencies

ENV CGO_ENABLED=0
WORKDIR /workspace/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download

FROM dependencies AS build

ARG VERSION=dev
COPY backend/ ./
RUN go test ./internal/printerconnector ./cmd/printer-connector \
    && go build -trimpath -ldflags="-s -w -X github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnector.Version=${VERSION}" -o /out/printer-connector ./cmd/printer-connector

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

