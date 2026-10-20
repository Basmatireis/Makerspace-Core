package streaminggateway

import (
	"crypto/tls"
	"errors"
	"os"
	"sync"
	"time"
)

// certReloader serves a certificate from files and picks up renewals (new mtime) without a restart.
type certReloader struct {
	certFile, keyFile string
	mu                sync.Mutex
	cert              *tls.Certificate
	certMod, keyMod   time.Time
	checkedAt         time.Time
	now               func() time.Time
}

func newCertReloader(certFile, keyFile string) (*certReloader, error) {
	if certFile == "" || keyFile == "" {
		return nil, errors.New("STREAM_TLS_CERT_FILE and STREAM_TLS_KEY_FILE are required")
	}
	r := &certReloader{certFile: certFile, keyFile: keyFile, now: func() time.Time { return time.Now() }}
	if err := r.reload(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *certReloader) reload() error {
	certInfo, err := os.Stat(r.certFile)
	if err != nil {
		return err
	}
	keyInfo, err := os.Stat(r.keyFile)
	if err != nil {
		return err
	}
	pair, err := tls.LoadX509KeyPair(r.certFile, r.keyFile)
	if err != nil {
		return err
	}
	r.cert, r.certMod, r.keyMod, r.checkedAt = &pair, certInfo.ModTime(), keyInfo.ModTime(), r.now()
	return nil
}

func (r *certReloader) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.now().Sub(r.checkedAt) > time.Minute {
		r.checkedAt = r.now()
		certInfo, certErr := os.Stat(r.certFile)
		keyInfo, keyErr := os.Stat(r.keyFile)
		if certErr == nil && keyErr == nil &&
			(!certInfo.ModTime().Equal(r.certMod) || !keyInfo.ModTime().Equal(r.keyMod)) {
			_ = r.reload() // keep serving the previous certificate if the new pair is unreadable
		}
	}
	return r.cert, nil
}

// tlsConfig is the server TLS configuration: TLS 1.2 or newer and the reloading certificate.
func (r *certReloader) tlsConfig() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: r.GetCertificate}
}
