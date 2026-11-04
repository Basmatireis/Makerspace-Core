package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/guides"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func guideProgressDTO(item guides.Progress) openapi.GuideProgress {
	return openapi.GuideProgress{
		GuideId: item.GuideID, Status: openapi.GuideProgressStatus(item.Status), UpdatedAt: item.UpdatedAt,
	}
}

func (s *Server) ListMyGuideProgress(
	ctx context.Context,
	_ openapi.ListMyGuideProgressRequestObject,
) (openapi.ListMyGuideProgressResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.guides.List(ctx, principal)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.GuideProgress, 0, len(result))
	for _, item := range result {
		items = append(items, guideProgressDTO(item))
	}
	return openapi.ListMyGuideProgress200JSONResponse(openapi.GuideProgressList{Items: items}), nil
}

func (s *Server) UpdateMyGuideProgress(
	ctx context.Context,
	r openapi.UpdateMyGuideProgressRequestObject,
) (openapi.UpdateMyGuideProgressResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.guides.Set(ctx, principal, r.GuideId, guides.Status(r.Body.Status))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateMyGuideProgress200JSONResponse(guideProgressDTO(result)), nil
}

func (s *Server) ResetMyGuideProgress(
	ctx context.Context,
	_ openapi.ResetMyGuideProgressRequestObject,
) (openapi.ResetMyGuideProgressResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.guides.Reset(ctx, principal); err != nil {
		return nil, err
	}
	return openapi.ResetMyGuideProgress204Response{}, nil
}
