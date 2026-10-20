package httpapi

import (
	"context"
	"encoding/base64"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ratelimit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/streaminggateways"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

// streamIssuer adapts the streaming gateway service to the signage live data.
type streamIssuer struct{ gateways *streaminggateways.Service }

func (i streamIssuer) IssueStreams(
	ctx context.Context,
	displayID uuid.UUID,
	machineIDs []uuid.UUID,
) ([]signage.Stream, error) {
	streams, err := i.gateways.IssueStreams(ctx, displayID, machineIDs)
	if err != nil {
		return nil, err
	}
	result := make([]signage.Stream, 0, len(streams))
	for _, stream := range streams {
		result = append(
			result,
			signage.Stream{
				MachineID: stream.MachineID,
				WebRTCURL: stream.WebRTCURL,
				MSEURL:    stream.MSEURL,
				Ticket:    stream.Ticket,
				ExpiresAt: stream.ExpiresAt,
			},
		)
	}
	return result, nil
}

func isStreamingGatewayPath(path string) bool {
	return strings.HasPrefix(path, apiBasePath+"/streaming-gateway/")
}

func streamingGatewayContext(ctx context.Context) (streaminggateways.Context, error) {
	value, ok := ctx.Value(streamingGatewayContextKey).(streaminggateways.Context)
	if !ok {
		return streaminggateways.Context{}, apperror.Unauthenticated
	}
	return value, nil
}

func streamingGatewayEnrollmentSecret(ctx context.Context) (string, error) {
	value, ok := ctx.Value(streamingGatewayEnrollmentSecretContextKey).(string)
	if !ok || value == "" {
		return "", apperror.Unauthenticated
	}
	return value, nil
}

func streamingGatewayDTO(value streaminggateways.Gateway) openapi.StreamingGateway {
	health := nullable.NewNullNullable[openapi.StreamingGatewayHealthState]()
	if value.HealthState != nil {
		health = nullable.NewNullableWithValue(openapi.StreamingGatewayHealthState(*value.HealthState))
	}
	return openapi.StreamingGateway{
		Id:                    value.ID,
		Name:                  value.Name,
		PublicHost:            value.PublicHost,
		Lifecycle:             openapi.StreamingGatewayLifecycle(value.Lifecycle),
		ConfigurationRevision: value.ConfigurationRevision, AppliedConfigurationRevision: value.AppliedRevison,
		SoftwareVersion: nullableString(value.SoftwareVersion), ProtocolVersion: nullableValue(value.ProtocolVersion),
		HealthState:     health,
		HealthSummary:   nullableString(value.HealthSummary),
		LastHeartbeatAt: nullableValue(value.LastHeartbeatAt),
		EnrolledAt: nullableValue(
			value.EnrolledAt,
		),
		DisabledAt:          nullableValue(value.DisabledAt),
		RevokedAt:           nullableValue(value.RevokedAt),
		CredentialExpiresAt: nullableValue(value.CredentialExpiresAt),
		Version:             value.Version, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt,
	}
}

func nullableFloat32(value *float64) nullable.Nullable[float32] {
	if value == nil {
		return nullable.NewNullNullable[float32]()
	}
	return nullable.NewNullableWithValue(float32(*value))
}

func streamingCameraDTO(value streaminggateways.Camera) openapi.StreamingCamera {
	return openapi.StreamingCamera{
		Id:               value.ID,
		GatewayId:        value.GatewayID,
		GatewayName:      value.GatewayName,
		GatewayLifecycle: openapi.StreamingGatewayLifecycle(value.GatewayLifecycle),
		MachineId:        value.MachineID,
		MachineName:      value.MachineName,
		Enabled:          value.Enabled,
		Health:           openapi.StreamingCameraHealth(value.Health),
		Viewers: nullableValue(
			value.Viewers,
		), Codec: nullableString(value.Codec), Width: nullableValue(value.Width), Height: nullableValue(value.Height),
		Fps: nullableFloat32(value.FPS), ReportedAt: nullableValue(value.ReportedAt),
		Version: value.Version, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt,
	}
}

func streamingCameraListDTO(items []streaminggateways.Camera) openapi.StreamingCameraList {
	result := make([]openapi.StreamingCamera, 0, len(items))
	for _, item := range items {
		result = append(result, streamingCameraDTO(item))
	}
	return openapi.StreamingCameraList{Items: result}
}

func (s *Server) ListStreamingGateways(
	ctx context.Context,
	_ openapi.ListStreamingGatewaysRequestObject,
) (openapi.ListStreamingGatewaysResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.streamingGateways.List(ctx, principal)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.StreamingGateway, 0, len(items))
	for _, item := range items {
		result = append(result, streamingGatewayDTO(item))
	}
	return openapi.ListStreamingGateways200JSONResponse{Items: result}, nil
}

func (s *Server) CreateStreamingGateway(
	ctx context.Context,
	request openapi.CreateStreamingGatewayRequestObject,
) (openapi.CreateStreamingGatewayResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.streamingGateways.Create(
		ctx,
		principal,
		request.Body.Name,
		request.Body.PublicHost,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateStreamingGateway201JSONResponse(streamingGatewayDTO(item)), nil
}

func (s *Server) GetStreamingGateway(
	ctx context.Context,
	request openapi.GetStreamingGatewayRequestObject,
) (openapi.GetStreamingGatewayResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.streamingGateways.Get(ctx, principal, request.StreamingGatewayId)
	if err != nil {
		return nil, err
	}
	return openapi.GetStreamingGateway200JSONResponse(streamingGatewayDTO(item)), nil
}

func (s *Server) UpdateStreamingGateway(
	ctx context.Context,
	request openapi.UpdateStreamingGatewayRequestObject,
) (openapi.UpdateStreamingGatewayResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.streamingGateways.Update(
		ctx,
		principal,
		request.StreamingGatewayId,
		request.Body.Name,
		request.Body.PublicHost,
		request.Body.Enabled,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateStreamingGateway200JSONResponse(streamingGatewayDTO(item)), nil
}

func (s *Server) DeleteStreamingGateway(
	ctx context.Context,
	request openapi.DeleteStreamingGatewayRequestObject,
) (openapi.DeleteStreamingGatewayResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.streamingGateways.Delete(
		ctx,
		principal,
		request.StreamingGatewayId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteStreamingGateway204Response{}, nil
}

func (s *Server) CreateStreamingGatewayEnrollment(
	ctx context.Context,
	request openapi.CreateStreamingGatewayEnrollmentRequestObject,
) (openapi.CreateStreamingGatewayEnrollmentResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	issue, err := s.streamingGateways.IssueEnrollment(ctx, principal, request.StreamingGatewayId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	secret := issue.Secret
	return openapi.CreateStreamingGatewayEnrollment201JSONResponse{
		Body: openapi.StreamingGatewayEnrollmentIssue{
			Gateway:          streamingGatewayDTO(issue.Gateway),
			EnrollmentId:     issue.ID,
			EnrollmentSecret: &secret,
			ExpiresAt:        issue.ExpiresAt,
		},
		Headers: openapi.CreateStreamingGatewayEnrollment201ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) RevokeStreamingGateway(
	ctx context.Context,
	request openapi.RevokeStreamingGatewayRequestObject,
) (openapi.RevokeStreamingGatewayResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.streamingGateways.Revoke(
		ctx,
		principal,
		request.StreamingGatewayId,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.RevokeStreamingGateway200JSONResponse(streamingGatewayDTO(item)), nil
}

func (s *Server) ListStreamingGatewayCameras(
	ctx context.Context,
	request openapi.ListStreamingGatewayCamerasRequestObject,
) (openapi.ListStreamingGatewayCamerasResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.streamingGateways.ListCameras(ctx, principal, request.StreamingGatewayId)
	if err != nil {
		return nil, err
	}
	return openapi.ListStreamingGatewayCameras200JSONResponse(streamingCameraListDTO(items)), nil
}

func (s *Server) CreateStreamingGatewayCamera(
	ctx context.Context,
	request openapi.CreateStreamingGatewayCameraRequestObject,
) (openapi.CreateStreamingGatewayCameraResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.streamingGateways.AssignCamera(
		ctx,
		principal,
		request.StreamingGatewayId,
		request.Body.MachineId,
		request.Body.Enabled,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.CreateStreamingGatewayCamera201JSONResponse(streamingCameraDTO(item)), nil
}

func (s *Server) UpdateStreamingGatewayCamera(
	ctx context.Context,
	request openapi.UpdateStreamingGatewayCameraRequestObject,
) (openapi.UpdateStreamingGatewayCameraResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.streamingGateways.UpdateCamera(
		ctx,
		principal,
		request.StreamingGatewayId,
		request.CameraId,
		request.Body.Enabled,
		request.Body.ExpectedVersion,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateStreamingGatewayCamera200JSONResponse(streamingCameraDTO(item)), nil
}

func (s *Server) DeleteStreamingGatewayCamera(
	ctx context.Context,
	request openapi.DeleteStreamingGatewayCameraRequestObject,
) (openapi.DeleteStreamingGatewayCameraResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err = s.streamingGateways.DeleteCamera(
		ctx,
		principal,
		request.StreamingGatewayId,
		request.CameraId,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.DeleteStreamingGatewayCamera204Response{}, nil
}

func (s *Server) ListLocalServiceCameras(
	ctx context.Context,
	_ openapi.ListLocalServiceCamerasRequestObject,
) (openapi.ListLocalServiceCamerasResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.streamingGateways.ListAllCameras(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.ListLocalServiceCameras200JSONResponse(streamingCameraListDTO(items)), nil
}

func (s *Server) ListCameraCandidates(
	ctx context.Context,
	_ openapi.ListCameraCandidatesRequestObject,
) (openapi.ListCameraCandidatesResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	candidates, err := s.streamingGateways.ListCameraCandidates(ctx, principal)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.CameraCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		items = append(items, openapi.CameraCandidate{Id: candidate.ID, Name: candidate.Name, Kind: candidate.Kind})
	}
	return openapi.ListCameraCandidates200JSONResponse(openapi.CameraCandidateList{Items: items}), nil
}

// ---- gateway-authenticated endpoints ----

func (s *Server) EnrollStreamingGateway(
	ctx context.Context,
	request openapi.EnrollStreamingGatewayRequestObject,
) (openapi.EnrollStreamingGatewayResponseObject, error) {
	if request.Body == nil || request.Body.CredentialSecret == nil {
		return nil, invalidRequest("request body is required")
	}
	secret, err := streamingGatewayEnrollmentSecret(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.streamingGateways.Enroll(
		ctx,
		secret,
		request.Body.CredentialId,
		*request.Body.CredentialSecret,
		request.Body.SoftwareVersion,
		request.Body.ProtocolVersion,
	)
	if err != nil {
		if apperror.IsCode(err, apperror.Unauthenticated.Code) {
			s.gatewayFailures.Take(ratelimit.KeyForIP(sourceAddress(ctx)), time.Now().UTC())
		}
		return nil, err
	}
	return openapi.EnrollStreamingGateway200JSONResponse{
		Body: openapi.StreamingGatewayEnrollmentResult{
			GatewayId:           result.Gateway.ID,
			CredentialId:        request.Body.CredentialId,
			ProtocolVersion:     streaminggateways.ProtocolVersion,
			CredentialExpiresAt: result.CredentialExpiresAt,
		},
		Headers: openapi.EnrollStreamingGateway200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) GetStreamingGatewayConfiguration(
	ctx context.Context,
	_ openapi.GetStreamingGatewayConfigurationRequestObject,
) (openapi.GetStreamingGatewayConfigurationResponseObject, error) {
	gateway, err := streamingGatewayContext(ctx)
	if err != nil {
		return nil, err
	}
	configuration, err := s.streamingGateways.Configuration(ctx, gateway)
	if err != nil {
		return nil, err
	}
	keys := make([]openapi.StreamingGatewayTicketKey, 0, len(configuration.TicketPublicKeys))
	for _, key := range configuration.TicketPublicKeys {
		keys = append(
			keys,
			openapi.StreamingGatewayTicketKey{
				Kid:        key.KeyID,
				PublicKey:  base64.RawURLEncoding.EncodeToString(key.PublicKey),
				ValidUntil: nullableValue(key.ValidUntil),
			},
		)
	}
	cameras := make([]openapi.StreamingGatewayConfigCamera, 0, len(configuration.Cameras))
	for _, camera := range configuration.Cameras {
		source := camera.SourceURL
		cameras = append(
			cameras,
			openapi.StreamingGatewayConfigCamera{
				MachineId:  camera.MachineID,
				Name:       camera.Name,
				StreamName: camera.StreamName,
				SourceUrl:  &source,
			},
		)
	}
	revoked := configuration.RevokedDisplays
	if revoked == nil {
		revoked = []uuid.UUID{}
	}
	return openapi.GetStreamingGatewayConfiguration200JSONResponse{
		Body: openapi.StreamingGatewayConfiguration{
			Revision:          configuration.Revision,
			ProtocolVersion:   configuration.ProtocolVersion,
			PublicHost:        configuration.PublicHost,
			TicketPublicKeys:  keys,
			Cameras:           cameras,
			SessionEpoch:      configuration.SessionEpoch,
			RevokedDisplayIds: revoked,
		},
		Headers: openapi.GetStreamingGatewayConfiguration200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) ReportStreamingGatewayHeartbeat(
	ctx context.Context,
	request openapi.ReportStreamingGatewayHeartbeatRequestObject,
) (openapi.ReportStreamingGatewayHeartbeatResponseObject, error) {
	gateway, err := streamingGatewayContext(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	cameras := make([]streaminggateways.CameraHealth, 0, len(request.Body.Cameras))
	for _, camera := range request.Body.Cameras {
		var fps *float64
		if value, ok := nullableFloat32Pointer(camera.Fps); ok {
			fps = &value
		}
		cameras = append(
			cameras,
			streaminggateways.CameraHealth{
				MachineID: camera.MachineId,
				Health:    streaminggateways.CameraStatus(camera.Health),
				Viewers:   camera.Viewers,
				Codec: nullableStringPointer(
					camera.Codec,
				),
				Width:  nullableIntPointer(camera.Width),
				Height: nullableIntPointer(camera.Height),
				FPS:    fps,
			},
		)
	}
	item, err := s.streamingGateways.Heartbeat(ctx, gateway, streaminggateways.Heartbeat{
		SoftwareVersion:              request.Body.SoftwareVersion,
		ProtocolVersion:              request.Body.ProtocolVersion,
		AppliedConfigurationRevision: request.Body.AppliedConfigurationRevision,
		HealthState: streaminggateways.HealthState(
			request.Body.HealthState,
		), HealthSummary: nullableStringPointer(request.Body.HealthSummary), Cameras: cameras,
	})
	if err != nil {
		return nil, err
	}
	return openapi.ReportStreamingGatewayHeartbeat200JSONResponse(streamingGatewayDTO(item)), nil
}

func nullableFloat32Pointer(value nullable.Nullable[float32]) (float64, bool) {
	if !value.IsSpecified() || value.IsNull() {
		return 0, false
	}
	return float64(value.GetOrEmpty()), true
}

func nullableIntPointer(value nullable.Nullable[int]) *int {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	result := value.GetOrEmpty()
	return &result
}

func (s *Server) RotateStreamingGatewayCredential(
	ctx context.Context,
	request openapi.RotateStreamingGatewayCredentialRequestObject,
) (openapi.RotateStreamingGatewayCredentialResponseObject, error) {
	gateway, err := streamingGatewayContext(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil || request.Body.CredentialSecret == nil {
		return nil, invalidRequest("request body is required")
	}
	expires, err := s.streamingGateways.RotateCredential(
		ctx,
		gateway,
		request.Body.CredentialId,
		*request.Body.CredentialSecret,
	)
	if err != nil {
		return nil, err
	}
	return openapi.RotateStreamingGatewayCredential200JSONResponse{
		Body: openapi.StreamingGatewayEnrollmentResult{
			GatewayId:           gateway.ID,
			CredentialId:        request.Body.CredentialId,
			ProtocolVersion:     streaminggateways.ProtocolVersion,
			CredentialExpiresAt: expires,
		},
		Headers: openapi.RotateStreamingGatewayCredential200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) RotateStreamTicketKey(
	ctx context.Context,
	_ openapi.RotateStreamTicketKeyRequestObject,
) (openapi.RotateStreamTicketKeyResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	rotation, err := s.streamingGateways.RotateTicketKey(ctx, principal, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RotateStreamTicketKey202JSONResponse{
		Body:    openapi.StreamTicketKeyRotation{KeyId: rotation.KeyID, ActivatesAt: rotation.ActivatesAt},
		Headers: openapi.RotateStreamTicketKey202ResponseHeaders{CacheControl: "no-store"},
	}, nil
}
