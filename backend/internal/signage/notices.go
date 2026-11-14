package signage

import (
	"context"
	"errors"
	"net/http"
	"slices"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MaxNoticeRules is how many notification rules a display or group can choose one by one.
const MaxNoticeRules = 200

// NoticeSelection is which notification rules' notices a display or display group shows: every rule's (AllRules) or
// the chosen ones. A display shows its own choice and its group's. The choice is live and needs no publishing.
type NoticeSelection struct {
	AllRules bool
	RuleIDs  []uuid.UUID
}

// NotificationRule is a central notification rule as signage managers see it when choosing notices: its name only.
type NotificationRule struct {
	ID               uuid.UUID
	Name             string
	Enabled          bool
	HasSignageAction bool
}

// ListNotificationRules lists the central notification rules with a signage action, and every rule a display or
// group chose.
func (s *Service) ListNotificationRules(ctx context.Context, principal authorization.Principal) ([]NotificationRule, error) {
	if err := requireRead(principal); err != nil {
		return nil, err
	}
	rows, err := signagedb.New(s.pool).ListSignageNotificationRules(ctx)
	if err != nil {
		return nil, err
	}
	rules := make([]NotificationRule, 0, len(rows))
	for _, row := range rows {
		rules = append(rules, NotificationRule{ID: row.ID, Name: row.Name, Enabled: row.Enabled, HasSignageAction: row.HasSignageAction})
	}
	return rules, nil
}

// DisplayNotices returns the display's own choice; what its group chose is on the group.
func (s *Service) DisplayNotices(ctx context.Context, principal authorization.Principal, id uuid.UUID) (NoticeSelection, error) {
	if err := requireRead(principal); err != nil {
		return NoticeSelection{}, err
	}
	row, err := signagedb.New(s.pool).GetSignageDisplayNoticeChoice(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return NoticeSelection{}, apperror.NotFound
	}
	if err != nil {
		return NoticeSelection{}, err
	}
	return NoticeSelection{AllRules: row.AllRuleNotices, RuleIDs: row.RuleIds}, nil
}

// GroupNotices returns the group's choice, which its member displays show besides their own.
func (s *Service) GroupNotices(ctx context.Context, principal authorization.Principal, id uuid.UUID) (NoticeSelection, error) {
	if err := requireRead(principal); err != nil {
		return NoticeSelection{}, err
	}
	row, err := signagedb.New(s.pool).GetSignageDisplayGroupNoticeChoice(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return NoticeSelection{}, apperror.NotFound
	}
	if err != nil {
		return NoticeSelection{}, err
	}
	return NoticeSelection{AllRules: row.AllRuleNotices, RuleIDs: row.RuleIds}, nil
}

// SetDisplayNotices replaces the display's choice. A web embed never shows notices.
func (s *Service) SetDisplayNotices(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	input NoticeSelection,
	requestID *uuid.UUID,
) (NoticeSelection, error) {
	return s.setNotices(ctx, principal, input, func(q *signagedb.Queries, ruleIDs []uuid.UUID) error {
		kind, err := q.LockSignageDisplayKind(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		}
		if err != nil {
			return err
		}
		if DisplayKind(kind) == DisplayKindWebEmbed {
			return apperror.New(http.StatusUnprocessableEntity, "signage_web_embed", "A web embed never shows notices of notification rules")
		}
		if err := q.SetSignageDisplayAllRuleNotices(
			ctx, signagedb.SetSignageDisplayAllRuleNoticesParams{ID: id, AllRuleNotices: input.AllRules},
		); err != nil {
			return err
		}
		if err := q.DeleteSignageDisplayNoticeOptIns(ctx, &id); err != nil {
			return err
		}
		for _, rule := range ruleIDs {
			if err := q.InsertSignageNoticeOptIn(
				ctx, signagedb.InsertSignageNoticeOptInParams{ID: ids.New(), RuleID: rule, DisplayID: &id},
			); err != nil {
				return err
			}
		}
		return nil
	}, signagedb.ListChoosableNotificationRuleIDsParams{DisplayID: &id}, "signage_display.notices_changed", "signage_display", id, requestID)
}

// SetGroupNotices replaces the group's choice; its member displays show it at once.
func (s *Service) SetGroupNotices(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	input NoticeSelection,
	requestID *uuid.UUID,
) (NoticeSelection, error) {
	return s.setNotices(ctx, principal, input, func(q *signagedb.Queries, ruleIDs []uuid.UUID) error {
		if _, err := q.LockSignageDisplayGroup(ctx, id); errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		} else if err != nil {
			return err
		}
		if err := q.SetSignageDisplayGroupAllRuleNotices(
			ctx, signagedb.SetSignageDisplayGroupAllRuleNoticesParams{ID: id, AllRuleNotices: input.AllRules},
		); err != nil {
			return err
		}
		if err := q.DeleteSignageDisplayGroupNoticeOptIns(ctx, &id); err != nil {
			return err
		}
		for _, rule := range ruleIDs {
			if err := q.InsertSignageNoticeOptIn(
				ctx, signagedb.InsertSignageNoticeOptInParams{ID: ids.New(), RuleID: rule, GroupID: &id},
			); err != nil {
				return err
			}
		}
		return nil
	}, signagedb.ListChoosableNotificationRuleIDsParams{GroupID: &id}, "signage_display_group.notices_changed", "signage_display_group", id, requestID)
}

// setNotices checks the permission and the chosen rules (see ListChoosableNotificationRuleIDs), then stores the choice and its audit event in one
// transaction.
func (s *Service) setNotices(
	ctx context.Context,
	principal authorization.Principal,
	input NoticeSelection,
	store func(q *signagedb.Queries, ruleIDs []uuid.UUID) error,
	owner signagedb.ListChoosableNotificationRuleIDsParams,
	action, resource string,
	id uuid.UUID,
	requestID *uuid.UUID,
) (NoticeSelection, error) {
	if err := requireManage(principal); err != nil {
		return NoticeSelection{}, err
	}
	ruleIDs := slices.Clone(input.RuleIDs)
	slices.SortFunc(ruleIDs, func(a, b uuid.UUID) int { return slices.Compare(a[:], b[:]) })
	ruleIDs = slices.Compact(ruleIDs)
	if len(ruleIDs) > MaxNoticeRules {
		return NoticeSelection{}, validation("choose at most %d notification rules", MaxNoticeRules)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return NoticeSelection{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	if len(ruleIDs) > 0 {
		owner.Ids = make([]string, 0, len(ruleIDs))
		for _, rule := range ruleIDs {
			owner.Ids = append(owner.Ids, rule.String())
		}
		found, err := q.ListChoosableNotificationRuleIDs(ctx, owner)
		if err != nil {
			return NoticeSelection{}, err
		}
		if len(found) != len(ruleIDs) {
			return NoticeSelection{}, validation("a chosen notification rule does not exist or shows nothing on signage")
		}
	}
	if err := store(q, ruleIDs); err != nil {
		return NoticeSelection{}, err
	}
	if err := writeAudit(ctx, tx, principal, action, resource, id, requestID, []string{"notices"}); err != nil {
		return NoticeSelection{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return NoticeSelection{}, err
	}
	return NoticeSelection{AllRules: input.AllRules, RuleIDs: ruleIDs}, nil
}
