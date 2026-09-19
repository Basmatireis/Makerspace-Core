# Observability

Observability must remain useful without becoming a second store of personal data. The application always works with no external collector; `OTEL_SDK_DISABLED=true` is the local default.

## Structured application logs

The API emits JSON records to standard output. Request records contain the timestamp, level, message, request ID, HTTP method, generated OpenAPI operation name or normalized route, client IP, bounded User-Agent, status, response-byte count, and duration. Process lifecycle records include the configured environment where relevant.

Matched requests use generated operation names, with normalized route templates such as `/api/v1/people/{personId}` as a fallback for requests rejected before the generated handler runs. They never log a raw matched URL containing identifiers. Genuinely unmatched requests additionally include `path`, limited to 1,024 UTF-8 bytes; this value comes only from `URL.Path`, so query strings are excluded. The `user_agent` field is limited to 512 UTF-8 bytes. Do not log request or response bodies, query searches, contact details, matriculation numbers, passwords/hashes, Authorization headers, cookies, session/reset/CSRF tokens, database URLs, arbitrary request headers, or arbitrary error objects. Expected client/auth failures are concise; internal errors retain safe diagnostic context without being returned to the client.

The `client_ip` field uses the TCP peer by default. `X-Forwarded-For` is considered only when that peer belongs to a CIDR configured in `HTTP_TRUSTED_PROXIES`; `Forwarded` and `X-Real-IP` are not used. Configure trusted proxies as a comma-separated IPv4/IPv6 CIDR list:

```env
HTTP_TRUSTED_PROXIES=10.20.0.0/24,2001:db8:1234::/48
```

The backend walks `X-Forwarded-For` from right to left, discards configured trusted proxy hops, and records the first untrusted address. A missing or malformed chain falls back to the TCP peer. Every proxy whose hop should be discarded must append the address that connected to it, and its network must be configured explicitly. Never add a broad client-accessible network merely because it also contains a proxy: any peer in a trusted CIDR is authorized to supply forwarding information. When no trusted proxies are configured, all forwarding headers are ignored. Docker or ingress networks are deliberately not trusted by default.

HTTP middleware generates a fresh UUIDv7 request ID, returns it in `X-Request-ID`, and passes it to audit writes. Client-supplied request IDs are not trusted or reused. Audit events and operational logs serve different purposes: logs are diagnostic and disposable; audit events are transactionally coupled records of important actions.

The repository deliberately sets no application-log retention period because log storage is deployment-owned. IP addresses are personal data, so access to request logs and their retention must be intentionally limited to the shortest period needed for diagnosis. Before production, configure and record rotation/deletion separately from `AUDIT_RETENTION`; follow the approval checklist in [operations](operations.md#cleanup-and-retention).

## Request traces

The implemented OpenTelemetry surface is intentionally limited to HTTP request traces. Spans use only low-cardinality or opaque correlation attributes:

- HTTP method;
- generated OpenAPI operation name rather than a raw URL;
- response status code;
- request ID.

There is no metrics or log exporter in this repository. Person, Account, session, email, IP address, query string, request body, and database statement values are not attached to spans.

Instrumentation/export failures must not fail product requests. OTLP export uses bounded queues/timeouts and may drop telemetry during collector outages.

## Optional OTLP export

Enable export only when a trusted collector is available:

```env
OTEL_SDK_DISABLED=false
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.internal:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=makerspace-core-api
```

Only OTLP/HTTP protobuf trace export is implemented. Configure the base collector endpoint; the trace exporter appends `/v1/traces`. If `OTEL_SDK_DISABLED=true` or the endpoint is absent, initialization is a no-op. See the [OpenTelemetry OTLP exporter configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/).

Grafana Alloy can later receive the application's OTLP traffic without adding Alloy to this repository. A site-owned Alloy configuration can start with an OTLP receiver and forward traces through a batch processor to that site's chosen OTLP destination:

```alloy
otelcol.receiver.otlp "makerspace" {
  http {
    endpoint = "0.0.0.0:4318"
  }

  output {
    traces  = [otelcol.processor.batch.makerspace.input]
  }
}

otelcol.processor.batch "makerspace" {
  output {
    traces  = [otelcol.exporter.otlphttp.site.input]
  }
}

otelcol.exporter.otlphttp "site" {
  client {
    endpoint = sys.env("UPSTREAM_OTLP_ENDPOINT")
  }
}
```

This follows Alloy's documented [`otelcol.receiver.otlp`](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.receiver.otlp/) pipeline shape. Binding, authentication, TLS, retention, and the upstream backend remain deployment responsibilities. This repository intentionally does not deploy Alloy, Grafana, Loki, Tempo, or Prometheus.
