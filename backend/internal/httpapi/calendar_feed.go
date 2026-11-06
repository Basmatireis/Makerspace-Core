package httpapi

import (
	"bytes"
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/calendarfeed"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ratelimit"
)

// The public feed is limited per client address (a limiter bounded in memory, see ratelimit). Calendar applications
// poll every few minutes at best, and hosted calendars share addresses between many people, so the limit is generous.
const (
	calendarFeedReadsPerWindow = 120
	calendarFeedWindow         = time.Minute
)

func (s *Server) GetMyCalendarFeed(
	ctx context.Context,
	_ openapi.GetMyCalendarFeedRequestObject,
) (openapi.GetMyCalendarFeedResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	status, err := s.calendarFeed.Get(ctx, principal)
	if err != nil {
		return nil, err
	}
	return openapi.GetMyCalendarFeed200JSONResponse(openapi.CalendarFeedStatus{
		Active:     status.Active,
		CreatedAt:  optionalNullable(status.CreatedAt),
		LastUsedAt: optionalNullable(status.LastUsedAt),
	}), nil
}

func (s *Server) CreateMyCalendarFeed(
	ctx context.Context,
	_ openapi.CreateMyCalendarFeedRequestObject,
) (openapi.CreateMyCalendarFeedResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	link, err := s.calendarFeed.Rotate(ctx, principal, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateMyCalendarFeed201JSONResponse(calendarFeedLinkDTO(link)), nil
}

func calendarFeedLinkDTO(link calendarfeed.Link) openapi.CalendarFeedLink {
	return openapi.CalendarFeedLink{Url: link.URL, CreatedAt: link.CreatedAt}
}

func (s *Server) RevokeMyCalendarFeed(
	ctx context.Context,
	_ openapi.RevokeMyCalendarFeedRequestObject,
) (openapi.RevokeMyCalendarFeedResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.calendarFeed.Revoke(ctx, principal, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.RevokeMyCalendarFeed204Response{}, nil
}

func (s *Server) GetCalendarFeed(
	ctx context.Context,
	request openapi.GetCalendarFeedRequestObject,
) (openapi.GetCalendarFeedResponseObject, error) {
	if !s.calendarFeedReads.Take(ratelimit.KeyForIP(sourceAddress(ctx)), time.Now().UTC()) {
		return nil, apperror.RateLimited(
			"rate_limited", "Too many calendar requests, try again shortly", calendarFeedWindow,
		)
	}
	body, err := s.calendarFeed.ICS(ctx, request.Token)
	if err != nil {
		return nil, err
	}
	return openapi.GetCalendarFeed200TextcalendarResponse{Body: bytes.NewReader(body), ContentLength: int64(len(body))}, nil
}
