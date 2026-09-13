package telemetry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// Init enables batched OTLP-over-HTTP trace export only when an endpoint is
// configured. An absent endpoint (the normal development default) is a true
// no-op and never prevents the application from starting.
func Init(ctx context.Context, logger *slog.Logger) (shutdown func(context.Context) error, enabled bool, err error) {
	disabled, parseErr := strconv.ParseBool(envOr("OTEL_SDK_DISABLED", "false"))
	if parseErr != nil {
		return nil, false, errors.New("OTEL_SDK_DISABLED must be a boolean")
	}
	if disabled || strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")) == "" {
		return func(context.Context) error { return nil }, false, nil
	}

	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, false, err
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(resource.Default()),
	)
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		logger.Error("telemetry export failed", "error_type", typeName(err))
	}))
	return provider.Shutdown, true, nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func typeName(value any) string {
	return fmt.Sprintf("%T", value)
}
