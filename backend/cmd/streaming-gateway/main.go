// Command streaming-gateway restreams printer cameras to digital signage players. See
// docs/streaming-gateway.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/logging"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/streaminggateway"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "streaming-gateway:", err)
		os.Exit(1)
	}
}

func run() error {
	dataDir := env("STREAM_DATA_DIR", "/var/lib/makerspace-streaming-gateway")
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		return streaminggateway.CheckHealth(dataDir)
	}
	logger := logging.New(os.Stdout, env("APP_ENV", "production"))
	slog.SetDefault(logger)

	coreURL := os.Getenv("CORE_URL")
	client, err := streaminggateway.NewClient(coreURL, strings.EqualFold(os.Getenv("STREAM_ALLOW_HTTP"), "true"))
	if err != nil {
		return err
	}
	parsed, err := url.Parse(strings.TrimRight(coreURL, "/"))
	if err != nil {
		return err
	}
	g2r, err := streaminggateway.NewGo2RTCClient(env("GO2RTC_API_URL", "http://go2rtc:1984"))
	if err != nil {
		return err
	}
	store, err := streaminggateway.OpenStore(dataDir)
	if err != nil {
		return err
	}
	defer store.Close()

	render := streaminggateway.DefaultRenderOptions()
	render.APIListen = env("GO2RTC_API_LISTEN", render.APIListen)
	render.WebRTCListen = env("GO2RTC_WEBRTC_LISTEN", render.WebRTCListen)
	render.LogLevel = env("GO2RTC_LOG_LEVEL", render.LogLevel)
	for _, candidate := range strings.Split(os.Getenv("STREAM_WEBRTC_CANDIDATES"), ",") {
		if candidate = strings.TrimSpace(candidate); candidate != "" {
			render.WebRTCCandidates = append(render.WebRTCCandidates, candidate)
		}
	}
	if len(render.WebRTCCandidates) == 0 {
		return errors.New("STREAM_WEBRTC_CANDIDATES is required: the LAN address of this host as ip:port, for example 192.168.1.20:8555")
	}
	options := streaminggateway.Options{
		DataDir:            dataDir,
		EnrollmentFile:     os.Getenv("STREAM_ENROLLMENT_SECRET_FILE"),
		ConfigFile:         env("GO2RTC_CONFIG_FILE", "/go2rtc-config/go2rtc.yaml"),
		Render:             render,
		ListenAddr:         env("STREAM_LISTEN_ADDR", ":8443"),
		CertFile:           os.Getenv("STREAM_TLS_CERT_FILE"),
		KeyFile:            os.Getenv("STREAM_TLS_KEY_FILE"),
		AllowedOrigin:      parsed.Scheme + "://" + parsed.Host,
		ExpectedPublicHost: os.Getenv("STREAM_PUBLIC_HOST"),
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return streaminggateway.New(store, client, g2r, options, logger).Run(ctx)
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
