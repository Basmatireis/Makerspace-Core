package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/logging"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnector"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "printer-connector:", err)
		os.Exit(1)
	}
}

func run() error {
	dataDir := env("CONNECTOR_DATA_DIR", "/var/lib/makerspace-printer-connector")
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		return printerconnector.CheckHealth(dataDir)
	}
	if handled, err := runOfflineCommand(os.Args[1:], os.Stdout); handled {
		return err
	}
	logger := logging.New(os.Stdout, env("APP_ENV", "production"))
	slog.SetDefault(logger)
	client, err := printerconnector.NewClient(os.Getenv("CORE_URL"), strings.EqualFold(os.Getenv("CONNECTOR_ALLOW_HTTP"), "true"))
	if err != nil {
		return err
	}
	store, err := printerconnector.OpenStore(dataDir)
	if err != nil {
		return err
	}
	defer store.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	runtime := printerconnector.NewRuntime(store, client, dataDir, os.Getenv("CONNECTOR_ENROLLMENT_SECRET_FILE"), logger)
	return runtime.Run(ctx)
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
