package notifyrules

import (
	"context"
	"errors"
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

// settingsTarget is the person whose notification settings are read or changed, with their account when they have
// one. Consents and the feedback-at-check-out switch belong to the person, channel choices to the account.
type settingsTarget struct {
	personID  uuid.UUID
	accountID *uuid.UUID
}

func ownTarget(p authorization.Principal) settingsTarget {
	account := p.AccountID
	return settingsTarget{personID: p.PersonID, accountID: &account}
}

// targetLoader resolves the target inside the transaction that changes its settings.
type targetLoader func(context.Context, *notifyrulesdb.Queries) (settingsTarget, error)

func ownTargetLoader(p authorization.Principal) targetLoader {
	return func(context.Context, *notifyrulesdb.Queries) (settingsTarget, error) { return ownTarget(p), nil }
}

func personTargetLoader(personID uuid.UUID) targetLoader {
	return func(ctx context.Context, queries *notifyrulesdb.Queries) (settingsTarget, error) {
		row, err := queries.GetNotificationSettingsTarget(ctx, personID)
		if errors.Is(err, pgx.ErrNoRows) {
			return settingsTarget{}, apperror.NotFound
		}
		if err != nil {
			return settingsTarget{}, err
		}
		return settingsTarget{personID: row.PersonID, accountID: row.AccountID}, nil
	}
}

// changeableTargetLoader is personTargetLoader for a staff change: only a master may change a master's settings,
// as for the master's password or second factors.
func changeableTargetLoader(actor authorization.Principal, personID uuid.UUID) targetLoader {
	load := personTargetLoader(personID)
	return func(ctx context.Context, queries *notifyrulesdb.Queries) (settingsTarget, error) {
		target, err := load(ctx, queries)
		if err != nil || actor.Master || target.personID == actor.PersonID {
			return target, err
		}
		master, err := queries.IsPersonMaster(ctx, target.personID)
		if err != nil {
			return settingsTarget{}, err
		}
		if master {
			return settingsTarget{}, apperror.PermissionDenied
		}
		return target, nil
	}
}

// PersonHasNoAccountCode answers a channel choice for a person without an account: choices belong to an account.
const PersonHasNoAccountCode = "person_has_no_account"

func personHasNoAccount() error {
	return apperror.Conflicting(PersonHasNoAccountCode, "The person has no account, so there are no channels to choose")
}

func mandatoryNotification() error {
	return apperror.New(
		http.StatusUnprocessableEntity, "mandatory_notification", "This notification is mandatory; keep at least one channel on.",
	)
}

// PersonSettings is another person's notification settings as staff see them.
type PersonSettings struct {
	PersonID   uuid.UUID
	HasAccount bool
	Settings   Settings
}

// PersonSettings returns a person's notification settings for staff with notification_settings.read.all or
// notification_settings.manage.all. A person without an account has consents and the feedback switch but no rules.
func (s *Service) PersonSettings(
	ctx context.Context,
	p authorization.Principal,
	personID uuid.UUID,
) (PersonSettings, error) {
	if !p.Has(authorization.NotificationSettingsReadAll) && !p.Has(authorization.NotificationSettingsManageAll) {
		return PersonSettings{}, apperror.PermissionDenied
	}
	queries := notifyrulesdb.New(s.pool)
	target, err := personTargetLoader(personID)(ctx, queries)
	if err != nil {
		return PersonSettings{}, err
	}
	settings, err := s.settings(ctx, queries, target)
	if err != nil {
		return PersonSettings{}, err
	}
	// Staff who may not read the central rules see which rules reach the person, but not what the rules say.
	if !p.Has(authorization.NotificationRulesRead) && !p.Has(authorization.NotificationRulesManage) {
		for index := range settings.Rules {
			settings.Rules[index].Description, settings.Rules[index].TriggerSummary = "", ""
		}
	}
	return PersonSettings{PersonID: target.personID, HasAccount: target.accountID != nil, Settings: settings}, nil
}

// SetPersonRulePreference stores a person's channel choice for a central rule on their behalf; it needs
// notification_settings.manage.all and follows the rules of the person's own choice.
func (s *Service) SetPersonRulePreference(
	ctx context.Context,
	p authorization.Principal,
	personID, ruleID uuid.UUID,
	preference Preference,
	requestID *uuid.UUID,
) error {
	if !p.Has(authorization.NotificationSettingsManageAll) {
		return apperror.PermissionDenied
	}
	return s.setRulePreference(ctx, p, changeableTargetLoader(p, personID), ruleID, preference, requestID)
}

// SetPersonAskFeedbackAtCheckout stores a person's feedback-at-check-out switch on their behalf; it needs
// notification_settings.manage.all.
func (s *Service) SetPersonAskFeedbackAtCheckout(
	ctx context.Context,
	p authorization.Principal,
	personID uuid.UUID,
	ask bool,
	requestID *uuid.UUID,
) error {
	if !p.Has(authorization.NotificationSettingsManageAll) {
		return apperror.PermissionDenied
	}
	return s.setAskFeedbackAtCheckout(ctx, p, changeableTargetLoader(p, personID), ask, requestID)
}

// setRulePreference stores a channel choice for a central rule that reaches the person; any other rule answers 404, so
// the call cannot be used to learn about rules the person never hears of. A choice equal to the channels the person
// gets now changes nothing; otherwise the choice, its audit event and the notification_settings_changed event commit
// together.
func (s *Service) setRulePreference(
	ctx context.Context,
	actor authorization.Principal,
	load targetLoader,
	ruleID uuid.UUID,
	preference Preference,
	requestID *uuid.UUID,
) error {
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		queries := notifyrulesdb.New(tx)
		target, err := load(ctx, queries)
		if err != nil {
			return err
		}
		row, err := queries.GetRule(ctx, ruleID)
		if err != nil || row.OwnerAccountID != nil {
			return apperror.NotFound
		}
		if target.accountID == nil {
			return personHasNoAccount()
		}
		if row.Mandatory && !preference.InApp && !preference.Email {
			return mandatoryNotification()
		}
		current, reaches, err := s.currentChannels(ctx, queries, target, row.ID)
		if err != nil {
			return err
		}
		if !reaches {
			return apperror.NotFound
		}
		if current == preference {
			return nil
		}
		if err := queries.UpsertPreference(ctx, notifyrulesdb.UpsertPreferenceParams{
			AccountID: *target.accountID, RuleID: ruleID, InApp: preference.InApp, Email: preference.Email,
			Now: s.now(),
		}); err != nil {
			return err
		}
		var changed []string
		if current.InApp != preference.InApp {
			changed = append(changed, "inApp")
		}
		if current.Email != preference.Email {
			changed = append(changed, "email")
		}
		event := auditEvent(actor, "notification_preference.changed", "notification_rule", ruleID, requestID, changed)
		event.Metadata = map[string]any{"personId": target.personID.String()}
		if err := audit.Write(ctx, tx, event); err != nil {
			return err
		}
		line := row.Name + ": e-mail " + onOff(preference.Email) + ", in-app " + onOff(preference.InApp)
		return s.settingsChanged(ctx, tx, actor, target.personID, []string{line}, false)
	})
}

// currentChannels is what the person gets from a rule now (their stored choice or the channels of the rule's actions
// that reach them), and whether the rule reaches them at all.
func (s *Service) currentChannels(
	ctx context.Context,
	queries *notifyrulesdb.Queries,
	target settingsTarget,
	ruleID uuid.UUID,
) (Preference, bool, error) {
	reaching, err := s.reachingRules(ctx, queries, target, nil)
	if err != nil {
		return Preference{}, false, err
	}
	for _, candidate := range reaching {
		if candidate.RuleID == ruleID {
			channels := candidate.EffectiveChannels
			return Preference{
				InApp: slices.Contains(channels, ChannelInApp), Email: slices.Contains(channels, ChannelEmail),
			}, true, nil
		}
	}
	return Preference{}, false, nil
}

// setAskFeedbackAtCheckout stores the feedback-at-check-out switch; the same value again changes nothing.
func (s *Service) setAskFeedbackAtCheckout(
	ctx context.Context,
	actor authorization.Principal,
	load targetLoader,
	ask bool,
	requestID *uuid.UUID,
) error {
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		queries := notifyrulesdb.New(tx)
		target, err := load(ctx, queries)
		if err != nil {
			return err
		}
		current := true
		stored, err := queries.GetPersonSettings(ctx, target.personID)
		switch {
		case err == nil:
			current = stored.AskFeedbackAtCheckout
		case !errors.Is(err, pgx.ErrNoRows):
			return err
		}
		if current == ask {
			return nil
		}
		if err := queries.UpsertAskFeedbackAtCheckout(ctx, notifyrulesdb.UpsertAskFeedbackAtCheckoutParams{
			PersonID: target.personID, Ask: ask, Now: s.now(),
		}); err != nil {
			return err
		}
		event := auditEvent(actor, "notification_feedback_at_checkout.changed", "person", target.personID, requestID,
			[]string{"askFeedbackAtCheckout"})
		event.Metadata = map[string]any{"personId": target.personID.String()}
		if err := audit.Write(ctx, tx, event); err != nil {
			return err
		}
		return s.settingsChanged(ctx, tx, actor, target.personID, []string{"Feedback at check-out: " + onOff(ask)}, false)
	})
}

// settingsChanged raises notification_settings_changed for one save that changed something.
func (s *Service) settingsChanged(
	ctx context.Context,
	tx pgx.Tx,
	actor authorization.Principal,
	personID uuid.UUID,
	changes []string,
	consents bool,
) error {
	if len(changes) == 0 {
		return nil
	}
	return NewSystemEvents(s.dispatcher).NotificationSettingsChanged(ctx, tx, personID, actor.PersonID, changes, consents)
}

func consentChangeLine(category string, granted bool) string {
	answer := "withdrawn"
	if granted {
		answer = "granted"
	}
	return "Consent \"" + strings.TrimSpace(category) + "\": " + answer
}

func onOff(on bool) string {
	if on {
		return "on"
	}
	return "off"
}
