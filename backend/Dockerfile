FROM golang:1.26.5-alpine3.24 AS tools

ENV CGO_ENABLED=0
RUN go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.5.1 \
    && go install github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 \
    && go install github.com/pressly/goose/v3/cmd/goose@v3.28.0

FROM tools AS dependencies

WORKDIR /workspace/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download

FROM dependencies AS development

COPY backend/ ./
COPY api/ /workspace/api/
EXPOSE 8080
CMD ["go", "run", "./cmd/api"]

FROM dependencies AS build

COPY backend/ ./
COPY api/ /workspace/api/
RUN go test ./... \
    && go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api \
    && go build -trimpath -ldflags="-s -w" -o /out/admin ./cmd/admin

FROM alpine:3.24.1 AS final

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S makerspace \
    && adduser -S -G makerspace makerspace

WORKDIR /app
COPY --from=build /out/api /app/api
COPY --from=build /out/admin /app/admin
COPY --from=tools /go/bin/goose /usr/local/bin/goose
COPY backend/migrations/ /app/migrations/
COPY --chmod=0555 backend/production-entrypoint.sh /app/production-entrypoint
COPY LICENSE NOTICE /app/
COPY backend/internal/security/COMMON_PASSWORDS_LICENSE.md /app/THIRD_PARTY_NOTICES.txt

USER makerspace
EXPOSE 8080
ENTRYPOINT ["/app/api"]
