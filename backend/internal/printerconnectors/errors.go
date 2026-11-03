package printerconnectors

import (
	"context"
	"errors"
	"fmt"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/printererrors"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const (
	// resolvedErrorWindow is how long resolved errors stay in the machine's list.
	resolvedErrorWindow = 30 * 24 * time.Hour
	maxListedErrors     = 200
	maxErrorTitle       = 160
	maxErrorDescription = 2000
	maxErrorLink        = 500
)

// PrinterError is one reported error of a machine with what the catalog knows about its code.
type PrinterError struct {
	ID              uuid.UUID
	SourceFamily    string
	Code            string
	Severity        *string
	Title           *string
	Description     *string
	Link            *string
	FirstObservedAt time.Time
	LastObservedAt  time.Time
	ResolvedAt      *time.Time
	RunID           *uuid.UUID
}

// ErrorCode is a catalog entry: what a code means and what to do.
type ErrorCode struct {
	ID           uuid.UUID
	SourceFamily string
	Code         string
	Title        string
	Description  string
	Link         *string
	// Source is manual for a meaning written here and bambu for one fetched from the published list.
	Source    string
	UpdatedAt time.Time
}

// ErrorCodeInput is the content of a catalog entry.
type ErrorCodeInput struct {
	Title       string
	Description string
	Link        *string
}

// ErrorFacts is what Core adds to a reported code: its level, the catalog's meaning and where to read more.
type ErrorFacts struct {
	Severity *string
	Title    *string
	Link     *string
}

// NotificationEvent is a printer event people can be told about.
type NotificationEvent string

const (
	NotifyPrinterError   NotificationEvent = "printer_error"
	NotifyRunFinished    NotificationEvent = "run_finished"
	NotifyFilamentChange NotificationEvent = "filament_change"
)

// NotificationRule says who is told about one printer event: the run's operator, the job's recipient, the holders
// of a role, and whether by e-mail too. MinSeverity only applies to printer errors.
type NotificationRule struct {
	Event                                  NotificationEvent
	NotifyOperator, NotifyRecipient, Email bool
	RoleID                                 *uuid.UUID
	RoleName                               *string
	MinSeverity                            *string
}

// NotificationSettings are the rules of every printer event.
type NotificationSettings struct {
	Events    []NotificationRule
	Version   int64
	UpdatedAt time.Time
}

// NotificationSettingsInput replaces the rules of the listed events.
type NotificationSettingsInput struct {
	Events          []NotificationRule
	ExpectedVersion int64
}

func validNotificationEvent(event NotificationEvent) bool {
	switch event {
	case NotifyPrinterError, NotifyRunFinished, NotifyFilamentChange:
		return true
	}
	return false
}

// validateNotificationRules checks the request before a transaction opens: known events, each at most once, and a
// minimum severity only on printer errors.
func validateNotificationRules(rules []NotificationRule) error {
	if len(rules) == 0 || len(rules) > 3 {
		return apperror.Invalid("events must list one to three rules")
	}
	seen := map[NotificationEvent]bool{}
	for _, rule := range rules {
		if !validNotificationEvent(rule.Event) || seen[rule.Event] {
			return apperror.Invalid("every event must be printer_error, run_finished or filament_change and appear once")
		}
		seen[rule.Event] = true
		if rule.MinSeverity != nil && (rule.Event != NotifyPrinterError || !validSeverity(*rule.MinSeverity)) {
			return apperror.Invalid("minSeverity is fatal, serious, common or info and only applies to printer_error")
		}
	}
	return nil
}

func validSeverity(value string) bool {
	switch value {
	case "fatal", "serious", "common", "info":
		return true
	}
	return false
}

func validSourceFamily(value string) bool { return value == "print" || value == "hms" }

// ListPrinterErrors lists the machine's open errors first, then those resolved within the last 30 days.
func (s *Service) ListPrinterErrors(ctx context.Context, p authorization.Principal, machineID uuid.UUID) ([]PrinterError, error) {
	if !p.Has(authorization.MachinesRead) {
		return nil, apperror.PermissionDenied
	}
	q := db.New(s.pool)
	exists, err := q.MachineExists(ctx, machineID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, apperror.NotFound
	}
	rows, err := q.ListPrinterErrorOccurrences(ctx, db.ListPrinterErrorOccurrencesParams{
		MachineID: machineID, ResolvedSince: time.Now().UTC().Add(-resolvedErrorWindow), RowLimit: maxListedErrors,
	})
	if err != nil {
		return nil, err
	}
	result := make([]PrinterError, 0, len(rows))
	for _, row := range rows {
		item := PrinterError{
			ID: row.ID, SourceFamily: row.SourceFamily, Code: row.OriginalCode, Severity: row.Severity,
			Title: row.CatalogTitle, Description: row.CatalogDescription, Link: row.CatalogLink,
			FirstObservedAt: row.FirstObservedAt, LastObservedAt: row.LastObservedAt, RunID: row.RunID,
		}
		if row.ResolvedAt.Valid {
			resolved := row.ResolvedAt.Time.UTC()
			item.ResolvedAt = &resolved
		}
		if item.Severity == nil {
			item.Severity = printererrors.Severity(item.SourceFamily, item.Code)
		}
		if item.Link == nil {
			item.Link = printererrors.WikiLink(item.SourceFamily, item.Code)
		}
		result = append(result, item)
	}
	return result, nil
}

// ClearPrinterErrors resolves the machine's open errors and deletes its resolved history. An error the printer still
// reports comes back with its next status.
func (s *Service) ClearPrinterErrors(ctx context.Context, p authorization.Principal, machineID uuid.UUID, requestID *uuid.UUID) error {
	if !p.Has(authorization.MachinesManage) {
		return apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	exists, err := q.MachineExists(ctx, machineID)
	if err != nil {
		return err
	}
	if !exists {
		return apperror.NotFound
	}
	resolved, err := q.ResolveOpenPrinterErrorOccurrences(ctx, db.ResolveOpenPrinterErrorOccurrencesParams{
		Now: time.Now().UTC(), AccountID: &p.AccountID, MachineID: machineID,
	})
	if err != nil {
		return err
	}
	deleted, err := q.DeleteResolvedPrinterErrorOccurrences(ctx, machineID)
	if err != nil {
		return err
	}
	actor := p.AccountID
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "printer_errors.cleared",
		ResourceType:   "machine",
		ResourceID:     &machineID,
		RequestID:      requestID,
		Metadata:       map[string]any{"countResolved": strconv.FormatInt(resolved, 10), "countDeleted": strconv.FormatInt(deleted, 10)},
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ErrorFacts describes reported codes for a live status: level, catalog meaning and link. keys are "family:code".
func (s *Service) ErrorFacts(ctx context.Context, items [][2]string) (map[string]ErrorFacts, error) {
	result := make(map[string]ErrorFacts, len(items))
	codes := make([]string, 0, len(items))
	for _, item := range items {
		codes = append(codes, item[1])
		result[item[0]+":"+item[1]] = ErrorFacts{
			Severity: printererrors.Severity(item[0], item[1]), Link: printererrors.WikiLink(item[0], item[1]),
		}
	}
	if len(codes) == 0 {
		return result, nil
	}
	rows, err := db.New(s.pool).ListPrinterErrorCodesByCodes(ctx, codes)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		key := row.SourceFamily + ":" + row.Code
		facts, ok := result[key]
		if !ok {
			continue
		}
		title := row.Title
		facts.Title = &title
		if row.Link != nil {
			facts.Link = row.Link
		}
		result[key] = facts
	}
	return result, nil
}

// ErrorCodeFilter narrows the catalog: a case-insensitive substring of code, meaning or description, one
// source family (print, hms) and one source (manual, bambu); empty values match everything.
type ErrorCodeFilter struct {
	Search       string
	SourceFamily string
	Source       string
}

// ListErrorCodes returns one page of the catalog, ordered by family and code, and how many entries match.
func (s *Service) ListErrorCodes(ctx context.Context, p authorization.Principal, filter ErrorCodeFilter, page, pageSize int) ([]ErrorCode, int64, error) {
	if !p.Has(authorization.MachinesRead) {
		return nil, 0, apperror.PermissionDenied
	}
	if page < 1 || pageSize < 1 || pageSize > 100 {
		return nil, 0, apperror.Invalid("page must be positive and pageSize must be between 1 and 100")
	}
	search := strings.TrimSpace(filter.Search)
	q := db.New(s.pool)
	rows, err := q.ListPrinterErrorCodes(ctx, db.ListPrinterErrorCodesParams{
		Search:       search,
		SourceFamily: filter.SourceFamily,
		Source:       filter.Source,
		PageLimit:    int32(pageSize),
		PageOffset:   int32((page - 1) * pageSize),
	})
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountPrinterErrorCodes(ctx, db.CountPrinterErrorCodesParams{
		Search:       search,
		SourceFamily: filter.SourceFamily,
		Source:       filter.Source,
	})
	if err != nil {
		return nil, 0, err
	}
	result := make([]ErrorCode, 0, len(rows))
	for _, row := range rows {
		result = append(result, errorCodeFrom(row))
	}
	return result, total, nil
}

// PutErrorCode records or replaces what a code means.
func (s *Service) PutErrorCode(
	ctx context.Context,
	p authorization.Principal,
	sourceFamily, code string,
	input ErrorCodeInput,
	requestID *uuid.UUID,
) (ErrorCode, error) {
	if !p.Has(authorization.MachinesManage) {
		return ErrorCode{}, apperror.PermissionDenied
	}
	code = strings.TrimSpace(code)
	if !validSourceFamily(sourceFamily) || code == "" || len(code) > 120 {
		return ErrorCode{}, apperror.Invalid("The code is invalid.")
	}
	title := strings.Join(strings.Fields(input.Title), " ")
	description := strings.TrimSpace(input.Description)
	if title == "" || utf8.RuneCountInString(title) > maxErrorTitle || utf8.RuneCountInString(description) > maxErrorDescription {
		return ErrorCode{}, apperror.Invalid("The title must have 1 to 160 characters and the description at most 2000.")
	}
	var link *string
	if input.Link != nil {
		value := strings.TrimSpace(*input.Link)
		if value != "" {
			parsed, err := url.Parse(value)
			if err != nil || parsed.Scheme != "https" || parsed.Host == "" || len(value) > maxErrorLink {
				return ErrorCode{}, apperror.Invalid("The link must be an https address.")
			}
			link = &value
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ErrorCode{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, err := db.New(tx).UpsertPrinterErrorCode(ctx, db.UpsertPrinterErrorCodeParams{
		ID: ids.New(), SourceFamily: sourceFamily, Code: code, Title: title, Description: description, Link: link,
	})
	if err != nil {
		return ErrorCode{}, fmt.Errorf("save printer error code: %w", err)
	}
	actor := p.AccountID
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "printer_error_code.saved",
		ResourceType:   "printer_error_code",
		ResourceID:     &row.ID,
		RequestID:      requestID,
		ChangedFields:  []string{"title", "description", "link"},
	}); err != nil {
		return ErrorCode{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ErrorCode{}, err
	}
	return errorCodeFrom(row), nil
}

// DeleteErrorCode removes a catalog entry.
func (s *Service) DeleteErrorCode(ctx context.Context, p authorization.Principal, sourceFamily, code string, requestID *uuid.UUID) error {
	if !p.Has(authorization.MachinesManage) {
		return apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	affected, err := db.New(tx).DeletePrinterErrorCode(ctx, db.DeletePrinterErrorCodeParams{SourceFamily: sourceFamily, Code: strings.TrimSpace(code)})
	if err != nil {
		return err
	}
	if affected == 0 {
		return apperror.NotFound
	}
	actor := p.AccountID
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "printer_error_code.deleted",
		ResourceType:   "printer_error_code",
		RequestID:      requestID,
		ChangedFields:  []string{"title", "description", "link"},
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// NotificationSettings returns who is told about printer events.
func (s *Service) NotificationSettings(ctx context.Context, p authorization.Principal) (NotificationSettings, error) {
	if !p.Has(authorization.MachinesRead) {
		return NotificationSettings{}, apperror.PermissionDenied
	}
	return loadNotificationSettings(ctx, db.New(s.pool))
}

func loadNotificationSettings(ctx context.Context, q *db.Queries) (NotificationSettings, error) {
	row, err := q.GetPrinterNotificationSettings(ctx)
	if err != nil {
		return NotificationSettings{}, err
	}
	rules, err := q.ListPrinterNotificationRules(ctx)
	if err != nil {
		return NotificationSettings{}, err
	}
	result := NotificationSettings{Events: make([]NotificationRule, 0, len(rules)), Version: row.Version, UpdatedAt: row.UpdatedAt.UTC()}
	for _, rule := range rules {
		result.Events = append(result.Events, NotificationRule{
			Event:           NotificationEvent(rule.Event),
			NotifyOperator:  rule.NotifyOperator,
			NotifyRecipient: rule.NotifyRecipient,
			Email:           rule.Email,
			RoleID:          rule.RoleID,
			RoleName:        rule.RoleName,
			MinSeverity:     rule.MinSeverity,
		})
	}
	return result, nil
}

// UpdateNotificationSettings replaces the rules of the listed printer events; the others stay.
func (s *Service) UpdateNotificationSettings(
	ctx context.Context,
	p authorization.Principal,
	input NotificationSettingsInput,
	requestID *uuid.UUID,
) (NotificationSettings, error) {
	if !p.Has(authorization.MachinesManage) {
		return NotificationSettings{}, apperror.PermissionDenied
	}
	if input.ExpectedVersion < 1 {
		return NotificationSettings{}, apperror.Invalid("expectedVersion must be positive")
	}
	if err := validateNotificationRules(input.Events); err != nil {
		return NotificationSettings{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return NotificationSettings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if _, err = q.LockPrinterNotificationSettings(ctx, input.ExpectedVersion); errors.Is(err, pgx.ErrNoRows) {
		return NotificationSettings{}, apperror.StaleWrite
	} else if err != nil {
		return NotificationSettings{}, err
	}
	current, err := loadNotificationSettings(ctx, q)
	if err != nil {
		return NotificationSettings{}, err
	}
	var fields []string
	for _, rule := range input.Events {
		if rule.RoleID != nil {
			count, err := q.CountRolesByID(ctx, *rule.RoleID)
			if err != nil {
				return NotificationSettings{}, err
			}
			if count == 0 {
				return NotificationSettings{}, apperror.Invalid("The role does not exist.")
			}
		}
		if err = q.UpsertPrinterNotificationRule(ctx, db.UpsertPrinterNotificationRuleParams{
			Event:           string(rule.Event),
			NotifyOperator:  rule.NotifyOperator,
			NotifyRecipient: rule.NotifyRecipient,
			RoleID:          rule.RoleID,
			Email:           rule.Email,
			MinSeverity:     rule.MinSeverity,
		}); err != nil {
			return NotificationSettings{}, err
		}
		if !sameRule(current.Events, rule) {
			fields = append(fields, string(rule.Event))
		}
	}
	actor := p.AccountID
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "printer_notification_settings.updated",
		ResourceType:   "printer_notification_settings",
		RequestID:      requestID,
		ChangedFields:  fields,
	}); err != nil {
		return NotificationSettings{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return NotificationSettings{}, err
	}
	return loadNotificationSettings(ctx, db.New(s.pool))
}

// sameRule says whether the stored rule of the event already equals rule.
func sameRule(stored []NotificationRule, rule NotificationRule) bool {
	for _, old := range stored {
		if old.Event != rule.Event {
			continue
		}
		sameRole := (old.RoleID == nil) == (rule.RoleID == nil) && (old.RoleID == nil || *old.RoleID == *rule.RoleID)
		sameSeverity := (old.MinSeverity == nil) == (rule.MinSeverity == nil) &&
			(old.MinSeverity == nil || *old.MinSeverity == *rule.MinSeverity)
		return old.NotifyOperator == rule.NotifyOperator && old.NotifyRecipient == rule.NotifyRecipient &&
			old.Email == rule.Email && sameRole && sameSeverity
	}
	return false
}

func errorCodeFrom(row db.PrinterErrorCode) ErrorCode {
	return ErrorCode{
		ID: row.ID, SourceFamily: row.SourceFamily, Code: row.Code, Title: row.Title, Description: row.Description,
		Link: row.Link, Source: row.Source, UpdatedAt: row.UpdatedAt.UTC(),
	}
}
