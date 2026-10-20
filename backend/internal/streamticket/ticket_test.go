package streamticket

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func newKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey, string) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return public, private, KeyID(public)
}

func TestSignVerifyRoundTrip(t *testing.T) {
	public, private, kid := newKey(t)
	now := time.Now().UTC()
	display, machine := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	name := StreamName(machine)
	ticket, claims, err := Sign(private, kid, display, machine, name, now)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(ticket, ".") != 1 || len(ticket) > MaxLength {
		t.Fatalf("unexpected ticket shape %q", ticket)
	}
	got, err := VerifyForStream(ticket, Keys{kid: public}, name, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if got != claims || got.DisplayID != display || got.MachineID != machine || got.Version != 1 {
		t.Fatalf("claims = %+v, want %+v", got, claims)
	}
	if want := now.Add(TTL).Unix(); got.Expires != want {
		t.Fatalf("exp = %d, want %d", got.Expires, want)
	}
}

func TestExpiryAllowsSkewOnly(t *testing.T) {
	public, private, kid := newKey(t)
	now := time.Now().UTC()
	ticket, _, _ := Sign(private, kid, uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), "cam-x", now)
	keys := Keys{kid: public}
	if _, err := Verify(ticket, keys, now.Add(TTL+ClockSkew-time.Second)); err != nil {
		t.Fatalf("within skew: %v", err)
	}
	if _, err := Verify(ticket, keys, now.Add(TTL+ClockSkew+time.Second)); !errors.Is(err, ErrExpired) {
		t.Fatalf("after skew: %v", err)
	}
}

func TestTamperingAndWrongKeysAreRejected(t *testing.T) {
	public, private, kid := newKey(t)
	otherPublic, _, _ := newKey(t)
	now := time.Now().UTC()
	machine := uuid.Must(uuid.NewV7())
	ticket, _, _ := Sign(private, kid, uuid.Must(uuid.NewV7()), machine, "cam-a", now)
	keys := Keys{kid: public}

	payloadText, signatureText, _ := strings.Cut(ticket, ".")
	// Replace the payload with a different one signed by nobody.
	forged := base64.RawURLEncoding.EncodeToString([]byte(`{"v":1,"displayId":"` + uuid.Nil.String() + `","machineId":"` + machine.String() + `","streamName":"cam-b","exp":99999999999,"kid":"` + kid + `"}`))
	flipped := []byte(payloadText)
	if flipped[5] == 'A' {
		flipped[5] = 'B'
	} else {
		flipped[5] = 'A'
	}
	cases := map[string]string{
		"payload swapped":  forged + "." + signatureText,
		"payload bit flip": string(flipped) + "." + signatureText,
		"signature cut":    payloadText + "." + signatureText[:len(signatureText)-4],
		"no separator":     payloadText + signatureText,
		"extra part":       ticket + ".AAAA",
		"empty":            "",
		"garbage":          "not a ticket",
		"too long":         strings.Repeat("A", MaxLength+1),
	}
	for name, candidate := range cases {
		if _, err := Verify(candidate, keys, now); err == nil {
			t.Errorf("%s: ticket accepted", name)
		}
	}
	if _, err := Verify(ticket, Keys{kid: otherPublic}, now); !errors.Is(err, ErrBadSig) {
		t.Errorf("wrong key = %v, want bad signature", err)
	}
	if _, err := Verify(ticket, Keys{"other": public}, now); !errors.Is(err, ErrUnknownKey) {
		t.Errorf("unknown kid = %v", err)
	}
	if _, err := VerifyForStream(ticket, keys, "cam-b", now); !errors.Is(err, ErrStreamClaim) {
		t.Errorf("stream mismatch = %v", err)
	}
}

func TestUnknownFieldsAndVersionAreRejected(t *testing.T) {
	public, private, kid := newKey(t)
	sign := func(payload string) string {
		encoded := base64.RawURLEncoding.EncodeToString([]byte(payload))
		return encoded + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, []byte(encoded)))
	}
	id := uuid.Must(uuid.NewV7()).String()
	now := time.Now().UTC()
	base := `"displayId":"` + id + `","machineId":"` + id + `","streamName":"cam-a","exp":` + strconv.FormatInt(now.Add(time.Minute).Unix(), 10) + `,"kid":"` + kid + `"`
	if _, err := Verify(sign(`{"v":1,`+base+`}`), Keys{kid: public}, now); err != nil {
		t.Fatalf("well-formed signed payload: %v", err)
	}
	for name, payload := range map[string]string{
		"version 2":     `{"v":2,` + base + `}`,
		"extra field":   `{"v":1,"admin":true,` + base + `}`,
		"missing field": `{"v":1,"displayId":"` + id + `","exp":99999999999,"kid":"` + kid + `"}`,
	} {
		if _, err := Verify(sign(payload), Keys{kid: public}, now); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s = %v, want malformed", name, err)
		}
	}
}

func TestStreamNameIsStableAndSafe(t *testing.T) {
	id := uuid.MustParse("01920000-0000-7000-8000-000000000001")
	if got := StreamName(id); got != "cam-01920000000070008000000000000001" {
		t.Fatalf("stream name = %q", got)
	}
	if StreamName(id) != StreamName(id) {
		t.Fatal("stream name must be deterministic")
	}
}

func TestTicketsWithAnExcessiveLifetimeAreRejected(t *testing.T) {
	public, private, kid := newKey(t)
	now := time.Now().UTC()
	sign := func(issuedAt time.Time) string {
		ticket, _, err := Sign(private, kid, uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), "cam-a", issuedAt)
		if err != nil {
			t.Fatal(err)
		}
		return ticket
	}
	if _, err := Verify(sign(now), Keys{kid: public}, now); err != nil {
		t.Fatalf("regular ticket: %v", err)
	}
	// Issued by a signer with a skewed clock but within the tolerated skew.
	if _, err := Verify(sign(now.Add(ClockSkew-time.Second)), Keys{kid: public}, now); err != nil {
		t.Fatalf("ticket inside the skew: %v", err)
	}
	for name, issuedAt := range map[string]time.Time{"an hour": now.Add(time.Hour), "a year": now.Add(365 * 24 * time.Hour), "just beyond the skew": now.Add(ClockSkew + 2*time.Second)} {
		if _, err := Verify(sign(issuedAt), Keys{kid: public}, now); !errors.Is(err, ErrLifetime) {
			t.Errorf("ticket valid %s ahead = %v, want ErrLifetime", name, err)
		}
	}
}
