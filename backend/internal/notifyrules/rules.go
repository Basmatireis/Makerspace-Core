package notifyrules

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func timePointer(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	t := value.Time.UTC()
	return &t
}

func ruleFromRow(row notifyrulesdb.NotificationRule) (Rule, error) {
	definition, err := ParseDefinition(row.Definition)
	if err != nil {
		return Rule{}, fmt.Errorf("rule %s: %w", row.ID, err)
	}
	return Rule{
		ID: row.ID, OwnerAccountID: row.OwnerAccountID, Name: row.Name, Description: row.Description,
		CategoryID: row.CategoryID, Enabled: row.Enabled, Mandatory: row.Mandatory, SystemKey: row.SystemKey,
		Definition: definition, LastFiredAt: timePointer(row.LastFiredAt), Version: row.Version,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}, nil
}

// requiredPermissions lists the permissions the catalog entries a definition uses need. An update may keep using
// entries its author lost the permission for, but not add new ones.
func requiredPermissions(d Definition) []authorization.Permission {
	var needed []authorization.Permission
	add := func(permission authorization.Permission) {
		if permission != "" && !slices.Contains(needed, permission) {
			needed = append(needed, permission)
		}
	}
	var trigger Trigger
	if d.Trigger.Type == TriggerEvent {
		trigger, _ = LookupTrigger(d.Trigger.Event)
		add(trigger.Permission)
	}
	var collection Collection
	if d.Loop != nil {
		collection, _ = LookupCollection(d.Loop.Collection)
		add(collection.Permission)
	}
	use := func(set ConditionSet) {
		for _, condition := range set.Conditions() {
			prefix, key, _ := cutField(condition.Field)
			var field Field
			switch prefix {
			case PrefixEvent:
				field, _ = trigger.Field(key)
			case PrefixItem:
				field, _ = collection.Field(key)
			}
			add(field.Permission)
		}
	}
	use(d.Conditions)
	if d.Loop != nil {
		use(d.Loop.Filter)
	}
	return needed
}

func cutField(field string) (prefix, key string, ok bool) {
	for i := 0; i < len(field); i++ {
		if field[i] == '.' {
			return field[:i], field[i+1:], true
		}
	}
	return field, "", false
}

func (s *Service) validateRule(
	ctx context.Context,
	queries *notifyrulesdb.Queries,
	p authorization.Principal,
	personal bool,
	input *RuleInput,
	keepPermissions []authorization.Permission,
) ([]string, []byte, error) {
	name, err := cleanName(input.Name, MaxNameLength, "name")
	if err != nil {
		return nil, nil, err
	}
	description, err := cleanText(input.Description, MaxDescriptionLength, "description")
	if err != nil {
		return nil, nil, err
	}
	input.Name, input.Description = name, description
	warnings, err := input.Definition.Validate(Env{
		Personal: personal,
		CanSee: func(permission authorization.Permission) bool {
			return p.Has(permission) || slices.Contains(keepPermissions, permission)
		},
		Lookups: newLookups(ctx, queries),
	})
	if err != nil {
		return nil, nil, err
	}
	data, err := input.Definition.Marshal()
	if err != nil {
		return nil, nil, fmt.Errorf("encode rule definition: %w", err)
	}
	return warnings, data, nil
}

func triggerColumns(d Definition) (string, *string) {
	if d.Trigger.Type == TriggerEvent {
		event := d.Trigger.Event
		return string(d.Trigger.Type), &event
	}
	return string(d.Trigger.Type), nil
}

func canReadCentral(p authorization.Principal) bool {
	return p.Has(authorization.NotificationRulesRead) || p.Has(authorization.NotificationRulesManage)
}

// ListRules returns the central rules with their firing statistics. Needs notification_rules.read.
func (s *Service) ListRules(ctx context.Context, p authorization.Principal) ([]Rule, error) {
	if !canReadCentral(p) {
		return nil, apperror.PermissionDenied
	}
	queries := notifyrulesdb.New(s.pool)
	now := s.now()
	rows, err := queries.ListCentralRules(ctx, now.AddDate(0, 0, -statsDays))
	if err != nil {
		return nil, fmt.Errorf("list rules: %w", err)
	}
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	days, err := queries.ListFiringDays(ctx, today.AddDate(0, 0, 1-sparklineDays))
	if err != nil {
		return nil, fmt.Errorf("list firing days: %w", err)
	}
	sparklines := map[uuid.UUID][]int64{}
	for _, day := range days {
		line := sparklines[day.RuleID]
		if line == nil {
			line = make([]int64, sparklineDays)
		}
		index := int(day.Day.Time.UTC().Sub(today.AddDate(0, 0, 1-sparklineDays)).Hours() / 24)
		if index >= 0 && index < sparklineDays {
			line[index] = day.Fired
		}
		sparklines[day.RuleID] = line
	}
	items := make([]Rule, 0, len(rows))
	for _, row := range rows {
		rule, err := ruleFromRow(notifyrulesdb.NotificationRule{
			ID: row.ID, OwnerAccountID: row.OwnerAccountID, Name: row.Name, Description: row.Description,
			CategoryID: row.CategoryID, Enabled: row.Enabled, Mandatory: row.Mandatory, TriggerType: row.TriggerType,
			TriggerEvent: row.TriggerEvent, Definition: row.Definition, SystemKey: row.SystemKey, NextRunAt: row.NextRunAt,
			LastFiredAt: row.LastFiredAt, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Version: row.Version,
		})
		if err != nil {
			return nil, err
		}
		line := sparklines[row.ID]
		if line == nil {
			line = make([]int64, sparklineDays)
		}
		rule.Stats = &RuleStats{Fired30: row.FiredRecently, LastFiredAt: rule.LastFiredAt, Sparkline: line}
		items = append(items, rule)
	}
	return items, nil
}

// GetRule returns one central rule. Needs notification_rules.read. A subscription is reported as not found.
func (s *Service) GetRule(ctx context.Context, p authorization.Principal, id uuid.UUID) (Rule, error) {
	if !canReadCentral(p) {
		return Rule{}, apperror.PermissionDenied
	}
	return s.loadRule(ctx, notifyrulesdb.New(s.pool), id, nil)
}

// loadRule reads a rule; owner nil selects central rules, otherwise the rule must belong to the owner.
func (s *Service) loadRule(ctx context.Context, queries *notifyrulesdb.Queries, id uuid.UUID, owner *uuid.UUID) (Rule, error) {
	row, err := queries.GetRule(ctx, id)
	if err != nil {
		return Rule{}, noRows(err)
	}
	return ownedRule(row, owner)
}

func ownedRule(row notifyrulesdb.NotificationRule, owner *uuid.UUID) (Rule, error) {
	if (owner == nil) != (row.OwnerAccountID == nil) || (owner != nil && *row.OwnerAccountID != *owner) {
		return Rule{}, apperror.NotFound
	}
	return ruleFromRow(row)
}

// CreateRule adds a central rule. Needs notification_rules.manage.
func (s *Service) CreateRule(
	ctx context.Context,
	p authorization.Principal,
	input RuleInput,
	requestID *uuid.UUID,
) (Rule, error) {
	if !p.Has(authorization.NotificationRulesManage) {
		return Rule{}, apperror.PermissionDenied
	}
	return s.createRule(ctx, p, input, nil, requestID)
}

// CreateSubscription adds a personal rule that notifies the principal only.
func (s *Service) CreateSubscription(
	ctx context.Context,
	p authorization.Principal,
	input RuleInput,
	requestID *uuid.UUID,
) (Rule, error) {
	owner := p.AccountID
	input.CategoryID, input.Mandatory = nil, false
	return s.createRule(ctx, p, input, &owner, requestID)
}

func (s *Service) createRule(
	ctx context.Context,
	p authorization.Principal,
	input RuleInput,
	owner *uuid.UUID,
	requestID *uuid.UUID,
) (Rule, error) {
	id := ids.New()
	var warnings []string
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		queries := notifyrulesdb.New(tx)
		if owner == nil {
			if input.CategoryID == nil {
				return apperror.InvalidField("categoryId: a central rule needs a category")
			}
			if _, err := queries.GetCategory(ctx, *input.CategoryID); err != nil {
				return unknownCategory(err)
			}
			count, err := queries.CountCentralRules(ctx)
			if err != nil {
				return err
			}
			if count >= MaxCentralRules {
				return apperror.Conflicting("notification_rule_limit", "There are too many notification rules.")
			}
		} else {
			count, err := queries.CountOwnRules(ctx, owner)
			if err != nil {
				return err
			}
			if count >= MaxPersonalRules {
				return apperror.Conflicting("notification_rule_limit", "You have too many notification subscriptions.")
			}
		}
		var data []byte
		var err error
		if warnings, data, err = s.validateRule(ctx, queries, p, owner != nil, &input, nil); err != nil {
			return err
		}
		triggerType, event := triggerColumns(input.Definition)
		if err := queries.InsertRule(ctx, notifyrulesdb.InsertRuleParams{
			ID: id, OwnerAccountID: owner, Name: input.Name, Description: input.Description, CategoryID: input.CategoryID,
			Enabled: input.Enabled, Mandatory: input.Mandatory, TriggerType: triggerType, TriggerEvent: event,
			Definition: string(data),
		}); err != nil {
			return err
		}
		return audit.Write(ctx, tx, auditEvent(p, "notification_rule.created", "notification_rule", id, requestID,
			[]string{"name", "description", "categoryId", "enabled", "mandatory", "definition"}))
	})
	if err != nil {
		return Rule{}, err
	}
	rule, err := s.loadRule(ctx, notifyrulesdb.New(s.pool), id, owner)
	rule.Warnings = warnings
	return rule, err
}

func unknownCategory(err error) error {
	if noRows(err) == apperror.NotFound { //nolint:errorlint // sentinel returned by noRows
		return apperror.InvalidField("categoryId: unknown category")
	}
	return err
}

// UpdateRule replaces a central rule. Needs notification_rules.manage.
func (s *Service) UpdateRule(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	input RuleInput,
	requestID *uuid.UUID,
) (Rule, error) {
	if !p.Has(authorization.NotificationRulesManage) {
		return Rule{}, apperror.PermissionDenied
	}
	return s.updateRule(ctx, p, id, expected, input, nil, requestID)
}

// UpdateSubscription replaces one of the principal's personal rules.
func (s *Service) UpdateSubscription(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	input RuleInput,
	requestID *uuid.UUID,
) (Rule, error) {
	owner := p.AccountID
	input.CategoryID, input.Mandatory = nil, false
	return s.updateRule(ctx, p, id, expected, input, &owner, requestID)
}

func (s *Service) updateRule(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	input RuleInput,
	owner *uuid.UUID,
	requestID *uuid.UUID,
) (Rule, error) {
	var warnings []string
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		queries := notifyrulesdb.New(tx)
		row, err := queries.GetRuleForUpdate(ctx, id)
		if err != nil {
			return noRows(err)
		}
		current, err := ownedRule(row, owner)
		if err != nil {
			return err
		}
		if current.Version != expected {
			return apperror.StaleWrite
		}
		if owner == nil {
			if input.CategoryID == nil {
				return apperror.InvalidField("categoryId: a central rule needs a category")
			}
			if _, err := queries.GetCategory(ctx, *input.CategoryID); err != nil {
				return unknownCategory(err)
			}
		}
		var data []byte
		if warnings, data, err = s.validateRule(ctx, queries, p, owner != nil, &input, requiredPermissions(current.Definition)); err != nil {
			return err
		}
		changed := changedRuleFields(current, input, data)
		if len(changed) == 0 {
			return nil
		}
		triggerType, event := triggerColumns(input.Definition)
		if _, err := queries.UpdateRule(ctx, notifyrulesdb.UpdateRuleParams{
			Name: input.Name, Description: input.Description, CategoryID: input.CategoryID, Enabled: input.Enabled,
			Mandatory: input.Mandatory, TriggerType: triggerType, TriggerEvent: event, Definition: string(data),
			ID: id, ExpectedVersion: expected,
		}); err != nil {
			return err
		}
		return audit.Write(ctx, tx, auditEvent(p, "notification_rule.updated", "notification_rule", id, requestID, changed))
	})
	if err != nil {
		return Rule{}, err
	}
	rule, err := s.loadRule(ctx, notifyrulesdb.New(s.pool), id, owner)
	rule.Warnings = warnings
	return rule, err
}

func changedRuleFields(current Rule, input RuleInput, newData []byte) []string {
	var changed []string
	if current.Name != input.Name {
		changed = append(changed, "name")
	}
	if current.Description != input.Description {
		changed = append(changed, "description")
	}
	if (current.CategoryID == nil) != (input.CategoryID == nil) ||
		(current.CategoryID != nil && *current.CategoryID != *input.CategoryID) {
		changed = append(changed, "categoryId")
	}
	if current.Enabled != input.Enabled {
		changed = append(changed, "enabled")
	}
	if current.Mandatory != input.Mandatory {
		changed = append(changed, "mandatory")
	}
	if oldCanonical, err := current.Definition.Marshal(); err != nil || string(oldCanonical) != string(newData) {
		changed = append(changed, "definition")
	}
	return changed
}

// DeleteRule removes a central rule. Needs notification_rules.manage.
func (s *Service) DeleteRule(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if !p.Has(authorization.NotificationRulesManage) {
		return apperror.PermissionDenied
	}
	return s.deleteRule(ctx, p, id, expected, nil, requestID)
}

// DeleteSubscription removes one of the principal's personal rules.
func (s *Service) DeleteSubscription(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	owner := p.AccountID
	return s.deleteRule(ctx, p, id, expected, &owner, requestID)
}

func (s *Service) deleteRule(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	owner *uuid.UUID,
	requestID *uuid.UUID,
) error {
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		queries := notifyrulesdb.New(tx)
		row, err := queries.GetRuleForUpdate(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if (owner == nil) != (row.OwnerAccountID == nil) || (owner != nil && *row.OwnerAccountID != *owner) {
			return apperror.NotFound
		}
		if row.Version != expected {
			return apperror.StaleWrite
		}
		if _, err := queries.DeleteRule(ctx, notifyrulesdb.DeleteRuleParams{ID: id, ExpectedVersion: expected}); err != nil {
			return err
		}
		return audit.Write(ctx, tx, auditEvent(p, "notification_rule.deleted", "notification_rule", id, requestID, nil))
	})
}

// ListSubscriptions returns the principal's personal rules.
func (s *Service) ListSubscriptions(ctx context.Context, p authorization.Principal) ([]Rule, error) {
	owner := p.AccountID
	rows, err := notifyrulesdb.New(s.pool).ListOwnRules(ctx, &owner)
	if err != nil {
		return nil, fmt.Errorf("list subscriptions: %w", err)
	}
	items := make([]Rule, 0, len(rows))
	for _, row := range rows {
		rule, err := ruleFromRow(row)
		if err != nil {
			return nil, err
		}
		items = append(items, rule)
	}
	return items, nil
}

// GetSubscription returns one of the principal's personal rules; anybody else's is reported as not found.
func (s *Service) GetSubscription(ctx context.Context, p authorization.Principal, id uuid.UUID) (Rule, error) {
	owner := p.AccountID
	return s.loadRule(ctx, notifyrulesdb.New(s.pool), id, &owner)
}
