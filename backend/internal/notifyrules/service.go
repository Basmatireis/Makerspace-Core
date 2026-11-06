package notifyrules

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Service manages categories, rules, consents and preferences. Central rules and categories need
// notification_rules.read or .manage. Personal subscriptions, a person's own consents and channel choices need
// only a staff session and are scoped to the principal by every query.
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// NewService builds the service.
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, now: func() time.Time { return time.Now().UTC() }}
}

func auditEvent(p authorization.Principal, action, resource string, id uuid.UUID, requestID *uuid.UUID, fields []string) audit.Event {
	actor := p.AccountID
	return audit.Event{
		ActorAccountID: &actor, Action: action, ResourceType: resource, ResourceID: &id, RequestID: requestID,
		ChangedFields: fields,
	}
}

func noRows(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	return err
}

func uniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func cleanName(value string, limit int, what string) (string, error) {
	value = strings.TrimSpace(value)
	if n := utf8.RuneCountInString(value); n < 1 || n > limit || strings.ContainsFunc(value, unicode.IsControl) {
		return "", apperror.InvalidField(what + ": must be one line of 1 to " + itoa(limit) + " characters")
	}
	return value, nil
}

func cleanText(value string, limit int, what string) (string, error) {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) > limit ||
		strings.ContainsFunc(value, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\t' }) {
		return "", apperror.InvalidField(what + ": must be plain text of at most " + itoa(limit) + " characters")
	}
	return value, nil
}

func itoa(n int) string { return strconv.Itoa(n) }

// ---- categories ----

func categoryFromRow(row notifyrulesdb.GetCategoryRow) Category {
	return Category{
		ID: row.ID, Key: row.Key, Name: row.Name, Description: row.Description, Basis: Basis(row.Basis),
		TextVersion: int(row.TextVersion), TextChangedAt: row.TextChangedAt, Position: int(row.Position),
		RuleCount: row.RuleCount, Version: row.Version, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}

func isService(c Category) bool { return c.Key != nil && *c.Key == ServiceCategoryKey }

func categoryProtected() error {
	return apperror.Conflicting(
		"notification_category_protected", "The service category is fixed and can be neither changed nor deleted.",
	)
}

// ListCategories returns every category with the number of rules using it. Needs notification_rules.read.
func (s *Service) ListCategories(ctx context.Context, p authorization.Principal) ([]Category, error) {
	if !p.Has(authorization.NotificationRulesRead) && !p.Has(authorization.NotificationRulesManage) {
		return nil, apperror.PermissionDenied
	}
	return s.categories(ctx, notifyrulesdb.New(s.pool))
}

func (s *Service) categories(ctx context.Context, queries *notifyrulesdb.Queries) ([]Category, error) {
	rows, err := queries.ListCategories(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]Category, 0, len(rows))
	for _, row := range rows {
		items = append(items, categoryFromRow(notifyrulesdb.GetCategoryRow(row)))
	}
	return items, nil
}

// CreateCategory adds a category. Needs notification_rules.manage.
func (s *Service) CreateCategory(
	ctx context.Context,
	p authorization.Principal,
	input CategoryInput,
	requestID *uuid.UUID,
) (Category, error) {
	if !p.Has(authorization.NotificationRulesManage) {
		return Category{}, apperror.PermissionDenied
	}
	name, err := cleanName(input.Name, MaxCategoryName, "name")
	if err != nil {
		return Category{}, err
	}
	description, err := cleanText(input.Description, MaxCategoryText, "description")
	if err != nil {
		return Category{}, err
	}
	if input.Basis != BasisRequired && input.Basis != BasisConsent {
		return Category{}, apperror.InvalidField("basis: must be required or consent")
	}
	if input.Position < 0 || input.Position > 1000 {
		return Category{}, apperror.InvalidField("position: must be between 0 and 1000")
	}
	id := ids.New()
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		queries := notifyrulesdb.New(tx)
		count, err := queries.CountCategories(ctx)
		if err != nil {
			return err
		}
		if count >= MaxCategories {
			return apperror.Conflicting("notification_category_limit", "There are too many notification categories.")
		}
		if err := queries.InsertCategory(ctx, notifyrulesdb.InsertCategoryParams{
			ID: id, Name: name, Description: description, Basis: string(input.Basis), Position: int32(input.Position), //nolint:gosec // validated above
		}); err != nil {
			if uniqueViolation(err) {
				return apperror.Conflicting("notification_category_exists", "A category with this name already exists.")
			}
			return err
		}
		return audit.Write(ctx, tx, auditEvent(p, "notification_category.created", "notification_category", id, requestID,
			[]string{"name", "description", "basis", "position"}))
	})
	if err != nil {
		return Category{}, err
	}
	return s.category(ctx, notifyrulesdb.New(s.pool), id)
}

func (s *Service) category(ctx context.Context, queries *notifyrulesdb.Queries, id uuid.UUID) (Category, error) {
	row, err := queries.GetCategory(ctx, id)
	if err != nil {
		return Category{}, noRows(err)
	}
	return categoryFromRow(row), nil
}

// UpdateCategory renames or re-describes a category and can ask everyone for consent again. The basis never
// changes. The service category cannot be changed. Needs notification_rules.manage.
func (s *Service) UpdateCategory(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	input CategoryInput,
	requestID *uuid.UUID,
) (Category, error) {
	if !p.Has(authorization.NotificationRulesManage) {
		return Category{}, apperror.PermissionDenied
	}
	name, err := cleanName(input.Name, MaxCategoryName, "name")
	if err != nil {
		return Category{}, err
	}
	description, err := cleanText(input.Description, MaxCategoryText, "description")
	if err != nil {
		return Category{}, err
	}
	if input.Position < 0 || input.Position > 1000 {
		return Category{}, apperror.InvalidField("position: must be between 0 and 1000")
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		queries := notifyrulesdb.New(tx)
		current, err := queries.GetCategoryForUpdate(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if current.Key != nil && *current.Key == ServiceCategoryKey {
			return categoryProtected()
		}
		if current.Version != expected {
			return apperror.StaleWrite
		}
		var changed []string
		if current.Name != name {
			changed = append(changed, "name")
		}
		if current.Description != description {
			changed = append(changed, "description")
		}
		if int(current.Position) != input.Position {
			changed = append(changed, "position")
		}
		bump := int32(0)
		if input.AskAgain {
			if Basis(current.Basis) != BasisConsent {
				return apperror.InvalidField("askAgain: only a consent category can ask again")
			}
			bump = 1
			changed = append(changed, "textVersion")
		}
		if len(changed) == 0 {
			return nil
		}
		if _, err := queries.UpdateCategory(ctx, notifyrulesdb.UpdateCategoryParams{
			Name: name, Description: description, Position: int32(input.Position), //nolint:gosec // validated above
			VersionBump: bump, ID: id, ExpectedVersion: expected,
		}); err != nil {
			if uniqueViolation(err) {
				return apperror.Conflicting("notification_category_exists", "A category with this name already exists.")
			}
			return err
		}
		return audit.Write(ctx, tx, auditEvent(p, "notification_category.updated", "notification_category", id, requestID, changed))
	})
	if err != nil {
		return Category{}, err
	}
	return s.category(ctx, notifyrulesdb.New(s.pool), id)
}

// DeleteCategory removes a category no rule uses. Needs notification_rules.manage.
func (s *Service) DeleteCategory(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if !p.Has(authorization.NotificationRulesManage) {
		return apperror.PermissionDenied
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		queries := notifyrulesdb.New(tx)
		current, err := queries.GetCategoryForUpdate(ctx, id)
		if err != nil {
			return noRows(err)
		}
		if current.Key != nil && *current.Key == ServiceCategoryKey {
			return categoryProtected()
		}
		if current.Version != expected {
			return apperror.StaleWrite
		}
		row, err := queries.GetCategory(ctx, id)
		if err != nil {
			return err
		}
		if row.RuleCount > 0 {
			return apperror.Conflicting(
				"notification_category_in_use", "Notification rules use this category; move or delete them first.",
			)
		}
		if _, err := queries.DeleteCategory(ctx, notifyrulesdb.DeleteCategoryParams{ID: id, ExpectedVersion: expected}); err != nil {
			return err
		}
		return audit.Write(ctx, tx, auditEvent(p, "notification_category.deleted", "notification_category", id, requestID, nil))
	})
}
