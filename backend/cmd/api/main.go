package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/logging"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/telemetry"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "api:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	if err := cfg.ValidateDatabase(); err != nil {
		return err
	}
	logger := logging.New(os.Stdout, cfg.Environment)
	slog.SetDefault(logger)

	rootContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownTelemetry, telemetryEnabled, err := telemetry.Init(rootContext, logger)
	if err != nil {
		return fmt.Errorf("initialize telemetry: %w", err)
	}
	if telemetryEnabled {
		logger.Info("OpenTelemetry export enabled")
	}
	defer func() {
		shutdownContext, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		if err := shutdownTelemetry(shutdownContext); err != nil {
			logger.Error("telemetry shutdown failed", "error_type", fmt.Sprintf("%T", err))
		}
	}()

	pool, err := database.Open(rootContext, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	application, err := httpapi.NewApplication(pool, cfg, logger)
	if err != nil {
		return fmt.Errorf("initialize HTTP API: %w", err)
	}
	// Websockets are hijacked connections: their deadlines are managed by the camera relay, not by the
	// read and write timeouts below, and Shutdown does not track them, so it ends them explicitly.
	defer application.CloseConnections()
	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           application.Handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
		BaseContext: func(_ net.Listener) context.Context {
			return rootContext
		},
	}

	server.RegisterOnShutdown(application.CloseConnections)

	backgroundDone := make(chan struct{})
	go func() {
		defer close(backgroundDone)
		application.RunBackground(rootContext)
	}()

	serveError := make(chan error, 1)
	go func() {
		logger.Info("API listening", "address", cfg.HTTPAddr, "environment", cfg.Environment)
		serveError <- server.ListenAndServe()
	}()

	select {
	case err := <-serveError:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve HTTP: %w", err)
		}
		return nil
	case <-rootContext.Done():
	}

	shutdownContext, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownContext); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	if err := application.WaitConnections(shutdownContext); err != nil {
		logger.Warn("camera relay connections did not end before the shutdown timeout")
	}
	select {
	case <-backgroundDone:
	case <-shutdownContext.Done():
	}
	logger.Info("API stopped")
	return nil
}
