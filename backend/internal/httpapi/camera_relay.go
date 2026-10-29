package httpapi

import (
	"context"
	"net/http"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

// The camera relay websocket operations are part of the contract but not wired yet: they answer 501
// until the relay hub replaces these handlers.
var errCameraRelayNotImplemented = apperror.New(
	http.StatusNotImplemented,
	"not_implemented",
	"The camera relay is not available yet",
)

func (s *Server) StreamSignagePlayerCamera(
	_ context.Context,
	_ openapi.StreamSignagePlayerCameraRequestObject,
) (openapi.StreamSignagePlayerCameraResponseObject, error) {
	return nil, errCameraRelayNotImplemented
}

func (s *Server) ConnectPrinterConnectorStreamControl(
	_ context.Context,
	_ openapi.ConnectPrinterConnectorStreamControlRequestObject,
) (openapi.ConnectPrinterConnectorStreamControlResponseObject, error) {
	return nil, errCameraRelayNotImplemented
}

func (s *Server) AcceptPrinterConnectorStreamSession(
	_ context.Context,
	_ openapi.AcceptPrinterConnectorStreamSessionRequestObject,
) (openapi.AcceptPrinterConnectorStreamSessionResponseObject, error) {
	return nil, errCameraRelayNotImplemented
}
