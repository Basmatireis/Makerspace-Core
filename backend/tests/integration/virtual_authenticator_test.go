package integration_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/url"
	"testing"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
)

// virtualAuthenticator is a software platform authenticator with one ES256 discoverable credential, "none"
// attestation, and user verification, enough to drive the WebAuthn ceremonies end to end.
type virtualAuthenticator struct {
	t            *testing.T
	origin       string
	rpID         string
	key          *ecdsa.PrivateKey
	credentialID []byte
	userHandle   []byte
	signCount    uint32
}

var b64 = base64.RawURLEncoding

func newVirtualAuthenticator(t *testing.T, origin string) *virtualAuthenticator {
	t.Helper()
	parsed, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	credentialID := make([]byte, 32)
	if _, err := rand.Read(credentialID); err != nil {
		t.Fatal(err)
	}
	return &virtualAuthenticator{t: t, origin: origin, rpID: parsed.Hostname(), key: key, credentialID: credentialID}
}

func (a *virtualAuthenticator) clientData(kind, challenge string) []byte {
	encoded, err := json.Marshal(map[string]any{
		"type": kind, "challenge": challenge, "origin": a.origin, "crossOrigin": false,
	})
	if err != nil {
		a.t.Fatal(err)
	}
	return encoded
}

func (a *virtualAuthenticator) authenticatorData(attested bool) []byte {
	rpIDHash := sha256.Sum256([]byte(a.rpID))
	flags := byte(0x01 | 0x04) // user present, user verified
	if attested {
		flags |= 0x40
	}
	data := append([]byte{}, rpIDHash[:]...)
	data = append(data, flags)
	data = binary.BigEndian.AppendUint32(data, a.signCount)
	if !attested {
		return data
	}
	publicKey, err := webauthncbor.Marshal(map[int]any{
		1: 2, 3: -7, -1: 1,
		-2: a.key.X.FillBytes(make([]byte, 32)),
		-3: a.key.Y.FillBytes(make([]byte, 32)),
	})
	if err != nil {
		a.t.Fatal(err)
	}
	data = append(data, make([]byte, 16)...) // AAGUID
	data = binary.BigEndian.AppendUint16(data, uint16(len(a.credentialID)))
	data = append(data, a.credentialID...)
	return append(data, publicKey...)
}

func optionString(t *testing.T, options map[string]any, path ...string) string {
	t.Helper()
	var current any = options
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("options lack %v: %v", path, options)
		}
		current = object[key]
	}
	text, ok := current.(string)
	if !ok {
		t.Fatalf("options lack string %v: %v", path, options)
	}
	return text
}

// register answers navigator.credentials.create options.
func (a *virtualAuthenticator) register(options map[string]any) map[string]any {
	challenge := optionString(a.t, options, "publicKey", "challenge")
	userID := optionString(a.t, options, "publicKey", "user", "id")
	handle, err := b64.DecodeString(userID)
	if err != nil {
		a.t.Fatal(err)
	}
	a.userHandle = handle
	attestation, err := webauthncbor.Marshal(map[string]any{
		"fmt": "none", "attStmt": map[string]any{}, "authData": a.authenticatorData(true),
	})
	if err != nil {
		a.t.Fatal(err)
	}
	return map[string]any{
		"id": b64.EncodeToString(a.credentialID), "rawId": b64.EncodeToString(a.credentialID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64.EncodeToString(a.clientData("webauthn.create", challenge)),
			"attestationObject": b64.EncodeToString(attestation),
			"transports":        []string{"internal"},
		},
		"clientExtensionResults":  map[string]any{},
		"authenticatorAttachment": "platform",
	}
}

// assert answers navigator.credentials.get options; each assertion increases the signature counter.
func (a *virtualAuthenticator) assert(options map[string]any) map[string]any {
	challenge := optionString(a.t, options, "publicKey", "challenge")
	a.signCount++
	authData := a.authenticatorData(false)
	clientData := a.clientData("webauthn.get", challenge)
	clientHash := sha256.Sum256(clientData)
	digest := sha256.Sum256(append(append([]byte{}, authData...), clientHash[:]...))
	signature, err := ecdsa.SignASN1(rand.Reader, a.key, digest[:])
	if err != nil {
		a.t.Fatal(err)
	}
	return map[string]any{
		"id": b64.EncodeToString(a.credentialID), "rawId": b64.EncodeToString(a.credentialID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64.EncodeToString(clientData),
			"authenticatorData": b64.EncodeToString(authData),
			"signature":         b64.EncodeToString(signature),
			"userHandle":        b64.EncodeToString(a.userHandle),
		},
		"clientExtensionResults":  map[string]any{},
		"authenticatorAttachment": "platform",
	}
}
