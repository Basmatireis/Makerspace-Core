package signage

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
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

// Rule is one entry of a display's or a group's ordered rule list: "when condition show this scene list".
// Rules are drafts; they reach players only through a publication.
type Rule struct {
	ID                      uuid.UUID
	Position                int
	Enabled                 bool
	ConditionKind           ConditionKind
	Weekdays                []int
	TimeFrom, TimeTo        *string
	MachineIDs              []uuid.UUID
	MachineMatch            *MachineMatch
	AnnouncementTemplateIDs []uuid.UUID
	Scenes                  []SceneListItem
	MinSeconds              int
	MultiMode               MultiMode
	AlternateSeconds        int
}

// RuleInput is the writable part of a rule.
type RuleInput struct {
	Enabled                 bool
	ConditionKind           ConditionKind
	Weekdays                []int
	TimeFrom, TimeTo        *string
	MachineIDs              []uuid.UUID
	MachineMatch            *MachineMatch
	AnnouncementTemplateIDs []uuid.UUID
	Scenes                  []SceneListItem
	MinSeconds              int
	MultiMode               MultiMode
	AlternateSeconds        int
}

// RuleList is the ordered rule list of a display or a group together with the owner version that every
// rule write must quote (rules share the owner's optimistic-concurrency version).
type RuleList struct {
	Items        []Rule
	OwnerVersion int64
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
	if input.MultiMode != MultiModeSplit && input.MultiMode != MultiModeAlternate {
		return input, validation("multiMode must be split or alternate")
	}
	if input.AlternateSeconds < 3 || input.AlternateSeconds > 600 {
		return input, validation("alternateSeconds must be between 3 and 600")
	}
	scenes, err := checkSceneList(input.Scenes, "scenes")
	if err != nil {
		return input, err
	}
	input.Scenes = scenes
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
	case ConditionTimeWindow:
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
	case ConditionMachinePrinting:
		if len(input.MachineIDs) == 0 {
			return input, validation("a machine rule needs at least one machine")
		}
		if input.MachineMatch == nil || (*input.MachineMatch != MachineMatchAny && *input.MachineMatch != MachineMatchAll) {
			return input, validation("machineMatch must be any or all")
		}
		if len(input.Weekdays) > 0 || !noTime || len(input.AnnouncementTemplateIDs) > 0 {
			return input, validation("a machine rule cannot have time or announcement conditions")
		}
	case ConditionAnnouncementActive:
		if len(input.Weekdays) > 0 || !noTime || !noMachines {
			return input, validation("an announcement rule only takes announcement template filters")
		}
	case ConditionLiveDataUnavailable:
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
		Position:      int(row.Position),
		Enabled:       row.Enabled,
		ConditionKind: ConditionKind(row.ConditionKind),
		Weekdays:      make([]int, 0, len(row.Weekdays)), MachineMatch: optional.Convert[MachineMatch](row.MachineMatch),
		MinSeconds: int(row.MinSeconds), MultiMode: MultiMode(row.MultiMode), AlternateSeconds: int(row.AlternateSeconds),
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
	scenes, err := decodeSceneList(row.Scenes)
	if err != nil {
		return Rule{}, err
	}
	if len(scenes) == 0 {
		return Rule{}, errors.New("rule has no scenes")
	}
	rule.Scenes = scenes
	return rule, nil
}

// clockText trims PostgreSQL's HH:MM:SS to HH:MM.
func clockText(value string) string {
	if len(value) >= 5 {
		return value[:5]
	}
	return value
}

// loadRuleLists reads the rules of displays and of groups, each keyed by its owner's id.
func loadRuleLists(
	ctx context.Context,
	q *signagedb.Queries,
	displayIDs, groupIDs []uuid.UUID,
) (byDisplay, byGroup map[uuid.UUID][]Rule, err error) {
	byDisplay, byGroup = map[uuid.UUID][]Rule{}, map[uuid.UUID][]Rule{}
	if len(displayIDs) == 0 && len(groupIDs) == 0 {
		return byDisplay, byGroup, nil
	}
	rows, err := q.ListSignageRules(ctx, signagedb.ListSignageRulesParams{
		DisplayIds: uuidStrings(displayIDs), GroupIds: uuidStrings(groupIDs),
	})
	if err != nil {
		return nil, nil, err
	}
	for _, row := range rows {
		rule, err := ruleFromRow(row)
		if err != nil {
			return nil, nil, err
		}
		if row.DisplayID != nil {
			byDisplay[*row.DisplayID] = append(byDisplay[*row.DisplayID], rule)
		} else if row.GroupID != nil {
			byGroup[*row.GroupID] = append(byGroup[*row.GroupID], rule)
		}
	}
	return byDisplay, byGroup, nil
}

// loadRules reads the own rules of displays.
func loadRules(ctx context.Context, q *signagedb.Queries, displayIDs []uuid.UUID) (map[uuid.UUID][]Rule, error) {
	byDisplay, _, err := loadRuleLists(ctx, q, displayIDs, nil)
	return byDisplay, err
}

// loadOwnerRules reads the rules of one owner in order, never nil.
func loadOwnerRules(ctx context.Context, q *signagedb.Queries, owner ruleOwner) ([]Rule, error) {
	var rules []Rule
	if owner.isGroup() {
		_, byGroup, err := loadRuleLists(ctx, q, nil, []uuid.UUID{owner.GroupID})
		if err != nil {
			return nil, err
		}
		rules = byGroup[owner.GroupID]
	} else {
		byDisplay, err := loadRules(ctx, q, []uuid.UUID{owner.DisplayID})
		if err != nil {
			return nil, err
		}
		rules = byDisplay[owner.DisplayID]
	}
	if rules == nil {
		rules = []Rule{}
	}
	return rules, nil
}

// verifyRuleReferences checks that the machines, templates and scenes of a rule exist and share-locks
// them so a concurrent deletion either waits for this transaction or finds the new reference. Every scene
// of the list must have exactly the owner's aspect ratio.
func verifyRuleReferences(ctx context.Context, q *signagedb.Queries, ratio AspectRatio, input RuleInput) error {
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
	return verifySceneList(ctx, q, ratio, input.Scenes, "scenes")
}

func ruleParams(owner ruleOwner, ruleID uuid.UUID, position int, input RuleInput) signagedb.InsertSignageRuleParams {
	weekdays := make([]int16, 0, len(input.Weekdays))
	for _, day := range input.Weekdays {
		weekdays = append(weekdays, int16(day))
	}
	return signagedb.InsertSignageRuleParams{
		ID:                      ruleID,
		DisplayID:               owner.displayArg(),
		GroupID:                 owner.groupArg(),
		Position:                int32(position),
		Enabled:                 input.Enabled,
		ConditionKind:           string(input.ConditionKind),
		Weekdays:                weekdays,
		TimeFrom:                input.TimeFrom,
		TimeTo:                  input.TimeTo,
		MachineIds:              uuidStrings(input.MachineIDs),
		MachineMatch:            optional.Convert[string](input.MachineMatch),
		AnnouncementTemplateIds: uuidStrings(input.AnnouncementTemplateIDs),
		MinSeconds:              int32(input.MinSeconds),
		MultiMode:               string(input.MultiMode),
		AlternateSeconds:        int32(input.AlternateSeconds),
	}
}

// ruleInputOf is the writable part of a stored rule (used when a display leaves its group and copies the
// group's rules).
func ruleInputOf(rule Rule) RuleInput {
	return RuleInput{
		Enabled: rule.Enabled, ConditionKind: rule.ConditionKind, Weekdays: rule.Weekdays,
		TimeFrom: rule.TimeFrom, TimeTo: rule.TimeTo, MachineIDs: rule.MachineIDs, MachineMatch: rule.MachineMatch,
		AnnouncementTemplateIDs: rule.AnnouncementTemplateIDs, Scenes: rule.Scenes,
		MinSeconds: rule.MinSeconds, MultiMode: rule.MultiMode, AlternateSeconds: rule.AlternateSeconds,
	}
}

// insertRule stores a rule with its scene list at the given position.
func insertRule(
	ctx context.Context,
	q *signagedb.Queries,
	owner ruleOwner,
	id uuid.UUID,
	position int,
	input RuleInput,
) error {
	if err := databaseError(q.InsertSignageRule(ctx, ruleParams(owner, id, position, input))); err != nil {
		return err
	}
	return replaceRuleScenes(ctx, q, id, input.Scenes)
}

// ListRules returns a display's rules in evaluation order. A display in a group shows the group's rules,
// and the version is then the group's.
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
	if display.GroupID != nil {
		return s.listGroupRules(ctx, q, *display.GroupID)
	}
	items, err := loadOwnerRules(ctx, q, ruleOwner{DisplayID: displayID})
	if err != nil {
		return RuleList{}, err
	}
	return RuleList{Items: items, OwnerVersion: display.Version}, nil
}

// ListGroupRules returns a group's rules in evaluation order.
func (s *Service) ListGroupRules(
	ctx context.Context,
	principal authorization.Principal,
	groupID uuid.UUID,
) (RuleList, error) {
	if err := requireRead(principal); err != nil {
		return RuleList{}, err
	}
	return s.listGroupRules(ctx, signagedb.New(s.pool), groupID)
}

func (s *Service) listGroupRules(ctx context.Context, q *signagedb.Queries, groupID uuid.UUID) (RuleList, error) {
	groups, err := q.ListSignageDisplayGroupViews(ctx, []string{groupID.String()})
	if err != nil {
		return RuleList{}, err
	}
	if len(groups) == 0 {
		return RuleList{}, apperror.NotFound
	}
	items, err := loadOwnerRules(ctx, q, ruleOwner{GroupID: groupID})
	if err != nil {
		return RuleList{}, err
	}
	return RuleList{Items: items, OwnerVersion: groups[0].Version}, nil
}

func displayInGroup() error {
	return apperror.New(
		http.StatusConflict,
		"display_in_group",
		"The display is in a group; edit the group's rules or leave the group first",
	)
}

// lockOwner locks the owner of a rule list, checks the expected version and returns the owner's aspect ratio.
// A display in a group has no rules of its own (409 display_in_group); a revoked display cannot be edited.
func lockOwner(ctx context.Context, q *signagedb.Queries, owner ruleOwner, expected int64) (AspectRatio, error) {
	if owner.isGroup() {
		group, err := q.GetSignageDisplayGroupForUpdate(ctx, owner.GroupID)
		if errors.Is(err, pgx.ErrNoRows) {
			return AspectRatio{}, apperror.NotFound
		}
		if err != nil {
			return AspectRatio{}, err
		}
		if group.Version != expected {
			return AspectRatio{}, apperror.StaleWrite
		}
		return aspectRatioOf(group.AspectWidth, group.AspectHeight), nil
	}
	display, err := q.GetSignageDisplayForUpdate(ctx, owner.DisplayID)
	if errors.Is(err, pgx.ErrNoRows) {
		return AspectRatio{}, apperror.NotFound
	}
	if err != nil {
		return AspectRatio{}, err
	}
	if display.GroupID != nil {
		return AspectRatio{}, displayInGroup()
	}
	if display.Version != expected {
		return AspectRatio{}, apperror.StaleWrite
	}
	if display.RevokedAt.Valid || display.DeviceRevokedAt.Valid {
		return AspectRatio{}, displayRevoked()
	}
	return aspectRatioOf(display.AspectWidth, display.AspectHeight), nil
}

// bumpOwnerVersion increments the version of a rule list's owner.
func bumpOwnerVersion(ctx context.Context, q *signagedb.Queries, owner ruleOwner, expected int64) (int64, error) {
	if owner.isGroup() {
		return q.BumpSignageDisplayGroupVersion(
			ctx,
			signagedb.BumpSignageDisplayGroupVersionParams{ID: owner.GroupID, ExpectedVersion: expected},
		)
	}
	return q.BumpSignageDisplayVersion(
		ctx,
		signagedb.BumpSignageDisplayVersionParams{ID: owner.DisplayID, ExpectedVersion: expected},
	)
}

// ruleMutation runs one rule write under the owner's lock. Rules share the owner's version:
// every write must quote the current version and bumps it, so concurrent edits of the same
// rule list conflict as a whole (409 stale_write) and a reorder is atomic by construction.
func (s *Service) ruleMutation(
	ctx context.Context,
	principal authorization.Principal,
	owner ruleOwner,
	expected int64,
	requestID *uuid.UUID,
	action, resource string,
	resourceID func() uuid.UUID,
	fields []string,
	apply func(q *signagedb.Queries, ratio AspectRatio, rules []Rule) error,
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
	ratio, err := lockOwner(ctx, q, owner, expected)
	if err != nil {
		return RuleList{}, err
	}
	loaded, err := loadOwnerRules(ctx, q, owner)
	if err != nil {
		return RuleList{}, err
	}
	if err := apply(q, ratio, loaded); err != nil {
		return RuleList{}, err
	}
	version, err := bumpOwnerVersion(ctx, q, owner, expected)
	if err != nil {
		return RuleList{}, err
	}
	if err := writeAudit(ctx, tx, principal, action, resource, resourceID(), requestID, fields); err != nil {
		return RuleList{}, err
	}
	items, err := loadOwnerRules(ctx, q, owner)
	if err != nil {
		return RuleList{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RuleList{}, err
	}
	return RuleList{Items: items, OwnerVersion: version}, nil
}

func displayRevoked() error {
	return apperror.New(http.StatusConflict, "signage_display_revoked", "The display is revoked")
}

var ruleFields = []string{"enabled", "condition", "scenes", "minSeconds", "multiMode", "alternateSeconds"}

// ruleFieldsOf names the changed fields of a rule audit; a group's rule also names groupId so that the
// audit trail tells group rules from display rules.
func ruleFieldsOf(owner ruleOwner, fields []string) []string {
	if !owner.isGroup() {
		return fields
	}
	return append([]string{"groupId"}, fields...)
}

// CreateRule appends a rule to the end of the display's rule list.
func (s *Service) CreateRule(
	ctx context.Context,
	principal authorization.Principal,
	displayID uuid.UUID,
	expected int64,
	input RuleInput,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.createRule(ctx, principal, ruleOwner{DisplayID: displayID}, expected, input, requestID)
}

// CreateGroupRule appends a rule to the end of the group's rule list.
func (s *Service) CreateGroupRule(
	ctx context.Context,
	principal authorization.Principal,
	groupID uuid.UUID,
	expected int64,
	input RuleInput,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.createRule(ctx, principal, ruleOwner{GroupID: groupID}, expected, input, requestID)
}

func (s *Service) createRule(
	ctx context.Context,
	principal authorization.Principal,
	owner ruleOwner,
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
	id := ids.New()
	return s.ruleMutation(
		ctx,
		principal,
		owner,
		expected,
		requestID,
		"signage_rule.created",
		"signage_rule",
		func() uuid.UUID { return id },
		ruleFieldsOf(owner, ruleFields),
		func(q *signagedb.Queries, ratio AspectRatio, rules []Rule) error {
			if len(rules) >= maxRulesPerDisplay {
				return validation("a display or group has at most %d rules", maxRulesPerDisplay)
			}
			if err := verifyRuleReferences(ctx, q, ratio, checked); err != nil {
				return err
			}
			return insertRule(ctx, q, owner, id, len(rules), checked)
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

// UpdateRule replaces all writable fields of a display's rule.
func (s *Service) UpdateRule(
	ctx context.Context,
	principal authorization.Principal,
	displayID, ruleID uuid.UUID,
	expected int64,
	input RuleInput,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.updateRule(ctx, principal, ruleOwner{DisplayID: displayID}, ruleID, expected, input, requestID)
}

// UpdateGroupRule replaces all writable fields of a group's rule.
func (s *Service) UpdateGroupRule(
	ctx context.Context,
	principal authorization.Principal,
	groupID, ruleID uuid.UUID,
	expected int64,
	input RuleInput,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.updateRule(ctx, principal, ruleOwner{GroupID: groupID}, ruleID, expected, input, requestID)
}

func (s *Service) updateRule(
	ctx context.Context,
	principal authorization.Principal,
	owner ruleOwner,
	ruleID uuid.UUID,
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
		owner,
		expected,
		requestID,
		"signage_rule.updated",
		"signage_rule",
		func() uuid.UUID { return ruleID },
		ruleFieldsOf(owner, ruleFields),
		func(q *signagedb.Queries, ratio AspectRatio, rules []Rule) error {
			if _, ok := findRule(rules, ruleID); !ok {
				return apperror.NotFound
			}
			if err := verifyRuleReferences(ctx, q, ratio, checked); err != nil {
				return err
			}
			params := ruleParams(owner, ruleID, 0, checked)
			_, err := q.UpdateSignageRule(ctx, signagedb.UpdateSignageRuleParams{
				Enabled:                 params.Enabled,
				ConditionKind:           params.ConditionKind,
				Weekdays:                params.Weekdays,
				TimeFrom:                params.TimeFrom,
				TimeTo:                  params.TimeTo,
				MachineIds:              params.MachineIds,
				MachineMatch:            params.MachineMatch,
				AnnouncementTemplateIds: params.AnnouncementTemplateIds,
				MinSeconds:              params.MinSeconds,
				MultiMode:               params.MultiMode,
				AlternateSeconds:        params.AlternateSeconds,
				ID:                      ruleID,
				DisplayID:               owner.displayArg(),
				GroupID:                 owner.groupArg(),
			})
			if err := databaseError(err); err != nil {
				return err
			}
			return replaceRuleScenes(ctx, q, ruleID, checked.Scenes)
		},
	)
}

// SetRuleEnabled switches a display's rule on or off without touching anything else.
func (s *Service) SetRuleEnabled(
	ctx context.Context,
	principal authorization.Principal,
	displayID, ruleID uuid.UUID,
	expected int64,
	enabled bool,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.setRuleEnabled(ctx, principal, ruleOwner{DisplayID: displayID}, ruleID, expected, enabled, requestID)
}

// SetGroupRuleEnabled switches a group's rule on or off without touching anything else.
func (s *Service) SetGroupRuleEnabled(
	ctx context.Context,
	principal authorization.Principal,
	groupID, ruleID uuid.UUID,
	expected int64,
	enabled bool,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.setRuleEnabled(ctx, principal, ruleOwner{GroupID: groupID}, ruleID, expected, enabled, requestID)
}

func (s *Service) setRuleEnabled(
	ctx context.Context,
	principal authorization.Principal,
	owner ruleOwner,
	ruleID uuid.UUID,
	expected int64,
	enabled bool,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.ruleMutation(
		ctx,
		principal,
		owner,
		expected,
		requestID,
		"signage_rule.updated",
		"signage_rule",
		func() uuid.UUID { return ruleID },
		ruleFieldsOf(owner, []string{"enabled"}),
		func(q *signagedb.Queries, _ AspectRatio, rules []Rule) error {
			if _, ok := findRule(rules, ruleID); !ok {
				return apperror.NotFound
			}
			_, err := q.SetSignageRuleEnabled(ctx, signagedb.SetSignageRuleEnabledParams{
				Enabled: enabled, ID: ruleID, DisplayID: owner.displayArg(), GroupID: owner.groupArg(),
			})
			return err
		},
	)
}

// DeleteRule removes a display's rule and closes the gap in the order.
func (s *Service) DeleteRule(
	ctx context.Context,
	principal authorization.Principal,
	displayID, ruleID uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.deleteRule(ctx, principal, ruleOwner{DisplayID: displayID}, ruleID, expected, requestID)
}

// DeleteGroupRule removes a group's rule and closes the gap in the order.
func (s *Service) DeleteGroupRule(
	ctx context.Context,
	principal authorization.Principal,
	groupID, ruleID uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.deleteRule(ctx, principal, ruleOwner{GroupID: groupID}, ruleID, expected, requestID)
}

func (s *Service) deleteRule(
	ctx context.Context,
	principal authorization.Principal,
	owner ruleOwner,
	ruleID uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.ruleMutation(
		ctx,
		principal,
		owner,
		expected,
		requestID,
		"signage_rule.deleted",
		"signage_rule",
		func() uuid.UUID { return ruleID },
		ruleFieldsOf(owner, nil),
		func(q *signagedb.Queries, _ AspectRatio, rules []Rule) error {
			if _, ok := findRule(rules, ruleID); !ok {
				return apperror.NotFound
			}
			if _, err := q.DeleteSignageRule(ctx, signagedb.DeleteSignageRuleParams{
				ID: ruleID, DisplayID: owner.displayArg(), GroupID: owner.groupArg(),
			}); err != nil {
				return err
			}
			position := 0
			for _, rule := range rules {
				if rule.ID == ruleID {
					continue
				}
				if err := q.SetSignageRulePosition(ctx, signagedb.SetSignageRulePositionParams{
					Position: int32(position), ID: rule.ID, DisplayID: owner.displayArg(), GroupID: owner.groupArg(),
				}); err != nil {
					return err
				}
				position++
			}
			return nil
		},
	)
}

// ReorderRules sets the complete evaluation order of a display's rules in one transaction. ruleIDs must
// name every rule of the display exactly once.
func (s *Service) ReorderRules(
	ctx context.Context,
	principal authorization.Principal,
	displayID uuid.UUID,
	expected int64,
	ruleIDs []uuid.UUID,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.reorderRules(ctx, principal, ruleOwner{DisplayID: displayID}, expected, ruleIDs, requestID)
}

// ReorderGroupRules sets the complete evaluation order of a group's rules in one transaction.
func (s *Service) ReorderGroupRules(
	ctx context.Context,
	principal authorization.Principal,
	groupID uuid.UUID,
	expected int64,
	ruleIDs []uuid.UUID,
	requestID *uuid.UUID,
) (RuleList, error) {
	return s.reorderRules(ctx, principal, ruleOwner{GroupID: groupID}, expected, ruleIDs, requestID)
}

func (s *Service) reorderRules(
	ctx context.Context,
	principal authorization.Principal,
	owner ruleOwner,
	expected int64,
	ruleIDs []uuid.UUID,
	requestID *uuid.UUID,
) (RuleList, error) {
	action, resource, resourceID := "signage_display.rules_reordered", "signage_display", owner.DisplayID
	if owner.isGroup() {
		action, resource, resourceID = "signage_display_group.rules_reordered", "signage_display_group", owner.GroupID
	}
	return s.ruleMutation(
		ctx,
		principal,
		owner,
		expected,
		requestID,
		action,
		resource,
		func() uuid.UUID { return resourceID },
		[]string{"ruleOrder"},
		func(q *signagedb.Queries, _ AspectRatio, rules []Rule) error {
			if len(ruleIDs) != len(rules) || len(distinct(ruleIDs)) != len(ruleIDs) {
				return validation("ruleIds must list every rule exactly once")
			}
			for _, id := range ruleIDs {
				if _, ok := findRule(rules, id); !ok {
					return validation("ruleIds must list every rule exactly once")
				}
			}
			for position, id := range ruleIDs {
				if err := q.SetSignageRulePosition(ctx, signagedb.SetSignageRulePositionParams{
					Position: int32(position), ID: id, DisplayID: owner.displayArg(), GroupID: owner.groupArg(),
				}); err != nil {
					return err
				}
			}
			return nil
		},
	)
}
