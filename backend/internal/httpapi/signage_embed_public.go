package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

// Interim: the public web embed operations answer 501 until their service exists.

func (s *Server) GetSignageEmbedAsset(
	context.Context,
	openapi.GetSignageEmbedAssetRequestObject,
) (openapi.GetSignageEmbedAssetResponseObject, error) {
	return nil, errWebEmbedsNotReady
}

func (s *Server) StreamSignageEmbedCamera(
	context.Context,
	openapi.StreamSignageEmbedCameraRequestObject,
) (openapi.StreamSignageEmbedCameraResponseObject, error) {
	return nil, errWebEmbedsNotReady
}

func (s *Server) GetSignageEmbedFramePolicy(
	context.Context,
	openapi.GetSignageEmbedFramePolicyRequestObject,
) (openapi.GetSignageEmbedFramePolicyResponseObject, error) {
	return nil, errWebEmbedsNotReady
}

func (s *Server) GetSignageEmbedLive(
	context.Context,
	openapi.GetSignageEmbedLiveRequestObject,
) (openapi.GetSignageEmbedLiveResponseObject, error) {
	return nil, errWebEmbedsNotReady
}

func (s *Server) GetSignageEmbedManifest(
	context.Context,
	openapi.GetSignageEmbedManifestRequestObject,
) (openapi.GetSignageEmbedManifestResponseObject, error) {
	return nil, errWebEmbedsNotReady
}

func (s *Server) GetSignageEmbedTimelapse(
	context.Context,
	openapi.GetSignageEmbedTimelapseRequestObject,
) (openapi.GetSignageEmbedTimelapseResponseObject, error) {
	return nil, errWebEmbedsNotReady
}
