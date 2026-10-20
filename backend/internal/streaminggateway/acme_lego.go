package streaminggateway

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-acme/lego/v4/certcrypto"
	"github.com/go-acme/lego/v4/certificate"
	"github.com/go-acme/lego/v4/challenge/dns01"
	"github.com/go-acme/lego/v4/lego"
	legolog "github.com/go-acme/lego/v4/log"
	"github.com/go-acme/lego/v4/providers/dns/cloudflare"
	"github.com/go-acme/lego/v4/registration"
)

// legoObtainer is the Let's Encrypt client: ACME account in the data directory, DNS-01 via Cloudflare.
type legoObtainer struct {
	dir     string
	options ACMEOptions
}

func newLegoObtainer(dir string, options ACMEOptions, logger *slog.Logger) *legoObtainer {
	legolog.Logger = legoLogger{logger: logger, secrets: []string{options.CloudflareToken}}
	return &legoObtainer{dir: dir, options: options}
}

func (o *legoObtainer) Obtain(ctx context.Context, domain string) ([]byte, []byte, error) {
	type result struct {
		cert, key []byte
		err       error
	}
	done := make(chan result, 1)
	go func() {
		cert, key, err := o.obtain(domain)
		done <- result{cert, key, err}
	}()
	select {
	case r := <-done:
		return r.cert, r.key, r.err
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
}

func (o *legoObtainer) obtain(domain string) ([]byte, []byte, error) {
	user, err := loadACMEAccount(filepath.Join(o.dir, "account.json"), o.options.Email, o.options.CADir)
	if err != nil {
		return nil, nil, err
	}
	config := lego.NewConfig(user)
	config.CADirURL = o.options.CADir
	config.UserAgent = "makerspace-streaming-gateway/" + Version
	config.Certificate.KeyType = certcrypto.EC256
	client, err := lego.NewClient(config)
	if err != nil {
		return nil, nil, fmt.Errorf("ACME client: %w", err)
	}
	providerConfig := cloudflare.NewDefaultConfig()
	providerConfig.AuthToken = o.options.CloudflareToken
	provider, err := cloudflare.NewDNSProviderConfig(providerConfig)
	if err != nil {
		return nil, nil, err
	}
	// The recursive resolvers are explicit: the local resolver (for example dnsmasq with rebind
	// protection) may refuse public names that point to private addresses.
	challengeOptions := []dns01.ChallengeOption{
		dns01.AddRecursiveNameservers(dns01.ParseNameservers(o.options.Resolvers)),
	}
	if o.options.PropagationWait > 0 {
		// Some routers answer every port-53 query themselves (cached), so the gateway cannot see the
		// new record; wait instead and let Let's Encrypt validate from the internet.
		challengeOptions = append(challengeOptions, dns01.PropagationWait(o.options.PropagationWait, true))
	}
	if err = client.Challenge.SetDNS01Provider(provider, challengeOptions...); err != nil {
		return nil, nil, err
	}
	if user.Registration == nil {
		registered, registerErr := client.Registration.Register(
			registration.RegisterOptions{TermsOfServiceAgreed: true},
		)
		if registerErr != nil {
			return nil, nil, fmt.Errorf("ACME account registration: %w", registerErr)
		}
		user.Registration = registered
		if err = user.save(); err != nil {
			return nil, nil, err
		}
	}
	resource, err := client.Certificate.Obtain(certificate.ObtainRequest{Domains: []string{domain}, Bundle: true})
	if err != nil {
		return nil, nil, err
	}
	return resource.Certificate, resource.PrivateKey, nil
}

// acmeAccount is the ACME account, stored as JSON (mode 0600) in the data directory.
type acmeAccount struct {
	path         string
	Email        string                 `json:"email"`
	CADir        string                 `json:"caDir"`
	PrivateKey   string                 `json:"privateKey"`
	Registration *registration.Resource `json:"registration,omitempty"`
	key          *ecdsa.PrivateKey
}

func (a *acmeAccount) GetEmail() string                        { return a.Email }
func (a *acmeAccount) GetRegistration() *registration.Resource { return a.Registration }
func (a *acmeAccount) GetPrivateKey() crypto.PrivateKey        { return a.key }

func (a *acmeAccount) save() error {
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	return writeFileAtomic(a.path, raw)
}

// loadACMEAccount reuses the stored account; a different e-mail address or CA creates a new one.
func loadACMEAccount(path, email, caDir string) (*acmeAccount, error) {
	if raw, err := os.ReadFile(path); err == nil {
		var stored acmeAccount
		if json.Unmarshal(raw, &stored) == nil && stored.Email == email && stored.CADir == caDir {
			if block, _ := pem.Decode([]byte(stored.PrivateKey)); block != nil {
				if key, parseErr := x509.ParseECPrivateKey(block.Bytes); parseErr == nil {
					stored.path, stored.key = path, key
					return &stored, nil
				}
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, err
	}
	account := &acmeAccount{path: path, Email: email, CADir: caDir, key: key,
		PrivateKey: string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}))}
	if err = account.save(); err != nil {
		return nil, fmt.Errorf("store ACME account: %w", err)
	}
	return account, nil
}

// legoLogger forwards lego's progress messages to slog and removes secrets.
type legoLogger struct {
	logger  *slog.Logger
	secrets []string
}

func (l legoLogger) log(message string) {
	for _, secret := range l.secrets {
		if secret != "" {
			message = strings.ReplaceAll(message, secret, "[redacted]")
		}
	}
	l.logger.Info("acme", "message", strings.TrimSpace(message))
}

func (l legoLogger) Print(args ...any)                 { l.log(fmt.Sprint(args...)) }
func (l legoLogger) Println(args ...any)               { l.log(fmt.Sprintln(args...)) }
func (l legoLogger) Printf(format string, args ...any) { l.log(fmt.Sprintf(format, args...)) }
func (l legoLogger) Fatal(args ...any)                 { l.log(fmt.Sprint(args...)) }
func (l legoLogger) Fatalln(args ...any)               { l.log(fmt.Sprintln(args...)) }
func (l legoLogger) Fatalf(format string, args ...any) { l.log(fmt.Sprintf(format, args...)) }
