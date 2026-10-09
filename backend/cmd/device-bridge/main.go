package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/devicebridge"
)

type config struct {
	listen, origins, pairingFile, coreURL, deviceTokenFile, tlsCert, tlsKey string
	simulator, showPairing, deviceTokenStdin                                bool
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "device bridge:", err)
		os.Exit(1)
	}
}

func run() error {
	var cfg config
	defaultPairing, err := defaultPairingFile()
	if err != nil {
		return err
	}
	flag.StringVar(&cfg.listen, "listen", "127.0.0.1:17321", "loopback address for the local bridge")
	flag.StringVar(&cfg.origins, "origins", "http://localhost:5173,http://127.0.0.1:5173", "comma-separated exact web origins allowed to use the bridge")
	flag.StringVar(&cfg.pairingFile, "pairing-key-file", defaultPairing, "0600 file containing the browser pairing key")
	flag.StringVar(&cfg.coreURL, "core-url", "", "optional Makerspace Core base URL")
	flag.StringVar(&cfg.deviceTokenFile, "device-token-file", "", "optional 0600 file containing the managed-device token")
	flag.BoolVar(&cfg.deviceTokenStdin, "device-token-stdin", false, "read the managed-device token once from standard input")
	flag.StringVar(&cfg.tlsCert, "tls-cert", "", "optional local TLS certificate")
	flag.StringVar(&cfg.tlsKey, "tls-key", "", "optional local TLS private key")
	flag.BoolVar(&cfg.simulator, "simulator", false, "enable development-only NFC simulation")
	flag.BoolVar(&cfg.showPairing, "show-pairing-key", false, "print the pairing key to this terminal and exit")
	flag.Parse()

	host, _, err := net.SplitHostPort(cfg.listen)
	if err != nil || !isLoopback(host) {
		return errors.New("listen must be a loopback host and port")
	}
	pairingKey, err := loadOrCreatePairingKey(cfg.pairingFile)
	if err != nil {
		return err
	}
	if cfg.showPairing {
		fmt.Println(pairingKey)
		return nil
	}
	origins := splitNonEmpty(cfg.origins)
	broker := devicebridge.NewBroker()
	pcsc := devicebridge.NewPCSCSource()
	capabilities := func() []devicebridge.Capability {
		capability := pcsc.Capability()
		if cfg.simulator && !capability.Available {
			capability = devicebridge.Capability{ID: "nfc", Available: true, State: "simulated", Detail: "Development simulator enabled"}
		}
		return []devicebridge.Capability{capability}
	}
	bridge, err := devicebridge.NewServer(devicebridge.ServerConfig{PairingKey: pairingKey, AllowedOrigins: origins, Simulator: cfg.simulator, Capabilities: capabilities}, broker)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go pcsc.Run(ctx, broker)
	if cfg.coreURL != "" || cfg.deviceTokenFile != "" || cfg.deviceTokenStdin {
		if cfg.coreURL == "" || (cfg.deviceTokenFile == "") == !cfg.deviceTokenStdin {
			return errors.New("core-url requires exactly one of device-token-file or device-token-stdin")
		}
		var token string
		var readErr error
		if cfg.deviceTokenStdin {
			token, readErr = readSecretStdin()
		} else {
			token, readErr = readSecretFile(cfg.deviceTokenFile)
		}
		if readErr != nil {
			return readErr
		}
		client, clientErr := devicebridge.NewCoreClient(cfg.coreURL, token)
		if clientErr != nil {
			return clientErr
		}
		go reportToCore(ctx, client, bridge, capabilities)
	}
	// The desktop shell sends the managed-device credential on stdin before the
	// development simulator starts reading commands from the same stream.
	if cfg.simulator {
		go simulatorConsole(ctx, broker)
	}

	httpServer := &http.Server{Addr: cfg.listen, Handler: bridge.Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 35 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()
	slog.Info("device bridge listening", "address", cfg.listen, "simulator", cfg.simulator, "tls", cfg.tlsCert != "")
	if (cfg.tlsCert == "") != (cfg.tlsKey == "") {
		return errors.New("tls-cert and tls-key must be configured together")
	}
	if cfg.tlsCert != "" {
		err = httpServer.ListenAndServeTLS(cfg.tlsCert, cfg.tlsKey)
	} else {
		err = httpServer.ListenAndServe()
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func readSecretStdin() (string, error) {
	return readSecret(os.Stdin)
}

func readSecret(input io.Reader) (string, error) {
	reader := bufio.NewReader(io.LimitReader(input, 129))
	value, err := reader.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", errors.New("read managed-device credential from standard input")
	}
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return "", errors.New("managed-device credential from standard input is invalid")
	}
	return value, nil
}

func reportToCore(ctx context.Context, client *devicebridge.CoreClient, bridge *devicebridge.Server, capabilities func() []devicebridge.Capability) {
	delay := time.Second
	for ctx.Err() == nil {
		identity, err := client.Report(ctx, capabilities())
		if err == nil {
			bridge.SetCoreState(true, identity.DeviceName)
			delay = 30 * time.Second
		} else {
			bridge.SetCoreState(false, "")
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if err != nil && delay < time.Minute {
			delay *= 2
		}
	}
}

func simulatorConsole(ctx context.Context, broker *devicebridge.Broker) {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() && ctx.Err() == nil {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 {
			continue
		}
		uid := ""
		if len(fields) > 1 {
			uid = fields[1]
		}
		if _, err := devicebridge.Simulate(broker, fields[0], uid); err != nil {
			fmt.Fprintln(os.Stderr, "simulator:", err)
		}
	}
}

func defaultPairingFile() (string, error) {
	directory, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(directory, "makerspace-core", "device-bridge.key"), nil
}

func loadOrCreatePairingKey(path string) (string, error) {
	if value, err := readSecretFile(path); err == nil {
		if len(value) < 32 {
			return "", errors.New("pairing key file must contain at least 32 characters")
		}
		return value, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	value := base64.RawURLEncoding.EncodeToString(random)
	if err := os.WriteFile(path, []byte(value+"\n"), 0o600); err != nil {
		return "", err
	}
	return value, nil
}

func readSecretFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("secret file permissions must be 0600 or stricter")
	}
	value, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(value)), nil
}

func splitNonEmpty(value string) []string {
	result := make([]string, 0)
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func isLoopback(host string) bool {
	host = strings.Trim(host, "[]")
	return strings.EqualFold(host, "localhost") || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}
