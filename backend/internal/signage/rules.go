package signage

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	maxRulesPerDisplay   = 50
	maxRuleMachines      = 20
	maxRuleTemplates     = 50
	defaultRuleMinimum   = 20
	defaultRuleAlternate = 10
)

var clockPattern = regexp.MustCompile(`^([01]\d|2[0-3]):([0-5]\d)$`)

// Rule is one entry of a display's ordered rule list: "when condition show target".
// Rules are drafts; they reach players only through a publication.
type Rule struct {
	ID                      uuid.UUID
	DisplayID               uuid.UUID
	Position                int
	Enabled                 bool
	ConditionKind           string
	Weekdays                []int
	TimeFrom, TimeTo        *string
	MachineIDs              []uuid.UUID
	MachineMatch            *string
	AnnouncementTemplateIDs []uuid.UUID
	TargetKind              string
	TargetID                uuid.UUID
	MinSeconds              int
	MultiMode               string
	AlternateSeconds        int
}

// RuleInput is the writable part of a rule.
type RuleInput struct {
	Enabled                 bool
	ConditionKind           string
	Weekdays                []int
	TimeFrom, TimeTo        *string
	MachineIDs              []uuid.UUID
	MachineMatch            *string
	AnnouncementTemplateIDs []uuid.UUID
	TargetKind              string
	TargetID                uuid.UUID
	MinSeconds              int
	MultiMode               string
	AlternateSeconds        int
}

// RuleList is the ordered rule list of a display together with the display version that every
// rule write must quote (rules share the display's optimistic-concurrency version).
type RuleList struct {
	Items          []Rule
	DisplayVersion int64
}

func normalizeClock(value *string, label string) (*string, error) {
	if value == nil {
		return nil, validation("%s is required for a time window", label)
	}
	trimmed := strings.TrimSpace(*value)
	if !clockPattern.MatchString(trimmed) {
		return nil, validation("%s must be a time of day as HH:MM", label)
	}
	return &trimmed, nil
}

// ValidateRuleInput checks the condition-specific shape of a rule exactly like the table CHECK
// constraints (fields that do not belong to the condition kind must be empty) and returns the
// normalised input: weekdays and ids de-duplicated, weekdays sorted.
func ValidateRuleInput(input RuleInput) (RuleInput, error) {
	if input.MinSeconds < 0 || input.MinSeconds > 600 {
		return input, validation("minSeconds must be between 0 and 600")
	}
	if input.MultiMode != "split" && input.MultiMode != "alternate" {
		return input, validation("multiMode must be split or alternate")
	}
	if input.AlternateSeconds < 3 || input.AlternateSeconds > 600 {
		return input, validation("alternateSeconds must be between 3 and 600")
	}
	if input.TargetKind != "scene" && input.TargetKind != "playlist" {
		return input, validation("targetKind must be scene or playlist")
	}
	if input.TargetID == uuid.Nil {
		return input, validation("targetId is required")
	}
	weekdays := map[int]struct{}{}
	for _, day := range input.Weekdays {
		if day < 1 || day > 7 {
			return input, validation("weekdays must be ISO weekdays 1 (Monday) to 7 (Sunday)")
		}
		weekdays[day] = struct{}{}
	}
	input.Weekdays = make([]int, 0, len(weekdays))
	for day := range weekdays {
		input.Weekdays = append(input.Weekdays, day)
	}
	sort.Ints(input.Weekdays)
	input.MachineIDs = distinct(input.MachineIDs)
	input.AnnouncementTemplateIDs = distinct(input.AnnouncementTemplateIDs)
	if len(input.MachineIDs) > maxRuleMachines {
		return input, validation("a rule watches at most %d machines", maxRuleMachines)
	}
	if len(input.AnnouncementTemplateIDs) > maxRuleTemplates {
		return input, validation("a rule filters at most %d announcement templates", maxRuleTemplates)
	}
	noTime := input.TimeFrom == nil && input.TimeTo == nil
	noMachines := len(input.MachineIDs) == 0 && input.MachineMatch == nil
	switch input.ConditionKind {
	case "time_window":
		if len(input.Weekdays) == 0 {
			return input, validation("a time window needs at least one weekday")
		}
		from, err := normalizeClock(input.TimeFrom, "timeFrom")
		if err != nil {
			return input, err
		}
		to, err := normalizeClock(input.TimeTo, "timeTo")
		if err != nil {
			return input, err
		}
		if *from == *to {
			return input, validation("timeFrom and timeTo must differ; a window may wrap past midnight")
		}
		input.TimeFrom, input.TimeTo = from, to
		if !noMachines || len(input.AnnouncementTemplateIDs) > 0 {
			return input, validation("a time window cannot have machine or announcement conditions")
		}
	case "machine_printing":
		if len(input.MachineIDs) == 0 {
			return input, validation("a machine rule needs at least one machine")
		}
		if input.MachineMatch == nil || (*input.MachineMatch != "any" && *input.MachineMatch != "all") {
			return input, validation("machineMatch must be any or all")
		}
		if len(input.Weekdays) > 0 || !noTime || len(input.AnnouncementTemplateIDs) > 0 {
			return input, validation("a machine rule cannot have time or announcement conditions")
		}
	case "announcement_active":
		if len(input.Weekdays) > 0 || !noTime || !noMachines {
			return input, validation("an announcement rule only takes announcement template filters")
		}
	case "live_data_unavailable":
		if len(input.Weekdays) > 0 || !noTime || !noMachines || len(input.AnnouncementTemplateIDs) > 0 {
			return input, validation("a live-data rule takes no condition fields")
		}
	default:
		return input, validation(
			"conditionKind must be time_window, machine_printing, announcement_active or live_data_unavailable",
		)
	}
	return input, nil
}

func ruleFromRow(row signagedb.ListSignageRulesRow) (Rule, error) {
	rule := Rule{
		ID:            row.ID,
		DisplayID:     row.DisplayID,
		Position:      int(row.Position),
		Enabled:       row.Enabled,
		ConditionKind: row.ConditionKind,
		Weekdays:      make([]int, 0, len(row.Weekdays)), MachineMatch: row.MachineMatch, TargetKind: row.TargetKind,
		MinSeconds: int(row.MinSeconds), MultiMode: row.MultiMode, AlternateSeconds: int(row.AlternateSeconds),
		MachineIDs: []uuid.UUID{}, AnnouncementTemplateIDs: []uuid.UUID{},
	}
	for _, day := range row.Weekdays {
		rule.Weekdays = append(rule.Weekdays, int(day))
	}
	if row.TimeFrom != "" {
		from, to := clockText(row.TimeFrom), clockText(row.TimeTo)
		rule.TimeFrom, rule.TimeTo = &from, &to
	}
	for _, text := range row.MachineIds {
		id, err := uuid.Parse(text)
		if err != nil {
			return Rule{}, err
		}
		rule.MachineIDs = append(rule.MachineIDs, id)
	}
	for _, text := range row.AnnouncementTemplateIds {
		id, err := uuid.Parse(text)
		if err != nil {
			return Rule{}, err
		}
		rule.AnnouncementTemplateIDs = append(rule.AnnouncementTemplateIDs, id)
	}
	switch {
	case row.TargetKind == "scene" && row.TargetSceneID != nil:
		rule.TargetID = *row.TargetSceneID
	case row.TargetKind == "playlist" && row.TargetPlaylistID != nil:
		rule.TargetID = *row.TargetPlaylistID
	default:
		return Rule{}, errors.New("rule has no target")
	}
	return rule, nil
}

// clockText trims PostgreSQL's HH:MM:SS to HH:MM.
func clockText(value string) string {
	if len(value) >= 5 {
		return value[:5]
	}
	return value
}

func loadRules(ctx context.Context, q *signagedb.Queries, displayIDs []uuid.UUID) (map[uuid.UUID][]Rule, error) {
	rows, err := q.ListSignageRules(ctx, uuidStrings(displayIDs))
	if err != nil {
		return nil, err
	}
	result := map[uuid.UUID][]Rule{}
	for _, row := range rows {
		rule, err := ruleFromRow(row)
		if err != nil {
			return nil, err
		}
		result[row.DisplayID] = append(result[row.DisplayID], rule)
	}
	return result, nil
}

// verifyRuleReferences checks that the machines, templates and target of a rule exist and share-locks
// them so a concurrent deletion either waits for this transaction or finds the new reference. A scene
// target must match the display orientation; playlists may hold scenes of either orientation.
func verifyRuleReferences(ctx context.Context, q *signagedb.Queries, orientation string, input RuleInput) error {
	if len(input.MachineIDs) > 0 {
		rows, err := q.ListSignageMachineNames(ctx, uuidStrings(input.MachineIDs))
		if err != nil {
			return err
		}
		if len(rows) != len(input.MachineIDs) {
			return validation("a referenced machine does not exist")
		}
	}
	if len(input.AnnouncementTemplateIDs) > 0 {
		ids, err := q.ListSignageTemplateIDsByIDs(ctx, uuidStrings(input.AnnouncementTemplateIDs))
		if err != nil {
			return err
		}
		if len(ids) != len(input.AnnouncementTemplateIDs) {
			return validation("a referenced announcement template does not exist")
		}
	}
	if input.TargetKind == "scene" {
		scene, err := q.LockSignageSceneForShare(ctx, input.TargetID)
		if errors.Is(err, pgx.ErrNoRows) {
			return validation("the target scene does not exist")
		}
		if err != nil {
			return err
		}
		if scene.Orientation != orientation {
			return validation("the target scene must have the display orientation (%s)", orientation)
		}
		return nil
	}
	if _, err := q.LockSignagePlaylistForShare(ctx, input.TargetID); errors.Is(err, pgx.ErrNoRows) {
		return validation("the target playlist does not exist")
	} else if err != nil {
		return err
	}
	return nil
}

func ruleParams(displayID, ruleID uuid.UUID, position int, input RuleInput) signagedb.InsertSignageRuleParams {
	weekdays := make([]int16, 0, len(input.Weekdays))
	for _, day := range input.Weekdays {
		weekdays = append(weekdays, int16(day))
	}
	params := signagedb.InsertSignageRuleParams{
		ID:                      ruleID,
		DisplayID:               displayID,
		Position:                int32(position),
		Enabled:                 input.Enabled,
		ConditionKind:           input.ConditionKind,
		Weekdays:                weekdays,
		TimeFrom:                input.TimeFrom,
		TimeTo:                  input.TimeTo,
		MachineIds:              uuidStrings(input.MachineIDs),
		MachineMatch:            input.MachineMatch,
		AnnouncementTemplateIds: uuidStrings(input.AnnouncementTemplateIDs), TargetKind: input.TargetKind,
		MinSeconds: int32(
			input.MinSeconds,
		), MultiMode: input.MultiMode, AlternateSeconds: int32(input.AlternateSeconds),
	}
	target := input.TargetID
	if input.TargetKind == "scene" {
		params.TargetSceneID = &target
	} else {
		params.TargetPlaylistID = &target
	}
	return params
}

// ListRules returns a display's rules in evaluation order.
func (s *Service) ListRules(
	ctx context.Context,
	principal authorization.Principal,
	displayID uuid.UUID,
) (RuleList, error) {
	if err := requireRead(principal); err != nil {
		return RuleList{}, err
	}
	q := signagedb.New(s.pool)
	display, err := q.GetSignageDisplayView(ctx, displayID)
	if errors.Is(err, pgx.ErrNoRows) {
		return RuleList{}, apperror.NotFound
	}
	if err != nil {
		return RuleList{}, err
	}
	rules, err := loadRules(ctx, q, []uuid.UUID{displayID})
	if err != nil {
		return RuleList{}, err
	}
	items := rules[displayID]
	if items == nil {
		items = []Rule{}
	}
	return RuleList{Items: items, DisplayVersion: display.Version}, nil
}

// ruleMutation runs one rule write under the display lock. Rules share the display version:
// every write must quote the current display version and bumps it, so concurrent edits of the same
// rule list conflict as a whole (409 stale_write) and a reorder is atomic by construction.
func (s *Service) ruleMutation(
	ctx context.Context,
	principal authorization.Principal,
	displayID uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
	action, resource string,
	resourceID func() uuid.UUID,
	fields []string,
	apply func(q *signagedb.Queries, display signagedb.GetSignageDisplayForUpdateRow, rules []Rule) error,
) (RuleList, error) {
	if !principal.Has(authorization.SignageManage) {
		return RuleList{}, apperror.PermissionDenied
	}
	if err := requireExpected(expected); err != nil {
		return RuleList{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RuleList{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	display, err := q.GetSignageDisplayForUpdate(ctx, displayID)
	if errors.Is(err, pgx.ErrNoRows) {
		return RuleList{}, apperror.NotFound
	}
	if err != nil {
		return RuleList{}, err
	}
	if display.Version != expected {
		return RuleList{}, apperror.StaleWrite
	}
	if display.RevokedAt.Valid || display.DeviceRevokedAt.Valid {
		return RuleList{}, displayRevoked()
	}
	loaded, err := loadRules(ctx, q, []uuid.UUID{displayID})
	if err != nil {
		return RuleList{}, err
	}
	if err := apply(q, display, loaded[displayID]); err != nil {
		return RuleList{}, err
	}
	version, err := q.BumpSignageDisplayVersion(
		ctx,
		signagedb.BumpSignageDisplayVersionParams{ID: displayID, ExpectedVersion: expected},
	)
	if err != nil {
		return RuleList{}, err
	}
	if err := writeAudit(ctx, tx, principal, action, resource, resourceID(), requestID, fields); err != nil {
		return RuleList{}, err
	}
	reloaded, err := loadRules(ctx, q, []uuid.UUID{displayID})
	if err != nil {
		return RuleList{}, err
	}
	items := reloaded[displayID]
	if items == nil {
		items = []Rule{}
	}
	if err := tx.Commit(ctx); err != nil {
		return RuleList{}, err
	}
	return RuleList{Items: items, DisplayVersion: version}, nil
}

func displayRevoked() error {
	return apperror.New(http.StatusConflict, "signage_display_revoked", "The display is revoked")
}

var ruleFields = []string{"enabled", "condition", "target", "minSeconds", "multiMode", "alternateSeconds"}

// CreateRule appends a rule to the end of the display's rule list.
func (s *Service) CreateRule(
	ctx context.Context,
	principal authorization.Principal,
	displayID uuid.UUID,
	expected int64,
	input RuleInput,
	requestID *uuid.UUID,
) (RuleList, error) {
	if !principal.Has(authorization.SignageManage) {
		return RuleList{}, apperror.PermissionDenied
	}
	checked, err := ValidateRuleInput(input)
	if err != nil {
		return RuleList{}, err
	}
	id := uuid.Must(uuid.NewV7())
	return s.ruleMutation(
		ctx,
		principal,
		displayID,
		expected,
		requestID,
		"signage_rule.created",
		"signage_rule",
		func() uuid.UUID { return id },
		ruleFields,
		func(q *signagedb.Queries, display signagedb.GetSignageDisplayForUpdateRow, rules []Rule) error {
			if len(rules) >= maxRulesPerDisplay {
				return validation("a display has at most %d rules", maxRulesPerDisplay)
			}
			if err := verifyRuleReferences(ctx, q, display.Orientation, checked); err != nil {
				return err
			}
			return databaseError(q.InsertSignageRule(ctx, ruleParams(displayID, id, len(rules), checked)))
		},
	)
}

func findRule(rules []Rule, id uuid.UUID) (Rule, bool) {
	for _, rule := range rules {
		if rule.ID == id {
			return rule, true
		}
	}
	return Rule{}, false
}

// UpdateRule replaces all writable fields of a rule.
func (s *Service) UpdateRule(
	ctx context.Context,
	principal authorization.Principal,
	displayID, ruleID uuid.UUID,
	expected int64,
	input RuleInput,
	requestID *uuid.UUID,
) (RuleList, error) {
	if !principal.Has(authorization.SignageManage) {
		return RuleList{}, apperror.PermissionDenied
	}
	checked, err := ValidateRuleInput(input)
	if err != nil {
		return RuleList{}, err
	}
	return s.ruleMutation(
		ctx,
		principal,
		displayID,
		expected,
		requestID,
		"signage_rule.updated",
		"signage_rule",
		func() uuid.UUID { return ruleID },
		ruleFields,
		func(q *signagedb.Queries, display signagedb.GetSignageDisplayForUpdateRow, rules []Rule) error {
			if _, ok := findRule(rules, ruleID); !ok {
				return apperror.NotFound
			}
			if err := verifyRuleReferences(ctx, q, display.Orientation, checked); err != nil {
				return err
			}
			params := ruleParams(displayID, ruleID, 0, checked)
			_, err := q.UpdateSignageRule(ctx, signagedb.UpdateSignageRuleParams{
				Enabled:                 params.Enabled,
				ConditionKind:           params.ConditionKind,
				Weekdays:                params.Weekdays,
				TimeFrom:                params.TimeFrom,
				TimeTo:                  params.TimeTo,
				MachineIds:              params.MachineIds,
				MachineMatch:            params.MachineMatch,
				AnnouncementTemplateIds: params.AnnouncementTemplateIds,
				TargetKind:              params.TargetKind,
				TargetSceneID:           params.TargetSceneID,
				TargetPlaylistID:        params.TargetPlaylistID,
				MinSeconds:              params.MinSeconds,
				MultiMode:               params.MultiMode,
				AlternateSeconds:        params.AlternateSeconds,
				ID:                      ruleID,
				DisplayID:               displayID,
			})
			return databaseError(err)
		},
	)
}

// SetRuleEnabled switches a rule on or off without touching anything else.
func (s *Service) SetRuleEnabled(
	ctx context.Context,
	principal authorization.Principal,
	displayID, ruleID uuid.UUID,
	expected int64,
	enabled bool,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.ruleMutation(
		ctx,
		principal,
		displayID,
		expected,
		requestID,
		"signage_rule.updated",
		"signage_rule",
		func() uuid.UUID { return ruleID },
		[]string{"enabled"},
		func(q *signagedb.Queries, _ signagedb.GetSignageDisplayForUpdateRow, rules []Rule) error {
			if _, ok := findRule(rules, ruleID); !ok {
				return apperror.NotFound
			}
			_, err := q.SetSignageRuleEnabled(
				ctx,
				signagedb.SetSignageRuleEnabledParams{Enabled: enabled, ID: ruleID, DisplayID: displayID},
			)
			return err
		},
	)
}

// DeleteRule removes a rule and closes the gap in the order.
func (s *Service) DeleteRule(
	ctx context.Context,
	principal authorization.Principal,
	displayID, ruleID uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.ruleMutation(
		ctx,
		principal,
		displayID,
		expected,
		requestID,
		"signage_rule.deleted",
		"signage_rule",
		func() uuid.UUID { return ruleID },
		nil,
		func(q *signagedb.Queries, _ signagedb.GetSignageDisplayForUpdateRow, rules []Rule) error {
			if _, ok := findRule(rules, ruleID); !ok {
				return apperror.NotFound
			}
			if _, err := q.DeleteSignageRule(
				ctx,
				signagedb.DeleteSignageRuleParams{ID: ruleID, DisplayID: displayID},
			); err != nil {
				return err
			}
			position := 0
			for _, rule := range rules {
				if rule.ID == ruleID {
					continue
				}
				if err := q.SetSignageRulePosition(
					ctx,
					signagedb.SetSignageRulePositionParams{
						Position:  int32(position),
						ID:        rule.ID,
						DisplayID: displayID,
					},
				); err != nil {
					return err
				}
				position++
			}
			return nil
		},
	)
}

// ReorderRules sets the complete evaluation order in one transaction. ruleIDs must name every rule
// of the display exactly once.
func (s *Service) ReorderRules(
	ctx context.Context,
	principal authorization.Principal,
	displayID uuid.UUID,
	expected int64,
	ruleIDs []uuid.UUID,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.ruleMutation(
		ctx,
		principal,
		displayID,
		expected,
		requestID,
		"signage_display.rules_reordered",
		"signage_display",
		func() uuid.UUID { return displayID },
		[]string{"ruleOrder"},
		func(q *signagedb.Queries, _ signagedb.GetSignageDisplayForUpdateRow, rules []Rule) error {
			if len(ruleIDs) != len(rules) || len(distinct(ruleIDs)) != len(ruleIDs) {
				return validation("ruleIds must list every rule of the display exactly once")
			}
			for _, id := range ruleIDs {
				if _, ok := findRule(rules, id); !ok {
					return validation("ruleIds must list every rule of the display exactly once")
				}
			}
			for position, id := range ruleIDs {
				if err := q.SetSignageRulePosition(
					ctx,
					signagedb.SetSignageRulePositionParams{Position: int32(position), ID: id, DisplayID: displayID},
				); err != nil {
					return err
				}
			}
			return nil
		},
	)
}
