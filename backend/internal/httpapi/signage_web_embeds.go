package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

// Interim: the web embed operations refuse every caller until their service exists.
var errWebEmbedsNotReady = apperror.PermissionDenied

func (s *Server) ListSignageWebEmbeds(
	context.Context,
	openapi.ListSignageWebEmbedsRequestObject,
) (openapi.ListSignageWebEmbedsResponseObject, error) {
	return nil, errWebEmbedsNotReady
}

func (s *Server) CreateSignageWebEmbed(
	context.Context,
	openapi.CreateSignageWebEmbedRequestObject,
) (openapi.CreateSignageWebEmbedResponseObject, error) {
	return nil, errWebEmbedsNotReady
}

func (s *Server) DeleteSignageWebEmbed(
	context.Context,
	openapi.DeleteSignageWebEmbedRequestObject,
) (openapi.DeleteSignageWebEmbedResponseObject, error) {
	return nil, errWebEmbedsNotReady
}

func (s *Server) GetSignageWebEmbed(
	context.Context,
	openapi.GetSignageWebEmbedRequestObject,
) (openapi.GetSignageWebEmbedResponseObject, error) {
	return nil, errWebEmbedsNotReady
}

func (s *Server) UpdateSignageWebEmbed(
	context.Context,
	openapi.UpdateSignageWebEmbedRequestObject,
) (openapi.UpdateSignageWebEmbedResponseObject, error) {
	return nil, errWebEmbedsNotReady
}

func (s *Server) PublishSignageWebEmbed(
	context.Context,
	openapi.PublishSignageWebEmbedRequestObject,
) (openapi.PublishSignageWebEmbedResponseObject, error) {
	return nil, errWebEmbedsNotReady
}

func (s *Server) RotateSignageWebEmbedKey(
	context.Context,
	openapi.RotateSignageWebEmbedKeyRequestObject,
) (openapi.RotateSignageWebEmbedKeyResponseObject, error) {
	return nil, errWebEmbedsNotReady
}
