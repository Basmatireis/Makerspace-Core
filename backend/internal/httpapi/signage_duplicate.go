package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

// sceneFontOrDefault is the font family of a create request; omitted means the default sans.
func sceneFontOrDefault(value *openapi.SignageSceneFontFamily) string {
	if value == nil {
		return string(openapi.SignageSceneFontFamilySans)
	}
	return string(*value)
}

func (s *Server) DuplicateSignageScene(
	ctx context.Context,
	r openapi.DuplicateSignageSceneRequestObject,
) (openapi.DuplicateSignageSceneResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	scene, err := s.signage.DuplicateScene(ctx, p, r.SceneId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := signageSceneDTO(scene)
	if err != nil {
		return nil, err
	}
	return openapi.DuplicateSignageScene201JSONResponse(dto), nil
}

func (s *Server) DuplicateSignageAnnouncementTemplate(
	ctx context.Context,
	r openapi.DuplicateSignageAnnouncementTemplateRequestObject,
) (openapi.DuplicateSignageAnnouncementTemplateResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	template, err := s.signage.DuplicateTemplate(ctx, p, r.TemplateId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.DuplicateSignageAnnouncementTemplate201JSONResponse(signageTemplateDTO(template)), nil
}

func (s *Server) DuplicateSignageCustomLayout(
	ctx context.Context,
	r openapi.DuplicateSignageCustomLayoutRequestObject,
) (openapi.DuplicateSignageCustomLayoutResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	layout, err := s.signage.DuplicateCustomLayout(ctx, p, r.CustomLayoutId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.DuplicateSignageCustomLayout201JSONResponse(signageCustomLayoutDTO(layout)), nil
}
