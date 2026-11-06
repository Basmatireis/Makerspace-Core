package notifyrules

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ConsentRequired says whether the person still has to answer a consent category (or answer it again after its text
// changed). The frontend shows the consent form after sign-in while it is true.
func (s *Service) ConsentRequired(ctx context.Context, p authorization.Principal) (bool, error) {
	pending, err := notifyrulesdb.New(s.pool).CountPendingConsents(ctx, p.PersonID)
	if err != nil {
		return false, fmt.Errorf("count pending consents: %w", err)
	}
	return pending > 0, nil
}

// Settings returns the principal's consents, channel choices and the central rules that reach them.
func (s *Service) Settings(ctx context.Context, p authorization.Principal) (Settings, error) {
	return s.settings(ctx, notifyrulesdb.New(s.pool), p)
}

func (s *Service) settings(ctx context.Context, queries *notifyrulesdb.Queries, p authorization.Principal) (Settings, error) {
	categories, err := s.categories(ctx, queries)
	if err != nil {
		return Settings{}, fmt.Errorf("list categories: %w", err)
	}
	consents, err := queries.ListConsentsOfPerson(ctx, p.PersonID)
	if err != nil {
		return Settings{}, fmt.Errorf("list consents: %w", err)
	}
	answers := make(map[uuid.UUID]notifyrulesdb.NotificationConsent, len(consents))
	for _, consent := range consents {
		answers[consent.CategoryID] = consent
	}
	result := Settings{AskFeedbackAtCheckout: true}
	for _, category := range categories {
		entry := ConsentEntry{Category: category}
		if answer, ok := answers[category.ID]; ok {
			granted, answered := answer.Granted, answer.AnsweredAt.UTC()
			entry.Granted, entry.AnsweredAt = &granted, &answered
			entry.Current = int(answer.TextVersion) == category.TextVersion
		}
		if category.Basis == BasisRequired {
			granted := true
			entry.Granted, entry.Current = &granted, true
		}
		if category.Basis == BasisConsent && !entry.Current {
			result.ConsentPending = true
		}
		result.Consents = append(result.Consents, entry)
	}
	settings, err := queries.GetPersonSettings(ctx, p.PersonID)
	if err == nil {
		result.AskFeedbackAtCheckout = settings.AskFeedbackAtCheckout
	} else if noRows(err) != apperror.NotFound { //nolint:errorlint // sentinel returned by noRows
		return Settings{}, fmt.Errorf("load notification settings: %w", err)
	}
	if result.Rules, err = s.reachingRules(ctx, queries, p, result.Consents); err != nil {
		return Settings{}, err
	}
	return result, nil
}

// AnswerConsents records the principal's answers. Only consent categories can be answered; an answer identical to the
// stored one at the current text is ignored. Each real change writes an audit event that names the category, never
// any text.
func (s *Service) AnswerConsents(
	ctx context.Context,
	p authorization.Principal,
	answers []ConsentAnswer,
	place ConsentPlace,
	deviceID *uuid.UUID,
	requestID *uuid.UUID,
) (Settings, error) {
	if place != PlaceApp && place != PlaceKiosk && place != PlaceProfile {
		return Settings{}, apperror.InvalidField("place: must be app, kiosk or profile")
	}
	if len(answers) == 0 || len(answers) > MaxCategories {
		return Settings{}, apperror.InvalidField("answers: between 1 and 50 answers")
	}
	now := s.now()
	var result Settings
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		queries := notifyrulesdb.New(tx)
		existing, err := queries.ListConsentsOfPerson(ctx, p.PersonID)
		if err != nil {
			return err
		}
		stored := make(map[uuid.UUID]notifyrulesdb.NotificationConsent, len(existing))
		for _, consent := range existing {
			stored[consent.CategoryID] = consent
		}
		seen := map[uuid.UUID]bool{}
		for _, answer := range answers {
			if seen[answer.CategoryID] {
				return apperror.InvalidField("answers: a category is answered twice")
			}
			seen[answer.CategoryID] = true
			category, err := queries.GetCategory(ctx, answer.CategoryID)
			if err != nil {
				if noRows(err) == apperror.NotFound { //nolint:errorlint // sentinel returned by noRows
					return apperror.InvalidField("answers: unknown category")
				}
				return err
			}
			if Basis(category.Basis) != BasisConsent {
				return apperror.New(http.StatusUnprocessableEntity, "category_needs_no_consent", "This category needs no consent.")
			}
			if previous, ok := stored[answer.CategoryID]; ok && previous.Granted == answer.Granted &&
				previous.TextVersion == category.TextVersion {
				continue
			}
			if err := queries.UpsertConsent(ctx, notifyrulesdb.UpsertConsentParams{
				PersonID: p.PersonID, CategoryID: answer.CategoryID, Granted: answer.Granted,
				TextVersion: category.TextVersion, AnsweredAt: now, Place: string(place), DeviceID: deviceID,
			}); err != nil {
				return err
			}
			event := auditEvent(p, "notification_consent.answered", "notification_consent", answer.CategoryID, requestID,
				[]string{"granted"})
			if err := audit.Write(ctx, tx, event); err != nil {
				return err
			}
		}
		result, err = s.settings(ctx, queries, p)
		return err
	})
	return result, err
}

// SetRulePreference stores the principal's channel choice for a central rule. Switching both channels off mutes the
// rule, which a mandatory rule does not allow.
func (s *Service) SetRulePreference(
	ctx context.Context,
	p authorization.Principal,
	ruleID uuid.UUID,
	preference Preference,
) error {
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		queries := notifyrulesdb.New(tx)
		row, err := queries.GetRule(ctx, ruleID)
		if err != nil || row.OwnerAccountID != nil {
			return apperror.NotFound
		}
		if row.Mandatory && !preference.InApp && !preference.Email {
			return apperror.New(
				http.StatusUnprocessableEntity, "mandatory_notification", "This notification is mandatory; keep at least one channel on.",
			)
		}
		return queries.UpsertPreference(ctx, notifyrulesdb.UpsertPreferenceParams{
			AccountID: p.AccountID, RuleID: ruleID, InApp: preference.InApp, Email: preference.Email, Now: s.now(),
		})
	})
}

// SetAskFeedbackAtCheckout stores whether the tablet may offer the visit survey at check-out.
func (s *Service) SetAskFeedbackAtCheckout(ctx context.Context, p authorization.Principal, ask bool) error {
	return notifyrulesdb.New(s.pool).UpsertAskFeedbackAtCheckout(ctx, notifyrulesdb.UpsertAskFeedbackAtCheckoutParams{
		PersonID: p.PersonID, Ask: ask, Now: s.now(),
	})
}

// membershipKeys lists the dynamic recipient keys that only make sense for people with a staffing membership.
var membershipKeys = map[string][]string{
	"staffing_people":  {"supervisor", "trainee"},
	"free_supervisors": {"supervisor"},
	"supervisors_on":   {"supervisor"},
}

// reachingRules computes the central rules that notify the principal. A rule reaches a person when one of its
// in-app or e-mail actions (or escalation steps) names them directly, names a role they hold, or names a dynamic
// recipient such as "operator of the print" that can point to them; dynamic recipients that only apply to a
// staffing membership the person lacks are left out. Signage and tablet actions never reach a person. The result is
// an explanation for the screen, not the delivery decision, which the dispatcher makes per event.
func (s *Service) reachingRules(
	ctx context.Context,
	queries *notifyrulesdb.Queries,
	p authorization.Principal,
	consents []ConsentEntry,
) ([]ReachingRule, error) {
	rules, err := queries.ListEnabledCentralRules(ctx)
	if err != nil {
		return nil, fmt.Errorf("list rules: %w", err)
	}
	held, err := queries.ListHeldRoles(ctx, p.PersonID)
	if err != nil {
		return nil, fmt.Errorf("list roles: %w", err)
	}
	roleNames := map[uuid.UUID]string{}
	membership := ""
	for _, role := range held {
		roleNames[role.ID] = role.Name
		if role.SystemKey != nil && slices.Contains([]string{"supervisor", "trainee", "visitor"}, *role.SystemKey) {
			membership = *role.SystemKey
		}
	}
	preferences, err := queries.ListPreferencesOfAccount(ctx, p.AccountID)
	if err != nil {
		return nil, fmt.Errorf("list preferences: %w", err)
	}
	chosen := map[uuid.UUID]notifyrulesdb.NotificationRulePreference{}
	for _, preference := range preferences {
		chosen[preference.RuleID] = preference
	}
	granted := map[uuid.UUID]bool{}
	for _, consent := range consents {
		granted[consent.Category.ID] = consent.Category.Basis == BasisRequired ||
			(consent.Granted != nil && *consent.Granted && consent.Current)
	}
	var result []ReachingRule
	for _, row := range rules {
		definition, err := ParseDefinition(row.Definition)
		if err != nil {
			return nil, fmt.Errorf("rule %s: %w", row.ID, err)
		}
		var why []string
		var channels []Channel
		trigger, _ := LookupTrigger(definition.Trigger.Event)
		for _, action := range definition.AllActions() {
			if action.Channel != ChannelInApp && action.Channel != ChannelEmail {
				continue
			}
			reasons := reachReasons(action.Recipients, p.PersonID, roleNames, membership, trigger, definition)
			if len(reasons) == 0 {
				continue
			}
			for _, reason := range reasons {
				if !slices.Contains(why, reason) {
					why = append(why, reason)
				}
			}
			if !slices.Contains(channels, action.Channel) {
				channels = append(channels, action.Channel)
			}
		}
		if len(channels) == 0 || row.CategoryID == nil {
			continue
		}
		effective := channels
		if preference, ok := chosen[row.ID]; ok {
			effective = nil
			if preference.InApp {
				effective = append(effective, ChannelInApp)
			}
			if preference.Email {
				effective = append(effective, ChannelEmail)
			}
		}
		result = append(result, ReachingRule{
			RuleID: row.ID, Name: row.Name, Description: row.Description, CategoryID: *row.CategoryID,
			CategoryName: row.CategoryName, Mandatory: row.Mandatory, Why: why, DefaultChannels: channels,
			EffectiveChannels: effective, BlockedByConsent: !granted[*row.CategoryID],
		})
	}
	return result, nil
}

func reachReasons(
	recipients []string,
	personID uuid.UUID,
	roleNames map[uuid.UUID]string,
	membership string,
	trigger Trigger,
	definition Definition,
) []string {
	var reasons []string
	for _, recipient := range recipients {
		kind, rest, _ := strings.Cut(recipient, ":")
		switch kind {
		case "person":
			if id, err := uuid.Parse(rest); err == nil && id == personID {
				reasons = append(reasons, "The rule names you")
			}
		case "role":
			if id, err := uuid.Parse(rest); err == nil {
				if name, ok := roleNames[id]; ok {
					reasons = append(reasons, "Because you hold the role "+name)
				}
			}
		case "item":
			if definition.Loop != nil {
				collection, _ := LookupCollection(definition.Loop.Collection)
				for _, choice := range collection.Recipients {
					if choice.Key == rest {
						reasons = append(reasons, "When you are: "+lowerFirst(choice.Label))
					}
				}
			}
		default:
			if allowed, restricted := membershipKeys[recipient]; restricted && !slices.Contains(allowed, membership) {
				continue
			}
			label := recipient
			choices := trigger.Recipients
			if definition.Trigger.Type == TriggerSchedule {
				choices = OpenDayRecipients()
			}
			for _, choice := range choices {
				if choice.Key == recipient {
					label = choice.Label
				}
			}
			reasons = append(reasons, "When you are: "+lowerFirst(label))
		}
	}
	return reasons
}
