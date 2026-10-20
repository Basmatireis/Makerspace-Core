package printerconnector

import (
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"errors"
	"fmt"
)

// Source: BambuStudio resources/cert/printer.cer, retrieved 2026-10-14.
// https://github.com/bambulab/BambuStudio/blob/master/resources/cert/printer.cer
//
//go:embed bambu_printer_ca.pem
var bambuPrinterCAPEM []byte

func bambuTLSConfig(serial string) (*tls.Config, error) {
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(bambuPrinterCAPEM) {
		return nil, errors.New("load vendored Bambu printer CA bundle")
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		// Use the verified printer identity as the cache key on both the
		// control connection (:990) and its ephemeral passive data ports.
		// Without this, Go keys sessions by IP:port and the H2D rejects the
		// protected data channel with FTP 522 (session reuse required).
		ServerName:         serial,
		ClientSessionCache: tls.NewLRUClientSessionCache(4),
		// Verification is performed below because printers are addressed by IP
		// while their certificate identity is the configured serial number.
		InsecureSkipVerify: true, //nolint:gosec -- VerifyConnection performs full verification.
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("bambu TLS peer supplied no certificate")
			}
			intermediates := x509.NewCertPool()
			for _, certificate := range state.PeerCertificates[1:] {
				intermediates.AddCert(certificate)
			}
			if _, err := state.PeerCertificates[0].Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
				return fmt.Errorf("verify Bambu printer certificate chain: %w", err)
			}
			if state.PeerCertificates[0].Subject.CommonName != serial {
				return fmt.Errorf(
					"Bambu printer certificate serial mismatch: got %q",
					state.PeerCertificates[0].Subject.CommonName,
				)
			}
			return nil
		},
	}, nil
}
