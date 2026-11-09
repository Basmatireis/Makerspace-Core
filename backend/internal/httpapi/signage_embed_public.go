package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/camerarelay"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ratelimit"
	"github.com/gorilla/websocket"
)

// The public web embed endpoints are limited per client address (a limiter bounded in memory, see ratelimit). One
// page load fetches the manifest and every asset, then polls live data every 30 seconds and the manifest every
// minute; schools and companies put many visitors behind one address, so the limit is generous.
const (
	signageEmbedRequestsPerWindow = 600
	signageEmbedWindow            = time.Minute
)

// signageEmbedBase is the path prefix of one embed's public endpoints.
func signageEmbedBase(key string) string {
	return apiBasePath + "/public/signage/embeds/" + key
}

func (s *Server) allowSignageEmbedRequest(ctx context.Context) error {
	if !s.signageEmbedReads.Take(ratelimit.KeyForIP(sourceAddress(ctx)), time.Now().UTC()) {
		return apperror.RateLimited("rate_limited", "Too many requests, try again shortly", signageEmbedWindow)
	}
	return nil
}

func (s *Server) GetSignageEmbedFramePolicy(
	ctx context.Context,
	r openapi.GetSignageEmbedFramePolicyRequestObject,
) (openapi.GetSignageEmbedFramePolicyResponseObject, error) {
	if err := s.allowSignageEmbedRequest(ctx); err != nil {
		return nil, err
	}
	ancestors, err := s.signage.EmbedFrameAncestors(ctx, r.EmbedKey)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageEmbedFramePolicy200JSONResponse{
		Body: openapi.SignageEmbedFramePolicy{FrameAncestors: ancestors},
		Headers: openapi.GetSignageEmbedFramePolicy200ResponseHeaders{
			CacheControl: "no-store", XEmbedFrameAncestors: ancestors,
		},
	}, nil
}

func (s *Server) GetSignageEmbedManifest(
	ctx context.Context,
	r openapi.GetSignageEmbedManifestRequestObject,
) (openapi.GetSignageEmbedManifestResponseObject, error) {
	if err := s.allowSignageEmbedRequest(ctx); err != nil {
		return nil, err
	}
	embed, manifest, unchanged, err := s.signage.EmbedManifest(ctx, r.EmbedKey, r.Params.Known)
	if err != nil {
		return nil, err
	}
	body := openapi.SignageEmbedManifestResponse{
		Embed: openapi.SignageEmbedSettings{
			Enabled: embed.Enabled, OpenDirectly: embed.OpenDirectly, AspectRatio: signageAspectRatioDTO(embed.AspectRatio),
		},
		Unchanged: unchanged,
	}
	if manifest != nil {
		dto, err := signageManifestDTO(*manifest, signageEmbedBase(r.EmbedKey))
		if err != nil {
			return nil, err
		}
		body.Manifest = &dto
	}
	return openapi.GetSignageEmbedManifest200JSONResponse{
		Body:    body,
		Headers: openapi.GetSignageEmbedManifest200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) GetSignageEmbedLive(
	ctx context.Context,
	r openapi.GetSignageEmbedLiveRequestObject,
) (openapi.GetSignageEmbedLiveResponseObject, error) {
	if err := s.allowSignageEmbedRequest(ctx); err != nil {
		return nil, err
	}
	live, err := s.signage.EmbedLive(ctx, r.EmbedKey)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageEmbedLive200JSONResponse{
		Body:    signageLiveDTO(live, signageEmbedBase(r.EmbedKey)),
		Headers: openapi.GetSignageEmbedLive200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (response signagePlayerAssetResponse) VisitGetSignageEmbedAssetResponse(w http.ResponseWriter) error {
	return response.VisitGetSignagePlayerAssetResponse(w)
}

func (s *Server) GetSignageEmbedAsset(
	ctx context.Context,
	r openapi.GetSignageEmbedAssetRequestObject,
) (openapi.GetSignageEmbedAssetResponseObject, error) {
	if err := s.allowSignageEmbedRequest(ctx); err != nil {
		return nil, err
	}
	file, err := s.signage.OpenEmbedAsset(ctx, r.EmbedKey, r.AssetId, r.Sha256)
	if err != nil {
		return nil, err
	}
	return signagePlayerAssetResponse{file: file, request: httpRequest(ctx)}, nil
}

func (response signageTimelapseResponse) VisitGetSignageEmbedTimelapseResponse(w http.ResponseWriter) error {
	return response.serve(w)
}

func (s *Server) GetSignageEmbedTimelapse(
	ctx context.Context,
	r openapi.GetSignageEmbedTimelapseRequestObject,
) (openapi.GetSignageEmbedTimelapseResponseObject, error) {
	if err := s.allowSignageEmbedRequest(ctx); err != nil {
		return nil, err
	}
	file, err := s.signage.OpenEmbedTimelapse(ctx, r.EmbedKey, r.RunId, r.Sha256)
	if err != nil {
		return nil, err
	}
	return signageTimelapseResponse{
		file:         file,
		cacheControl: "private, max-age=31536000, immutable",
		request:      httpRequest(ctx),
	}, nil
}

// StreamSignageEmbedCamera relays a camera to a web embed page. The page runs on Core's own origin inside the
// iframe, so the upgrade must carry that Origin; the embed's display id stands in for the device in the relay's
// counters, which bounds the embed's concurrent viewers by its viewer limit.
func (s *Server) StreamSignageEmbedCamera(
	ctx context.Context,
	request openapi.StreamSignageEmbedCameraRequestObject,
) (openapi.StreamSignageEmbedCameraResponseObject, error) {
	r, err := rawRequest(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.allowSignageEmbedRequest(ctx); err != nil {
		return nil, err
	}
	// Treated like a cookie-authenticated upgrade: an Origin is required and must be the public origin.
	if !s.websocketOriginAllowed(r, true) {
		return nil, apperror.New(http.StatusForbidden, "origin_invalid", "Request origin is not allowed")
	}
	if !websocket.IsWebSocketUpgrade(r) {
		return nil, errWebsocketRequired
	}
	key, machineID := request.EmbedKey, request.MachineId
	grant, err := s.signage.AuthorizeEmbedCamera(ctx, key, machineID)
	if err != nil {
		return nil, err
	}
	session, err := s.cameraRelay.Open(ctx, camerarelay.Viewer{
		DeviceID:     grant.EmbedID,
		MachineID:    grant.MachineID,
		ConnectorID:  grant.ConnectorID,
		AssignmentID: grant.AssignmentID,
		Limit:        grant.ViewerLimit,
	})
	if errors.Is(err, context.Canceled) {
		return nil, errViewerLeft
	}
	if err != nil {
		return nil, err
	}
	// Re-authorization repeats the whole decision every 15 seconds: the key still names the same switched-on embed
	// (a new key, switching the embed or its camera off and deleting it end the session) and the camera is unchanged.
	reauthorize := func(ctx context.Context) error {
		again, err := s.signage.AuthorizeEmbedCamera(ctx, key, machineID)
		if err != nil {
			return err
		}
		if again.CameraGrant != grant.CameraGrant || again.EmbedID != grant.EmbedID {
			return apperror.New(http.StatusNotFound, "camera_not_found", "The camera moved to another assignment")
		}
		return nil
	}
	return websocketUpgrade(func(w http.ResponseWriter) {
		conn := s.upgradeWebsocket(w, r, true)
		if conn == nil {
			session.Abort()
			return
		}
		session.Relay(conn, reauthorize)
	}), nil
}
