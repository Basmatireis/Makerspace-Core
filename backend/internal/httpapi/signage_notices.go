package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
)

// Notices of notification rules -------------------------------------------------------------------------------

func signageNoticeSelectionDTO(selection signage.NoticeSelection) openapi.SignageNoticeSelection {
	return openapi.SignageNoticeSelection{AllRules: selection.AllRules, RuleIds: append([]openapi.UUIDv7{}, selection.RuleIDs...)}
}

func signageNoticeSelectionInput(body *openapi.SignageNoticeSelection) (signage.NoticeSelection, error) {
	if body == nil {
		return signage.NoticeSelection{}, invalidRequest("request body is required")
	}
	return signage.NoticeSelection{AllRules: body.AllRules, RuleIDs: body.RuleIds}, nil
}

func (s *Server) ListSignageNotificationRules(
	ctx context.Context,
	_ openapi.ListSignageNotificationRulesRequestObject,
) (openapi.ListSignageNotificationRulesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	rules, err := s.signage.ListNotificationRules(ctx, p)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SignageNotificationRule, 0, len(rules))
	for _, rule := range rules {
		items = append(items, openapi.SignageNotificationRule{
			Id: rule.ID, Name: rule.Name, Enabled: rule.Enabled, HasSignageAction: rule.HasSignageAction,
		})
	}
	return openapi.ListSignageNotificationRules200JSONResponse{Items: items}, nil
}

func (s *Server) GetSignageDisplayNotices(
	ctx context.Context,
	r openapi.GetSignageDisplayNoticesRequestObject,
) (openapi.GetSignageDisplayNoticesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	selection, err := s.signage.DisplayNotices(ctx, p, r.DisplayId)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageDisplayNotices200JSONResponse(signageNoticeSelectionDTO(selection)), nil
}

func (s *Server) SetSignageDisplayNotices(
	ctx context.Context,
	r openapi.SetSignageDisplayNoticesRequestObject,
) (openapi.SetSignageDisplayNoticesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	input, err := signageNoticeSelectionInput(r.Body)
	if err != nil {
		return nil, err
	}
	selection, err := s.signage.SetDisplayNotices(ctx, p, r.DisplayId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetSignageDisplayNotices200JSONResponse(signageNoticeSelectionDTO(selection)), nil
}

func (s *Server) GetSignageGroupNotices(
	ctx context.Context,
	r openapi.GetSignageGroupNoticesRequestObject,
) (openapi.GetSignageGroupNoticesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	selection, err := s.signage.GroupNotices(ctx, p, r.GroupId)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageGroupNotices200JSONResponse(signageNoticeSelectionDTO(selection)), nil
}

func (s *Server) SetSignageGroupNotices(
	ctx context.Context,
	r openapi.SetSignageGroupNoticesRequestObject,
) (openapi.SetSignageGroupNoticesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	input, err := signageNoticeSelectionInput(r.Body)
	if err != nil {
		return nil, err
	}
	selection, err := s.signage.SetGroupNotices(ctx, p, r.GroupId, input, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetSignageGroupNotices200JSONResponse(signageNoticeSelectionDTO(selection)), nil
}
