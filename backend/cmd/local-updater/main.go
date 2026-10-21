// Command local-updater runs the optional updater sidecar of a local-service Compose bundle (package
// localupdater). It is the only container of the bundle with the Docker socket.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/localupdater"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/logging"
)

// Version is the release, set at link time.
var Version = "dev"

// deployMount is where compose.yaml mounts the bundle directory.
const deployMount = "/deploy"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "local-updater:", err)
		os.Exit(1)
	}
}

func run() error {
	logger := logging.New(os.Stdout, "production")
	slog.SetDefault(logger)
	components := []localupdater.Component{}
	for _, value := range list(os.Getenv("UPDATER_COMPONENTS")) {
		components = append(components, localupdater.Component(value))
	}
	services := list(os.Getenv("UPDATER_SERVICES"))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	runner := localupdater.DockerRunner{}
	// The Docker engine may not answer right after a host reboot; keep trying instead of exiting.
	var projectDir string
	for {
		var err error
		projectDir, err = localupdater.ProjectDirectory(ctx, runner, os.Getenv("HOSTNAME"), deployMount)
		if err == nil {
			break
		}
		logger.Error("bundle directory not found; updates are unavailable until it is", "error", err.Error())
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Minute):
		}
	}
	updater, err := localupdater.New(
		localupdater.Config{
			ExchangeRoot: localupdater.DefaultExchangeRoot,
			Components:   components,
			Services:     services,
			ProjectDir:   projectDir,
			Version:      Version,
		},
		runner,
		logger,
	)
	if err != nil {
		return err
	}
	if err = updater.Prepare(); err != nil {
		return err
	}
	logger.Info("watching for update requests", "project", projectDir, "services", strings.Join(services, ","))
	ticker := time.NewTicker(localupdater.PollInterval)
	defer ticker.Stop()
	for {
		updater.Poll(ctx)
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.Canceled) {
				return nil
			}
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// list splits a comma- or space-separated environment value.
func list(value string) []string {
	return strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == ' ' })
}
