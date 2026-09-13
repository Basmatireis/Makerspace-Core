# Observability

Observability must remain useful without becoming a second store of personal data. The application always works with no external collector; `OTEL_SDK_DISABLED=true` is the local default.

## Structured application logs

The API emits JSON records to standard output. Request records contain the timestamp, level, message, request ID, HTTP method, generated OpenAPI operation name, status, response-byte count, and duration. Process lifecycle records include the configured environment where relevant.

Use generated operation names (or route templates such as `/api/v1/people/{personId}` in future instrumentation), never raw URLs containing identifiers. Do not log request or response bodies, query searches, contact details, matriculation numbers, passwords/hashes, Authorization headers, cookies, session/reset/CSRF tokens, database URLs, or arbitrary error objects. Expected client/auth failures are concise; internal errors retain safe diagnostic context without being returned to the client.

HTTP middleware generates a fresh UUIDv7 request ID, returns it in `X-Request-ID`, and passes it to audit writes. Client-supplied request IDs are not trusted or reused. Audit events and operational logs serve different purposes: logs are diagnostic and disposable; audit events are transactionally coupled records of important actions.

The repository deliberately sets no application-log retention period because log storage is deployment-owned. Before production, configure and record rotation/deletion separately from `AUDIT_RETENTION`; follow the approval checklist in [operations](operations.md#cleanup-and-retention).

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
