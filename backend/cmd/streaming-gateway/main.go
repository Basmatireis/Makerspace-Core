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

	"github.com/Basmatireis/Makerspace-Core/backend/internal/localupdater"
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
	allowedOrigin, err := playerOrigin(parsed, os.Getenv("STREAM_ALLOWED_ORIGIN"))
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
	defer func() { _ = store.Close() }()

	render := streaminggateway.DefaultRenderOptions()
	render.APIListen = env("GO2RTC_API_LISTEN", render.APIListen)
	render.WebRTCListen = env("GO2RTC_WEBRTC_LISTEN", render.WebRTCListen)
	render.LogLevel = streaminggateway.LogLevel(env("GO2RTC_LOG_LEVEL", string(render.LogLevel)))
	if !streaminggateway.ValidLogLevel(render.LogLevel) {
		return errors.New(
			"GO2RTC_LOG_LEVEL must be error or fatal: go2rtc logs stream sources, which contain the printers' access codes, at more verbose levels",
		)
	}
	for _, candidate := range strings.Split(os.Getenv("STREAM_WEBRTC_CANDIDATES"), ",") {
		if candidate = strings.TrimSpace(candidate); candidate != "" {
			render.WebRTCCandidates = append(render.WebRTCCandidates, candidate)
		}
	}
	if len(render.WebRTCCandidates) == 0 {
		return errors.New(
			"STREAM_WEBRTC_CANDIDATES is required: the LAN address of this host as ip:port, for example 192.168.1.20:8555",
		)
	}
	options := streaminggateway.Options{
		DataDir:            dataDir,
		EnrollmentSecret:   os.Getenv("STREAM_ENROLLMENT_SECRET"),
		EnrollmentFile:     os.Getenv("STREAM_ENROLLMENT_SECRET_FILE"),
		ConfigFile:         env("GO2RTC_CONFIG_FILE", "/go2rtc-config/go2rtc.yaml"),
		Render:             render,
		ListenAddr:         env("STREAM_LISTEN_ADDR", ":8443"),
		CertFile:           os.Getenv("STREAM_TLS_CERT_FILE"),
		KeyFile:            os.Getenv("STREAM_TLS_KEY_FILE"),
		AllowedOrigin:      allowedOrigin,
		ExpectedPublicHost: os.Getenv("STREAM_PUBLIC_HOST"),
		Updates: localupdater.NewExchange(
			env("UPDATER_EXCHANGE_DIR", localupdater.DefaultExchangeRoot),
			localupdater.ComponentStreamingGateway,
		),
	}
	selection, err := streaminggateway.SelectTLSMode(options.CertFile, options.KeyFile, options.ExpectedPublicHost,
		os.Getenv("ACME_EMAIL"), os.Getenv("CLOUDFLARE_DNS_API_TOKEN"))
	if err != nil {
		return err
	}
	if selection.Mode == streaminggateway.TLSModeACME {
		acme, acmeErr := acmeOptions(selection.Domain)
		if acmeErr != nil {
			return acmeErr
		}
		options.ACME = acme
		options.CertFile, options.KeyFile = "", ""
		logger.Info("tls: ACME mode", "domain", selection.Domain, "ca", acme.CADir)
	} else {
		logger.Info("tls: certificate files")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return streaminggateway.New(store, client, g2r, options, logger).Run(ctx)
}

// acmeOptions reads the ACME settings of the environment (ACME mode only).
func acmeOptions(domain string) (*streaminggateway.ACMEOptions, error) {
	caDir, err := streaminggateway.ValidateACMEDirectory(os.Getenv("ACME_CA_DIR"))
	if err != nil {
		return nil, err
	}
	resolvers, err := streaminggateway.ParseACMEResolvers(os.Getenv("ACME_DNS_RESOLVERS"))
	if err != nil {
		return nil, err
	}
	wait, err := streaminggateway.ParseACMEPropagationWait(os.Getenv("ACME_DNS_PROPAGATION_WAIT"))
	if err != nil {
		return nil, err
	}
	return &streaminggateway.ACMEOptions{
		PropagationWait: wait,
		Domain:          domain,
		Email:           strings.TrimSpace(os.Getenv("ACME_EMAIL")),
		CloudflareToken: strings.TrimSpace(os.Getenv("CLOUDFLARE_DNS_API_TOKEN")),
		CADir:           caDir,
		Resolvers:       resolvers,
	}, nil
}

// playerOrigin is the browser origin the proxy accepts: Core's origin by default. STREAM_ALLOWED_ORIGIN
// overrides it when the gateway reaches Core under another address than browsers do, for example in
// development (CORE_URL http://host.docker.internal:8080, player served from http://localhost:5173).
func playerOrigin(core *url.URL, override string) (string, error) {
	override = strings.TrimSpace(override)
	if override == "" {
		return core.Scheme + "://" + core.Host, nil
	}
	parsed, err := url.Parse(override)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("STREAM_ALLOWED_ORIGIN must be an origin such as https://makerspace.example.org")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
