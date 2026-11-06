package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/google/uuid"
)

// offerDevice resolves the attendance terminal of the request; the survey-offer endpoints work for nothing else.
func (s *Server) offerDevice(ctx context.Context) (manageddevices.DeviceContext, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return manageddevices.DeviceContext{}, err
	}
	if _, err = s.attendance.KioskContext(ctx, device); err != nil {
		return manageddevices.DeviceContext{}, err
	}
	return device, nil
}

func (s *Server) TerminalSurveyOfferAnswerNow(
	ctx context.Context,
	request openapi.TerminalSurveyOfferAnswerNowRequestObject,
) (openapi.TerminalSurveyOfferAnswerNowResponseObject, error) {
	device, err := s.offerDevice(ctx)
	if err != nil {
		return nil, err
	}
	value, err := s.surveys.OfferedSurvey(ctx, device.ID, request.Token)
	if err != nil {
		return nil, err
	}
	return openapi.TerminalSurveyOfferAnswerNow200JSONResponse{
		Body:    publicSurveyDTO(value),
		Headers: openapi.TerminalSurveyOfferAnswerNow200ResponseHeaders{CacheControl: "private, no-store"},
	}, nil
}

func (s *Server) TerminalSurveyOfferSubmit(
	ctx context.Context,
	request openapi.TerminalSurveyOfferSubmitRequestObject,
) (openapi.TerminalSurveyOfferSubmitResponseObject, error) {
	device, err := s.offerDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.surveys.SubmitOffered(ctx, device.ID, request.Token, surveyAnswers(*request.Body)); err != nil {
		return nil, err
	}
	return openapi.TerminalSurveyOfferSubmit204Response{}, nil
}

func (s *Server) TerminalSurveyOfferSendEmail(
	ctx context.Context,
	request openapi.TerminalSurveyOfferSendEmailRequestObject,
) (openapi.TerminalSurveyOfferSendEmailResponseObject, error) {
	device, err := s.offerDevice(ctx)
	if err != nil {
		return nil, err
	}
	if err = s.surveys.SendOfferedByEmail(ctx, device.ID, request.Token, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.TerminalSurveyOfferSendEmail204Response{}, nil
}

func (s *Server) TerminalSurveyOfferDecline(
	ctx context.Context,
	request openapi.TerminalSurveyOfferDeclineRequestObject,
) (openapi.TerminalSurveyOfferDeclineResponseObject, error) {
	device, err := s.offerDevice(ctx)
	if err != nil {
		return nil, err
	}
	if err = s.surveys.DeclineOffered(ctx, device.ID, request.Token, false, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.TerminalSurveyOfferDecline204Response{}, nil
}

func (s *Server) TerminalSurveyOfferNever(
	ctx context.Context,
	request openapi.TerminalSurveyOfferNeverRequestObject,
) (openapi.TerminalSurveyOfferNeverResponseObject, error) {
	device, err := s.offerDevice(ctx)
	if err != nil {
		return nil, err
	}
	if err = s.surveys.DeclineOffered(ctx, device.ID, request.Token, true, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.TerminalSurveyOfferNever204Response{}, nil
}

// TerminalAnswerConsents stores the consent answers of the person who just checked in at this tablet.
func (s *Server) TerminalAnswerConsents(
	ctx context.Context,
	request openapi.TerminalAnswerConsentsRequestObject,
) (openapi.TerminalAnswerConsentsResponseObject, error) {
	device, err := kioskDevice(ctx)
	if err != nil {
		return nil, err
	}
	if request.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	personID, accountID, err := s.attendance.ConsentTarget(ctx, device, request.Body.VisitId)
	if err != nil {
		return nil, err
	}
	answers := make([]notifyrules.ConsentAnswer, len(request.Body.Answers))
	for i, answer := range request.Body.Answers {
		answers[i] = notifyrules.ConsentAnswer{CategoryID: answer.CategoryId, Granted: answer.Granted}
	}
	principal := authorization.Principal{PersonID: personID, AccountID: accountID}
	if _, err = s.notifyRules.AnswerConsents(
		ctx, principal, answers, notifyrules.PlaceKiosk, &device.ID, requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.TerminalAnswerConsents204Response{}, nil
}

// consentForCheckIn adds the consent questions that are still open for the person to the answer of a tablet check-in.
// Like the notices, a failure only leaves them out: the check-in has happened.
func (s *Server) consentForCheckIn(ctx context.Context, personID uuid.UUID, visit *openapi.Visit) {
	pending, err := s.notifyRules.PendingConsents(ctx, personID)
	if err != nil {
		s.logger.WarnContext(ctx, "read pending consents", "error", err)
		return
	}
	required := len(pending) > 0
	visit.ConsentRequired = &required
	if !required {
		return
	}
	categories := make([]openapi.TerminalConsentCategory, len(pending))
	for i, category := range pending {
		categories[i] = openapi.TerminalConsentCategory{
			Id: category.ID, Name: category.Name, Description: category.Description,
			Basis: openapi.TerminalConsentCategoryBasis(category.Basis),
		}
	}
	visit.ConsentCategories = &categories
}

func surveyOfferDTO(offer *surveys.Offer) *openapi.TerminalSurveyOffer {
	if offer == nil {
		return nil
	}
	return &openapi.TerminalSurveyOffer{
		OfferToken: offer.Token, SurveyName: offer.SurveyName, QuestionCount: offer.QuestionCount,
		Anonymous: offer.Anonymous, CanAnswerNow: offer.CanAnswerNow, CanSendByEmail: offer.CanSendByEmail,
		ExpiresAt: offer.ExpiresAt,
	}
}
