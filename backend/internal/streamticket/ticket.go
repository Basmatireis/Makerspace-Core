// Package streamticket signs and verifies the short-lived camera stream tickets that Core hands to
// signage players and that streaming gateways verify offline.
//
// A ticket is base64url(payload) + "." + base64url(signature) where the signature is an Ed25519
// signature over the base64url payload text. The payload is a small JSON object; the format has no
// header and no algorithm negotiation, so there is nothing for an attacker to downgrade.
package streamticket

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	// Version is the only supported payload version.
	Version = 1
	// TTL is how long a freshly signed ticket is valid.
	TTL = 5 * time.Minute
	// ClockSkew is the tolerance a verifier applies to the expiry.
	ClockSkew = 30 * time.Second
	// MaxLength bounds the size of a ticket a verifier will look at.
	MaxLength = 1024
)

// Claims is the signed payload.
type Claims struct {
	Version    int       `json:"v"`
	DisplayID  uuid.UUID `json:"displayId"`
	MachineID  uuid.UUID `json:"machineId"`
	StreamName string    `json:"streamName"`
	Expires    int64     `json:"exp"`
	KeyID      string    `json:"kid"`
}

// ExpiresAt returns the expiry as a time.
func (c Claims) ExpiresAt() time.Time { return time.Unix(c.Expires, 0).UTC() }

var (
	ErrMalformed   = errors.New("stream ticket is malformed")
	ErrUnknownKey  = errors.New("stream ticket key is unknown")
	ErrBadSig      = errors.New("stream ticket signature is invalid")
	ErrExpired     = errors.New("stream ticket is expired")
	ErrStreamClaim = errors.New("stream ticket does not match the requested stream")
)

// KeyID derives the short, stable identifier of a public key.
func KeyID(public ed25519.PublicKey) string {
	// Not secret: the first 6 bytes of the key itself are enough to tell two keys apart in practice
	// and keep the ticket short. A collision only makes the verifier try the wrong key and fail.
	return base64.RawURLEncoding.EncodeToString(public[:6])
}

// Sign creates a ticket valid for TTL from now.
func Sign(private ed25519.PrivateKey, keyID string, displayID, machineID uuid.UUID, streamName string, now time.Time) (string, Claims, error) {
	if len(private) != ed25519.PrivateKeySize {
		return "", Claims{}, errors.New("invalid signing key")
	}
	claims := Claims{Version: Version, DisplayID: displayID, MachineID: machineID, StreamName: streamName, Expires: now.Add(TTL).Unix(), KeyID: keyID}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", Claims{}, err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	signature := ed25519.Sign(private, []byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(signature), claims, nil
}

// Keys maps a key id to the public key a verifier trusts.
type Keys map[string]ed25519.PublicKey

// Verify checks signature, version and expiry (with ClockSkew). It does not compare the stream name;
// use VerifyForStream for that.
func Verify(ticket string, keys Keys, now time.Time) (Claims, error) {
	if len(ticket) == 0 || len(ticket) > MaxLength {
		return Claims{}, ErrMalformed
	}
	payloadText, signatureText, found := strings.Cut(ticket, ".")
	if !found || payloadText == "" || signatureText == "" || strings.Contains(signatureText, ".") {
		return Claims{}, ErrMalformed
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadText)
	if err != nil {
		return Claims{}, ErrMalformed
	}
	signature, err := base64.RawURLEncoding.DecodeString(signatureText)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return Claims{}, ErrMalformed
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var claims Claims
	if err = decoder.Decode(&claims); err != nil || decoder.More() {
		return Claims{}, ErrMalformed
	}
	if claims.Version != Version || claims.StreamName == "" || claims.KeyID == "" || claims.DisplayID == uuid.Nil || claims.MachineID == uuid.Nil {
		return Claims{}, ErrMalformed
	}
	public, ok := keys[claims.KeyID]
	if !ok || len(public) != ed25519.PublicKeySize {
		return Claims{}, ErrUnknownKey
	}
	if !ed25519.Verify(public, []byte(payloadText), signature) {
		return Claims{}, ErrBadSig
	}
	if now.After(claims.ExpiresAt().Add(ClockSkew)) {
		return Claims{}, ErrExpired
	}
	return claims, nil
}

// VerifyForStream verifies the ticket and requires it to be issued for exactly this stream name.
func VerifyForStream(ticket string, keys Keys, streamName string, now time.Time) (Claims, error) {
	claims, err := Verify(ticket, keys, now)
	if err != nil {
		return Claims{}, err
	}
	if claims.StreamName != streamName {
		return Claims{}, ErrStreamClaim
	}
	return claims, nil
}

// StreamName is the stable go2rtc stream name of a machine's camera.
func StreamName(machineID uuid.UUID) string {
	return "cam-" + strings.ReplaceAll(machineID.String(), "-", "")
}
