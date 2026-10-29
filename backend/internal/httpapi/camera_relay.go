package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/camerarelay"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	websocketHandshakeTimeout = 10 * time.Second
	websocketBufferBytes      = 32 << 10
	managedDeviceTokenHeader  = "X-Managed-Device-Token"
)

// cameraStreamPath is the relative URL of a machine's camera websocket, as SignagePlayerLive.streams offers it.
func cameraStreamPath(machineID uuid.UUID) string {
	return apiBasePath + "/signage/player/cameras/" + machineID.String() + "/stream"
}

// websocketUpgrade is the response of a websocket operation once every check before the upgrade passed: visiting it
// upgrades the raw request and serves the connection until it ends. It writes nothing through the generated
// response path, because the connection belongs to the websocket after the upgrade.
type websocketUpgrade func(w http.ResponseWriter)

func (u websocketUpgrade) VisitStreamSignagePlayerCameraResponse(w http.ResponseWriter) error {
	u(w)
	return nil
}

func (u websocketUpgrade) VisitConnectPrinterConnectorStreamControlResponse(w http.ResponseWriter) error {
	u(w)
	return nil
}

func (u websocketUpgrade) VisitAcceptPrinterConnectorStreamSessionResponse(w http.ResponseWriter) error {
	u(w)
	return nil
}

func rawRequest(ctx context.Context) (*http.Request, error) {
	r, ok := ctx.Value(httpRequestContextKey).(*http.Request)
	if !ok {
		return nil, apperror.Unauthenticated
	}
	return r, nil
}

var errViewerLeft = apperror.New(
	http.StatusServiceUnavailable,
	"camera_unavailable",
	"The viewer left before the stream opened",
)

var errWebsocketRequired = apperror.New(
	http.StatusBadRequest,
	"websocket_required",
	"This operation needs a websocket upgrade",
)

// websocketOriginAllowed applies the cross-site rule to websocket upgrades: browsers send them as GET requests with
// cookies from any page, so an Origin, when present, must be the application's public origin, and only a request that
// authenticates without a cookie (device token header or connector bearer) may omit it.
func (s *Server) websocketOriginAllowed(r *http.Request, cookieAuthenticated bool) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return !cookieAuthenticated
	}
	return origin == s.config.PublicBaseURL.Scheme+"://"+s.config.PublicBaseURL.Host
}

// upgradeWebsocket upgrades the request. Failures before the hijack answer with the JSON error envelope (the
// Cache-Control: no-store default is already set); the HTTP server's read and write timeouts are cleared on the
// hijacked connection, whose deadlines the relay manages.
func (s *Server) upgradeWebsocket(w http.ResponseWriter, r *http.Request, cookieAuthenticated bool) *websocket.Conn {
	upgrader := websocket.Upgrader{
		HandshakeTimeout: websocketHandshakeTimeout,
		ReadBufferSize:   websocketBufferBytes,
		WriteBufferSize:  websocketBufferBytes,
		CheckOrigin:      func(r *http.Request) bool { return s.websocketOriginAllowed(r, cookieAuthenticated) },
		Error: func(w http.ResponseWriter, r *http.Request, status int, _ error) {
			writeAPIError(w, r, apperror.New(status, "websocket_upgrade_failed", "The websocket upgrade failed"), s.logger)
		},
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return nil
	}
	_ = conn.NetConn().SetDeadline(time.Time{})
	return conn
}

func (s *Server) StreamSignagePlayerCamera(
	ctx context.Context,
	request openapi.StreamSignagePlayerCameraRequestObject,
) (openapi.StreamSignagePlayerCameraResponseObject, error) {
	r, err := rawRequest(ctx)
	if err != nil {
		return nil, err
	}
	device, ok := ctx.Value(visitorDeviceContextKey).(manageddevices.DeviceContext)
	if !ok || !device.IsSignagePlayer() {
		return nil, apperror.Unauthenticated
	}
	// The authentication middleware refuses requests that carry both credentials.
	token := r.Header.Get(managedDeviceTokenHeader)
	cookieAuthenticated := token == ""
	if cookieAuthenticated {
		cookie, err := r.Cookie(s.config.ManagedDeviceCookieName)
		if err != nil {
			return nil, apperror.Unauthenticated
		}
		token = cookie.Value
	}
	if !s.websocketOriginAllowed(r, cookieAuthenticated) {
		return nil, apperror.New(http.StatusForbidden, "origin_invalid", "Request origin is not allowed")
	}
	if !websocket.IsWebSocketUpgrade(r) {
		return nil, errWebsocketRequired
	}
	machineID := request.MachineId
	grant, err := s.signage.AuthorizeCamera(ctx, device.ID, machineID)
	if err != nil {
		return nil, err
	}
	session, err := s.cameraRelay.Open(ctx, camerarelay.Viewer{
		DeviceID:     device.ID,
		MachineID:    grant.MachineID,
		ConnectorID:  grant.ConnectorID,
		AssignmentID: grant.AssignmentID,
	})
	if errors.Is(err, context.Canceled) {
		// The viewer left while the connector was being asked; nobody reads this answer, and it is no server error.
		return nil, errViewerLeft
	}
	if err != nil {
		return nil, err
	}
	// Re-authorization repeats the whole decision: the device credential is still valid for this player and the
	// display may still watch the same camera through the same assignment.
	reauthorize := func(ctx context.Context) error {
		current, err := s.managedDevices.Authenticate(ctx, token)
		if err != nil {
			return err
		}
		if current == nil || current.ID != device.ID || !current.IsSignagePlayer() {
			return apperror.Unauthenticated
		}
		again, err := s.signage.AuthorizeCamera(ctx, device.ID, machineID)
		if err != nil {
			return err
		}
		if again != grant {
			return apperror.New(http.StatusNotFound, "camera_not_found", "The camera moved to another assignment")
		}
		return nil
	}
	return websocketUpgrade(func(w http.ResponseWriter) {
		conn := s.upgradeWebsocket(w, r, cookieAuthenticated)
		if conn == nil {
			session.Abort()
			return
		}
		session.Relay(conn, reauthorize)
	}), nil
}

// streamingConnector returns the authenticated connector of a relay request; only active connectors take part.
func streamingConnector(ctx context.Context) (printerconnectors.Context, *http.Request, error) {
	connector, err := printerConnectorContext(ctx)
	if err != nil {
		return printerconnectors.Context{}, nil, err
	}
	if connector.Lifecycle != printerconnectors.LifecycleActive {
		return printerconnectors.Context{}, nil, apperror.New(
			http.StatusForbidden,
			"printer_connector_inactive",
			"Connector is not active",
		)
	}
	r, err := rawRequest(ctx)
	if err != nil {
		return printerconnectors.Context{}, nil, err
	}
	if !websocket.IsWebSocketUpgrade(r) {
		return printerconnectors.Context{}, nil, errWebsocketRequired
	}
	return connector, r, nil
}

func (s *Server) ConnectPrinterConnectorStreamControl(
	ctx context.Context,
	_ openapi.ConnectPrinterConnectorStreamControlRequestObject,
) (openapi.ConnectPrinterConnectorStreamControlResponseObject, error) {
	connector, r, err := streamingConnector(ctx)
	if err != nil {
		return nil, err
	}
	// The authentication middleware verified this bearer token; re-checking it ends the control channel once the
	// credential is revoked or expires, or the connector is disabled or revoked.
	_, token, _ := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
	token = strings.TrimSpace(token)
	recheck := func(ctx context.Context) error {
		current, err := s.printerConnectors.Authenticate(ctx, token)
		if err != nil {
			return err
		}
		if current == nil || current.ID != connector.ID || current.Lifecycle != printerconnectors.LifecycleActive {
			return apperror.Unauthenticated
		}
		return nil
	}
	return websocketUpgrade(func(w http.ResponseWriter) {
		if conn := s.upgradeWebsocket(w, r, false); conn != nil {
			s.cameraRelay.ServeControl(connector.ID, conn, recheck)
		}
	}), nil
}

func (s *Server) AcceptPrinterConnectorStreamSession(
	ctx context.Context,
	request openapi.AcceptPrinterConnectorStreamSessionRequestObject,
) (openapi.AcceptPrinterConnectorStreamSessionResponseObject, error) {
	connector, r, err := streamingConnector(ctx)
	if err != nil {
		return nil, err
	}
	claim, err := s.cameraRelay.Claim(connector.ID, request.SessionId)
	if err != nil {
		return nil, err
	}
	return websocketUpgrade(func(w http.ResponseWriter) {
		conn := s.upgradeWebsocket(w, r, false)
		if conn == nil {
			claim.Release()
			return
		}
		claim.Deliver(conn)
	}), nil
}
