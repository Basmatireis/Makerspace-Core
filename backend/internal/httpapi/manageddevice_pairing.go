package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

const defaultDevicePairingCookieName = "makerspace_device_pairing"

func (s *Server) devicePairingCookieName() string {
	if s.config.DevicePairingCookieName != "" {
		return s.config.DevicePairingCookieName
	}
	return defaultDevicePairingCookieName
}

func (s *Server) devicePairingCookie(value string, maxAge int) *http.Cookie {
	//nolint:gosec // Secure follows config, HttpOnly and SameSite are explicit
	return &http.Cookie{
		Name:     s.devicePairingCookieName(),
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.config.SessionCookieSecure,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   maxAge,
	}
}

// devicePairingSecret is the poll secret of the kiosk's request: the header of the desktop app, otherwise the
// HttpOnly cookie of a kiosk browser.
func (s *Server) devicePairingSecret(ctx context.Context, header *openapi.DevicePairingSecret) string {
	if header != nil && *header != "" {
		return *header
	}
	if request := httpRequest(ctx); request != nil {
		if cookie, err := request.Cookie(s.devicePairingCookieName()); err == nil {
			return cookie.Value
		}
	}
	return ""
}

// devicePairingResponse writes a pairing answer with any number of Set-Cookie lines; the generated responses can
// carry only one, and the paired answer both installs the device cookie and clears the poll cookie.
type devicePairingResponse struct {
	status  int
	body    any
	cookies []*http.Cookie
}

func (response devicePairingResponse) write(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	for _, cookie := range response.cookies {
		http.SetCookie(w, cookie)
	}
	w.WriteHeader(response.status)
	return json.NewEncoder(w).Encode(response.body)
}

func (response devicePairingResponse) VisitStartManagedDevicePairingResponse(w http.ResponseWriter) error {
	return response.write(w)
}

func (response devicePairingResponse) VisitPollManagedDevicePairingResponse(w http.ResponseWriter) error {
	return response.write(w)
}

// rejectRegisteredDevice refuses pairing for a request that already carries a valid managed-device credential
// (cookie or header): pairing would replace that browser's credential with a new device's.
func rejectRegisteredDevice(ctx context.Context) error {
	if _, registered := ctx.Value(visitorDeviceContextKey).(manageddevices.DeviceContext); registered {
		return manageddevices.ErrAlreadyRegistered()
	}
	return nil
}

func (s *Server) StartManagedDevicePairing(
	ctx context.Context,
	r openapi.StartManagedDevicePairingRequestObject,
) (openapi.StartManagedDevicePairingResponseObject, error) {
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := rejectRegisteredDevice(ctx); err != nil {
		return nil, err
	}
	delivery := manageddevices.DeliveryBrowserCookie
	if r.Body.CredentialDelivery == openapi.NativeToken {
		delivery = manageddevices.DeliveryNativeToken
	} else if request := httpRequest(ctx); request == nil || request.Header.Get("Origin") == "" {
		// The origin check excuses a missing Origin only for the desktop app; a browser always sends one.
		return nil, apperror.New(http.StatusForbidden, "origin_invalid", "Request origin is not allowed")
	}
	start, err := s.managedDevices.StartPairing(
		ctx,
		sourceAddress(ctx),
		delivery,
		s.devicePairingSecret(ctx, r.Params.XDevicePairingSecret),
	)
	if err != nil {
		return nil, err
	}
	body := openapi.ManagedDevicePairingStart{Code: start.Code, ExpiresAt: start.ExpiresAt}
	response := devicePairingResponse{status: http.StatusCreated, body: &body}
	if start.Delivery == manageddevices.DeliveryNativeToken {
		body.PollSecret = &start.PollSecret
	} else {
		response.cookies = []*http.Cookie{
			s.devicePairingCookie(start.PollSecret, int(manageddevices.PairingTTL.Seconds())),
		}
	}
	return response, nil
}

func (s *Server) PollManagedDevicePairing(
	ctx context.Context,
	r openapi.PollManagedDevicePairingRequestObject,
) (openapi.PollManagedDevicePairingResponseObject, error) {
	if err := rejectRegisteredDevice(ctx); err != nil {
		return nil, err
	}
	poll, err := s.managedDevices.PollPairing(
		ctx,
		sourceAddress(ctx),
		s.devicePairingSecret(ctx, r.Params.XDevicePairingSecret),
	)
	if err != nil {
		return nil, err
	}
	body := openapi.ManagedDevicePairingPoll{Status: openapi.ManagedDevicePairingPollStatus(poll.Status)}
	response := devicePairingResponse{status: http.StatusOK, body: &body}
	if poll.Status != manageddevices.PairingPaired {
		return response, nil
	}
	// The credential reaches only the transport the kiosk asked for when it requested the code.
	if poll.Delivery == manageddevices.DeliveryNativeToken {
		body.Token = &poll.Token
		return response, nil
	}
	response.cookies = []*http.Cookie{
		s.managedDeviceCookie(poll.Token, poll.CredentialExpiresAt),
		s.devicePairingCookie("", -1),
	}
	return response, nil
}

func (s *Server) PairManagedDevice(
	ctx context.Context,
	r openapi.PairManagedDeviceRequestObject,
) (openapi.PairManagedDeviceResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	capabilities := make([]string, len(r.Body.Capabilities))
	for i, capability := range r.Body.Capabilities {
		capabilities[i] = string(capability)
	}
	device, err := s.managedDevices.Pair(
		ctx,
		p,
		r.Body.Code,
		r.Body.Name,
		r.Body.DeviceTypeId,
		nullableTime(r.Body.ExpiresAt),
		manageddevices.DeviceSettings{
			SessionPolicyID:         nullableUUID(r.Body.SessionPolicyId),
			KioskEnabled:            r.Body.TerminalEnabled,
			AllowedApplicationModes: applicationModeStrings(r.Body.AllowedApplicationModes),
			CheckInAssurance:        authorization.Assurance(r.Body.CheckInAssurance),
			CheckOutAssurance:       authorization.Assurance(r.Body.CheckOutAssurance),
			AllowTapCheckout:        r.Body.AllowTapCheckout,
			OfferSurveysAtCheckout:  r.Body.OfferSurveysAtCheckout,
			KioskResetSeconds:       int32(r.Body.KioskResetSeconds),
			Capabilities:            capabilities,
		},
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.PairManagedDevice201JSONResponse{
		Body:    managedDeviceDTO(device),
		Headers: openapi.PairManagedDevice201ResponseHeaders{CacheControl: "no-store"},
	}, nil
}
