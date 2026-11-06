package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/oapi-codegen/nullable"
)

func optionalNullable[T any](value *T) nullable.Nullable[T] {
	if value == nil {
		return nullable.NewNullNullable[T]()
	}
	return nullable.NewNullableWithValue(*value)
}

func (s *Server) ListNotifications(
	ctx context.Context,
	r openapi.ListNotificationsRequestObject,
) (openapi.ListNotificationsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	page, pageSize := 1, 0
	if r.Params.Page != nil {
		page = *r.Params.Page
	}
	if r.Params.PageSize != nil {
		pageSize = *r.Params.PageSize
	}
	result, err := s.inbox.List(ctx, p, page, pageSize)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.Notification, 0, len(result.Items))
	for _, item := range result.Items {
		items = append(items, openapi.Notification{
			Id:        item.ID,
			Kind:      openapi.NotificationKind(item.Kind),
			Level:     openapi.NotificationLevel(item.Level),
			Title:     item.Title,
			Body:      item.Body,
			Link:      optionalNullable(item.Link),
			CreatedAt: item.CreatedAt,
			ReadAt:    optionalNullable(item.ReadAt),
		})
	}
	return openapi.ListNotifications200JSONResponse(openapi.NotificationPage{
		Items: items, Page: result.Page, PageSize: result.PageSize, Total: result.Total,
		UnreadCount: result.UnreadCount,
	}), nil
}

func (s *Server) GetNotificationUnreadCount(
	ctx context.Context,
	_ openapi.GetNotificationUnreadCountRequestObject,
) (openapi.GetNotificationUnreadCountResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	poll, err := s.inbox.Poll(ctx, p)
	if err != nil {
		return nil, err
	}
	return openapi.GetNotificationUnreadCount200JSONResponse(openapi.NotificationUnreadCount{
		UnreadCount: poll.UnreadCount, Fresh: alertDTOs(poll.Fresh), Pinned: alertDTOs(poll.Pinned),
	}), nil
}

func alertDTOs(alerts []inbox.Alert) []openapi.NotificationAlert {
	result := make([]openapi.NotificationAlert, 0, len(alerts))
	for _, alert := range alerts {
		dto := openapi.NotificationAlert{
			Id:               alert.ID,
			Appearance:       openapi.NotificationAlertAppearance(alert.Appearance),
			Level:            openapi.NotificationLevel(alert.Level),
			Title:            alert.Title,
			Body:             alert.Body,
			Link:             optionalNullable(alert.Link),
			OnlyButtonCloses: alert.OnlyButtonCloses,
			AllowLater:       alert.AllowLater,
			CreatedAt:        alert.CreatedAt,
			ToastSeconds:     optionalNullable(alert.ToastSeconds),
		}
		dto.Button.Kind = openapi.NotificationAlertButtonKind(alert.Button.Kind)
		dto.Button.Label = optionalNullable(alert.Button.Label)
		dto.Button.Link = optionalNullable(alert.Button.Link)
		result = append(result, dto)
	}
	return result
}

func (s *Server) MarkNotificationSeen(
	ctx context.Context,
	r openapi.MarkNotificationSeenRequestObject,
) (openapi.MarkNotificationSeenResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.inbox.MarkSeen(ctx, p, r.NotificationId); err != nil {
		return nil, err
	}
	return openapi.MarkNotificationSeen204Response{}, nil
}

func (s *Server) AcknowledgeNotification(
	ctx context.Context,
	r openapi.AcknowledgeNotificationRequestObject,
) (openapi.AcknowledgeNotificationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.inbox.Acknowledge(ctx, p, r.NotificationId); err != nil {
		return nil, err
	}
	return openapi.AcknowledgeNotification204Response{}, nil
}

func (s *Server) PostponeNotification(
	ctx context.Context,
	r openapi.PostponeNotificationRequestObject,
) (openapi.PostponeNotificationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.inbox.Postpone(ctx, p, r.NotificationId); err != nil {
		return nil, err
	}
	return openapi.PostponeNotification204Response{}, nil
}

func (s *Server) MarkAllNotificationsRead(
	ctx context.Context,
	_ openapi.MarkAllNotificationsReadRequestObject,
) (openapi.MarkAllNotificationsReadResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.inbox.MarkAllRead(ctx, p); err != nil {
		return nil, err
	}
	return openapi.MarkAllNotificationsRead204Response{}, nil
}

func (s *Server) MarkNotificationRead(
	ctx context.Context,
	r openapi.MarkNotificationReadRequestObject,
) (openapi.MarkNotificationReadResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.inbox.MarkRead(ctx, p, r.NotificationId); err != nil {
		return nil, err
	}
	return openapi.MarkNotificationRead204Response{}, nil
}

func (s *Server) DismissNotification(
	ctx context.Context,
	r openapi.DismissNotificationRequestObject,
) (openapi.DismissNotificationResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.inbox.Dismiss(ctx, p, r.NotificationId); err != nil {
		return nil, err
	}
	return openapi.DismissNotification204Response{}, nil
}

func sentMessageDTO(item inbox.SentMessage) openapi.SentNotificationMessage {
	roles := make([]openapi.SentNotificationMessageRole, 0, len(item.Roles))
	for _, role := range item.Roles {
		roles = append(roles, openapi.SentNotificationMessageRole{Id: role.ID, Name: role.Name})
	}
	return openapi.SentNotificationMessage{
		Id:             item.ID,
		Title:          item.Title,
		Body:           item.Body,
		Link:           optionalNullable(item.Link),
		Roles:          roles,
		SenderName:     optionalNullable(item.SenderName),
		RecipientCount: item.RecipientCount,
		ReadCount:      item.ReadCount,
		CreatedAt:      item.CreatedAt,
		ExpiresAt:      item.ExpiresAt,
	}
}

func (s *Server) ListSentNotificationMessages(
	ctx context.Context,
	r openapi.ListSentNotificationMessagesRequestObject,
) (openapi.ListSentNotificationMessagesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	page, pageSize := 1, 0
	if r.Params.Page != nil {
		page = *r.Params.Page
	}
	if r.Params.PageSize != nil {
		pageSize = *r.Params.PageSize
	}
	result, err := s.inbox.ListSent(ctx, p, page, pageSize)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SentNotificationMessage, 0, len(result.Items))
	for _, item := range result.Items {
		items = append(items, sentMessageDTO(item))
	}
	return openapi.ListSentNotificationMessages200JSONResponse(openapi.SentNotificationMessagePage{
		Items: items, Page: result.Page, PageSize: result.PageSize, Total: result.Total,
	}), nil
}

func (s *Server) SendNotificationMessage(
	ctx context.Context,
	r openapi.SendNotificationMessageRequestObject,
) (openapi.SendNotificationMessageResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.inbox.SendMessage(ctx, p, inbox.MessageInput{
		Title:   r.Body.Title,
		Body:    r.Body.Body,
		Link:    nullableStringLike(r.Body.Link),
		RoleIDs: uuidSlice(r.Body.RoleIds),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SendNotificationMessage201JSONResponse(sentMessageDTO(item)), nil
}

func (s *Server) UpdateNotificationMessage(
	ctx context.Context,
	r openapi.UpdateNotificationMessageRequestObject,
) (openapi.UpdateNotificationMessageResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.inbox.UpdateMessage(ctx, p, r.MessageId, inbox.MessageUpdate{
		Title: r.Body.Title,
		Body:  r.Body.Body,
		Link:  nullableStringLike(r.Body.Link),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateNotificationMessage200JSONResponse(sentMessageDTO(item)), nil
}

func (s *Server) RetractNotificationMessage(
	ctx context.Context,
	r openapi.RetractNotificationMessageRequestObject,
) (openapi.RetractNotificationMessageResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.inbox.RetractMessage(ctx, p, r.MessageId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.RetractNotificationMessage204Response{}, nil
}
