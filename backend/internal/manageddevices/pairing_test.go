package manageddevices

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
)

// These paths are decided before any database access, so the service runs without a pool.

func TestPollPairingIgnoresMalformedSecretsWithoutSpendingTheLimit(t *testing.T) {
	service := NewService(nil)
	for i := 0; i < pairingPollsPerWindow*2; i++ {
		for _, secret := range []string{"", "not-a-token", strings.Repeat("a", 42), strings.Repeat("!", 43)} {
			poll, err := service.PollPairing(context.Background(), "192.0.2.10", secret)
			if err != nil || poll.Status != PairingExpired || poll.Token != "" {
				t.Fatalf("poll(%q) = %#v, %v", secret, poll, err)
			}
		}
	}
	valid, _, err := security.NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	if !wellFormedSecret(valid) {
		t.Fatal("a real poll secret must be accepted as well formed")
	}
}

func TestStartPairingRejectsUnknownDelivery(t *testing.T) {
	_, err := NewService(nil).StartPairing(context.Background(), "192.0.2.10", "email", "")
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || appErr.HTTPStatus != http.StatusUnprocessableEntity {
		t.Fatalf("err = %v, want 422", err)
	}
}

func TestPairRequiresManagePermission(t *testing.T) {
	principal := authorization.Principal{AccountID: ids.New()}
	_, err := NewService(nil).Pair(context.Background(), principal, "ABC234", "Kiosk", ids.New(), nil,
		DeviceSettings{}, nil)
	if !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("err = %v, want permission denied", err)
	}
}

func TestPairThrottlesRepeatedMalformedCodesPerAccount(t *testing.T) {
	service := NewService(nil)
	principal := authorization.Principal{AccountID: ids.New(), Master: true}
	for i := 0; i < claimFailuresPerWindow; i++ {
		_, err := service.Pair(context.Background(), principal, "no", "Kiosk", ids.New(), nil, DeviceSettings{}, nil)
		if !apperror.IsCode(err, "pairing_code_invalid") {
			t.Fatalf("attempt %d: err = %v, want pairing_code_invalid", i, err)
		}
	}
	_, err := service.Pair(context.Background(), principal, "no", "Kiosk", ids.New(), nil, DeviceSettings{}, nil)
	if !apperror.IsCode(err, "rate_limited") {
		t.Fatalf("err = %v, want rate_limited", err)
	}
	other := authorization.Principal{AccountID: ids.New(), Master: true}
	if _, err := service.Pair(context.Background(), other, "no", "Kiosk", ids.New(), nil, DeviceSettings{},
		nil); !apperror.IsCode(err, "pairing_code_invalid") {
		t.Fatalf("another account must not be throttled: %v", err)
	}
}

func TestPairValidatesSettingsBeforeSpendingAnAttempt(t *testing.T) {
	service := NewService(nil)
	principal := authorization.Principal{AccountID: ids.New(), Master: true}
	for i := 0; i < claimFailuresPerWindow*2; i++ {
		_, err := service.Pair(context.Background(), principal, "ABC234", "Kiosk", ids.New(), nil, DeviceSettings{
			AllowedApplicationModes: []ApplicationMode{ModeSignagePlayer},
		}, nil)
		if apperror.IsCode(err, "rate_limited") || apperror.IsCode(err, "pairing_code_invalid") {
			t.Fatalf("invalid settings must be rejected before the code is checked: %v", err)
		}
	}
}
