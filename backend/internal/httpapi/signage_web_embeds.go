package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/google/uuid"
)

// signageEmbedURL is the absolute address of an embed page for the iframe's src.
func (s *Server) signageEmbedURL(key string) string {
	return s.config.PublicBaseURL.Scheme + "://" + s.config.PublicBaseURL.Host + "/embed/" + key
}

func (s *Server) signageWebEmbedDTO(embed signage.WebEmbed) openapi.SignageWebEmbed {
	machines := embed.CameraMachineIDs
	if machines == nil {
		machines = []uuid.UUID{}
	}
	return openapi.SignageWebEmbed{
		Id:                    embed.ID,
		Name:                  embed.Name,
		AspectRatio:           signageAspectRatioDTO(embed.AspectRatio),
		GroupId:               nullableUUIDValue(embed.GroupID),
		DefaultScenes:         signageSceneListDTO(embed.DefaultScenes),
		EmbedKey:              embed.EmbedKey,
		EmbedUrl:              s.signageEmbedURL(embed.EmbedKey),
		AllowedOrigins:        nonNilStrings(embed.AllowedOrigins),
		OpenDirectly:          embed.OpenDirectly,
		Enabled:               embed.Enabled,
		CameraEnabled:         embed.CameraEnabled,
		CameraMachineIds:      machines,
		CameraViewerLimit:     embed.CameraViewerLimit,
		TimelapseEnabled:      embed.TimelapseEnabled,
		TimelapseCount:        embed.TimelapseCount,
		TimelapseMaxAgeDays:   embed.TimelapseMaxAgeDays,
		PublishedRevision:     nullableValue(embed.PublishedRevision),
		PublishedAt:           nullableTimeValue(embed.PublishedAt),
		PendingChanges:        signagePendingChangesDTO(embed.PendingChanges),
		HasUnpublishedChanges: embed.HasUnpublishedChanges(),
		LastLoadedAt:          nullableTimeValue(embed.LastLoadedAt),
		LoadsToday:            embed.LoadsToday,
		Version:               embed.Version,
		CreatedAt:             embed.CreatedAt,
		UpdatedAt:             embed.UpdatedAt,
	}
}

func (s *Server) ListSignageWebEmbeds(
	ctx context.Context,
	_ openapi.ListSignageWebEmbedsRequestObject,
) (openapi.ListSignageWebEmbedsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	embeds, err := s.signage.ListWebEmbeds(ctx, p)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SignageWebEmbed, 0, len(embeds))
	for _, embed := range embeds {
		items = append(items, s.signageWebEmbedDTO(embed))
	}
	return openapi.ListSignageWebEmbeds200JSONResponse{Items: items}, nil
}

func (s *Server) GetSignageWebEmbed(
	ctx context.Context,
	r openapi.GetSignageWebEmbedRequestObject,
) (openapi.GetSignageWebEmbedResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	embed, err := s.signage.GetWebEmbed(ctx, p, r.EmbedId)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageWebEmbed200JSONResponse(s.signageWebEmbedDTO(embed)), nil
}

func (s *Server) CreateSignageWebEmbed(
	ctx context.Context,
	r openapi.CreateSignageWebEmbedRequestObject,
) (openapi.CreateSignageWebEmbedResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	var defaults []signage.SceneListItem
	if r.Body.DefaultScenes != nil {
		defaults = signageSceneList(*r.Body.DefaultScenes)
	}
	embed, err := s.signage.CreateWebEmbed(ctx, p, signage.WebEmbedInput{
		Name:           r.Body.Name,
		AspectRatio:    signageAspectRatio(r.Body.AspectRatio),
		AllowedOrigins: r.Body.AllowedOrigins,
		GroupID:        nullableToPointer(r.Body.GroupId),
		DefaultScenes:  defaults,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateSignageWebEmbed201JSONResponse(s.signageWebEmbedDTO(embed)), nil
}

func (s *Server) UpdateSignageWebEmbed(
	ctx context.Context,
	r openapi.UpdateSignageWebEmbedRequestObject,
) (openapi.UpdateSignageWebEmbedResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	body := r.Body
	patch := signage.WebEmbedPatch{
		Name:                body.Name,
		GroupSet:            body.GroupId.IsSpecified(),
		GroupID:             nullableToPointer(body.GroupId),
		AllowedOrigins:      body.AllowedOrigins,
		OpenDirectly:        body.OpenDirectly,
		Enabled:             body.Enabled,
		CameraEnabled:       body.CameraEnabled,
		CameraMachineIDs:    body.CameraMachineIds,
		CameraViewerLimit:   body.CameraViewerLimit,
		TimelapseEnabled:    body.TimelapseEnabled,
		TimelapseCount:      body.TimelapseCount,
		TimelapseMaxAgeDays: body.TimelapseMaxAgeDays,
	}
	if body.AspectRatio != nil {
		ratio := signageAspectRatio(*body.AspectRatio)
		patch.AspectRatio = &ratio
	}
	if body.DefaultScenes != nil {
		defaults := signageSceneList(*body.DefaultScenes)
		patch.DefaultScenes = &defaults
	}
	embed, err := s.signage.UpdateWebEmbed(ctx, p, r.EmbedId, body.ExpectedVersion, patch, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSignageWebEmbed200JSONResponse(s.signageWebEmbedDTO(embed)), nil
}

func (s *Server) RotateSignageWebEmbedKey(
	ctx context.Context,
	r openapi.RotateSignageWebEmbedKeyRequestObject,
) (openapi.RotateSignageWebEmbedKeyResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	embed, err := s.signage.RotateWebEmbedKey(ctx, p, r.EmbedId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RotateSignageWebEmbedKey200JSONResponse(s.signageWebEmbedDTO(embed)), nil
}

func (s *Server) DeleteSignageWebEmbed(
	ctx context.Context,
	r openapi.DeleteSignageWebEmbedRequestObject,
) (openapi.DeleteSignageWebEmbedResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.signage.DeleteWebEmbed(ctx, p, r.EmbedId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteSignageWebEmbed204Response{}, nil
}

func (s *Server) PublishSignageWebEmbed(
	ctx context.Context,
	r openapi.PublishSignageWebEmbedRequestObject,
) (openapi.PublishSignageWebEmbedResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	embed, err := s.signage.PublishWebEmbed(ctx, p, r.EmbedId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.PublishSignageWebEmbed200JSONResponse(s.signageWebEmbedDTO(embed)), nil
}
