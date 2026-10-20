package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) GetLiveness(
	context.Context,
	openapi.GetLivenessRequestObject,
) (openapi.GetLivenessResponseObject, error) {
	return openapi.GetLiveness200JSONResponse(openapi.HealthStatus{Status: openapi.HealthStatusStatusOk}), nil
}

func (s *Server) GetReadiness(
	ctx context.Context,
	_ openapi.GetReadinessRequestObject,
) (openapi.GetReadinessResponseObject, error) {
	if err := s.pool.Ping(ctx); err != nil {
		return openapi.GetReadiness503JSONResponse( //nolint:nilerr // a failing database ping is the 503 readiness answer
			openapi.HealthStatus{Status: openapi.HealthStatusStatusUnavailable},
		), nil
	}
	return openapi.GetReadiness200JSONResponse(openapi.HealthStatus{Status: openapi.HealthStatusStatusOk}), nil
}
