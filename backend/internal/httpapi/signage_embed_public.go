package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

// Interim: the public web embed operations know no embed key until they are implemented.

func (s *Server) GetSignageEmbedAsset(
	context.Context,
	openapi.GetSignageEmbedAssetRequestObject,
) (openapi.GetSignageEmbedAssetResponseObject, error) {
	return nil, apperror.NotFound
}

func (s *Server) StreamSignageEmbedCamera(
	context.Context,
	openapi.StreamSignageEmbedCameraRequestObject,
) (openapi.StreamSignageEmbedCameraResponseObject, error) {
	return nil, apperror.NotFound
}

func (s *Server) GetSignageEmbedFramePolicy(
	context.Context,
	openapi.GetSignageEmbedFramePolicyRequestObject,
) (openapi.GetSignageEmbedFramePolicyResponseObject, error) {
	return nil, apperror.NotFound
}

func (s *Server) GetSignageEmbedLive(
	context.Context,
	openapi.GetSignageEmbedLiveRequestObject,
) (openapi.GetSignageEmbedLiveResponseObject, error) {
	return nil, apperror.NotFound
}

func (s *Server) GetSignageEmbedManifest(
	context.Context,
	openapi.GetSignageEmbedManifestRequestObject,
) (openapi.GetSignageEmbedManifestResponseObject, error) {
	return nil, apperror.NotFound
}

func (s *Server) GetSignageEmbedTimelapse(
	context.Context,
	openapi.GetSignageEmbedTimelapseRequestObject,
) (openapi.GetSignageEmbedTimelapseResponseObject, error) {
	return nil, apperror.NotFound
}
