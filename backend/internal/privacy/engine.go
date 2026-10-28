package privacy

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	privacydb "github.com/Basmatireis/Makerspace-Core/backend/internal/privacy/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RetentionHandler applies a retention action to the rows of one category
// whose trigger timestamp lies before cutoff, inside the caller's transaction,
// up to limit rows per call. The engine calls it repeatedly until fewer than
// limit rows were affected. A dry run calls it in a transaction that is rolled
// back, so handlers must not have effects outside the transaction (file blobs
// go through the queued blob deletion table, never straight to the store).
type RetentionHandler interface {
	Apply(ctx context.Context, tx pgx.Tx, action Action, cutoff time.Time, limit int32) (int64, error)
}

// HandlerFunc adapts a function to RetentionHandler.
type HandlerFunc func(ctx context.Context, tx pgx.Tx, action Action, cutoff time.Time, limit int32) (int64, error)

// Apply implements RetentionHandler.
func (f HandlerFunc) Apply(ctx context.Context, tx pgx.Tx, action Action, cutoff time.Time, limit int32) (int64, error) {
	return f(ctx, tx, action, cutoff, limit)
}

// ErrActionUnsupported is returned by handlers for an action they cannot perform.
var ErrActionUnsupported = errors.New("retention action not supported by this handler")

// Combine runs several handlers for one category and sums their counts.
func Combine(handlers ...RetentionHandler) RetentionHandler {
	return HandlerFunc(func(ctx context.Context, tx pgx.Tx, action Action, cutoff time.Time, limit int32) (int64, error) {
		var total int64
		for _, handler := range handlers {
			affected, err := handler.Apply(ctx, tx, action, cutoff, limit)
			total += affected
			if err != nil {
				return total, err
			}
		}
		return total, nil
	})
}

// Now returns the engine's clock, for handlers that need the current time.
func (s *Service) Now() time.Time { return s.now() }

// ScheduledInterval is how often the scheduler offers the retention job a
// run while automatic policy runs are off: the legacy automatic routines
// (timelapses, notifications, announcements, telemetry) keep their five-minute
// cadence from before the registry.
const ScheduledInterval = 5 * time.Minute

// Run modes and triggers.
const (
	ModeDryRun  = "dry_run"
	ModeExecute = "execute"

	TriggerManual    = "manual"
	TriggerScheduled = "scheduled"
	TriggerCLI       = "cli"

	// batchLimit bounds the rows one handler call touches, and the number of
	// batches per category bounds one run so a huge backlog is worked off
	// over several runs rather than in one long transaction.
	batchLimit           int32 = 500
	batchesPerRun              = 20
	runHistoryLimit            = 100
	legacyGraceMinute          = time.Minute
	ItemApplied                = "applied"
	ItemSkippedHold            = "skipped_hold"
	ItemSkippedNoHandler       = "skipped_no_handler"
	ItemFailed                 = "failed"
)

// LegacyPeriods carries the installation's configured legacy periods for the
// categories whose period comes from the environment or a setting rather than
// from code; nil means the source's default applies.
type LegacyPeriods struct {
	AuditRetention       *time.Duration
	EventSignupRetention *time.Duration
	// TimelapseRetention is read from run_recording_settings by the owner module.
	TimelapseRetention func(ctx context.Context) (*time.Duration, error)
}

// RunRequest asks the engine for a run.
type RunRequest struct {
	Mode       string
	Trigger    string
	Actor      *uuid.UUID
	Categories []CategoryID
	// Legacy applies the legacy defaults instead of active policies (admin cleanup).
	Legacy bool
	// AutomaticOnly limits a legacy run to categories whose routine ran inside the API process.
	AutomaticOnly bool
}

// RunItem is the outcome for one category.
type RunItem struct {
	Category CategoryID
	PolicyID *uuid.UUID
	Action   Action
	Cutoff   time.Time
	Affected int64
	Status   string
	Error    string
}

// Run is a recorded retention run.
type Run struct {
	ID         uuid.UUID
	Mode       string
	Trigger    string
	ActorID    *uuid.UUID
	StartedAt  time.Time
	FinishedAt *time.Time
	Status     string
	ErrorCode  string
	Items      []RunItem
}

// Register adds the handler for a category. Registering twice is a
// programming error.
func (s *Service) Register(category CategoryID, handler RetentionHandler) {
	if _, declared := s.catalog.Lookup(category); !declared {
		panic(fmt.Sprintf("privacy: handler for undeclared category %q", category))
	}
	if _, duplicate := s.handlers[category]; duplicate {
		panic(fmt.Sprintf("privacy: handler for %q registered twice", category))
	}
	s.handlers[category] = handler
}

// HandledCategories lists the categories with a handler.
func (s *Service) HandledCategories() []CategoryID {
	result := make([]CategoryID, 0, len(s.handlers))
	for id := range s.handlers {
		result = append(result, id)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

// SetLegacyPeriods supplies the configured legacy periods.
func (s *Service) SetLegacyPeriods(periods LegacyPeriods) { s.legacy = periods }

// StartRun starts a run over the active policies (privacy.retention.execute).
func (s *Service) StartRun(ctx context.Context, p authorization.Principal, mode string, categories []CategoryID, requestID *uuid.UUID) (Run, error) {
	if !p.Has(authorization.PrivacyRetentionExecute) {
		return Run{}, apperror.PermissionDenied
	}
	if mode != ModeDryRun && mode != ModeExecute {
		return Run{}, apperror.InvalidField("mode must be dry_run or execute")
	}
	for _, category := range categories {
		if _, known := s.catalog.Lookup(category); !known {
			return Run{}, apperror.InvalidField("unknown category " + string(category))
		}
	}
	actor := p.AccountID
	run, err := s.run(ctx, RunRequest{Mode: mode, Trigger: TriggerManual, Actor: &actor, Categories: categories})
	if err != nil {
		return run, err
	}
	return run, s.auditRun(ctx, &actor, run, requestID, "http")
}

// RunScheduled is the scheduler's entry: active policies when automatic runs
// are enabled, plus the legacy automatic routines for categories without an
// active policy, so the behaviour before the registry continues unchanged.
func (s *Service) RunScheduled(ctx context.Context) (Run, error) {
	enabled, _, err := s.AutomaticRunsEnabled(ctx)
	if err != nil {
		return Run{}, err
	}
	run, err := s.run(ctx, RunRequest{Mode: ModeExecute, Trigger: TriggerScheduled, Legacy: !enabled, AutomaticOnly: true})
	if err != nil {
		return run, err
	}
	if run.ID == uuid.Nil {
		return run, nil
	}
	return run, s.auditRun(ctx, nil, run, nil, "system")
}

// RunLegacyCleanup is what `admin cleanup` calls: the legacy routines with the
// configured periods, as before the registry, now recorded as a run.
func (s *Service) RunLegacyCleanup(ctx context.Context, mode string, categories []CategoryID) (Run, error) {
	run, err := s.run(ctx, RunRequest{Mode: mode, Trigger: TriggerCLI, Legacy: true, Categories: categories})
	if err != nil {
		return run, err
	}
	return run, s.auditRun(ctx, nil, run, nil, "admin_cli")
}

// plannedItem is one category the run will handle.
type plannedItem struct {
	category CategoryID
	policyID *uuid.UUID
	action   Action
	cutoff   time.Time
}

func (s *Service) plan(ctx context.Context, request RunRequest, now time.Time) ([]plannedItem, error) {
	q := privacydb.New(s.pool)
	wanted := map[CategoryID]bool{}
	for _, category := range request.Categories {
		wanted[category] = true
	}
	active := map[CategoryID]privacydb.PrivacyPolicyVersion{}
	if !request.Legacy || request.AutomaticOnly {
		rows, err := q.ListActivePolicies(ctx)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			active[CategoryID(row.CategoryID)] = row
		}
	}
	var items []plannedItem
	for _, definition := range s.catalog.Definitions() {
		if len(wanted) > 0 && !wanted[definition.ID] {
			continue
		}
		if policy, ok := active[definition.ID]; ok && !request.Legacy {
			id := policy.ID
			items = append(items, plannedItem{
				category: definition.ID, policyID: &id, action: Action(policy.Action),
				cutoff: now.Add(-time.Duration(policy.PeriodDays) * 24 * time.Hour),
			})
			continue
		}
		if ok := active[definition.ID]; request.AutomaticOnly && ok.ID != uuid.Nil {
			// A policy exists but automatic runs are off: the operator runs it manually.
			continue
		}
		if definition.Legacy == nil || (request.AutomaticOnly && !definition.Legacy.Automatic) {
			continue
		}
		period, disabled, err := s.legacyPeriod(ctx, definition)
		if err != nil {
			return nil, err
		}
		if disabled {
			continue
		}
		items = append(items, plannedItem{
			category: definition.ID, action: definition.Legacy.Action, cutoff: now.Add(-period),
		})
	}
	return items, nil
}

// legacyPeriod resolves the configured legacy period of a category; disabled
// reports a deliberate opt-out (a source value of zero).
func (s *Service) legacyPeriod(ctx context.Context, definition Definition) (time.Duration, bool, error) {
	legacy := definition.Legacy
	var configured *time.Duration
	switch legacy.Source {
	case "AUDIT_RETENTION":
		configured = s.legacy.AuditRetention
	case "EVENT_SIGNUP_RETENTION":
		configured = s.legacy.EventSignupRetention
	case "run_recording_settings.timelapse_retention_days":
		if s.legacy.TimelapseRetention != nil {
			value, err := s.legacy.TimelapseRetention(ctx)
			if err != nil {
				return 0, false, err
			}
			configured = value
		}
	}
	if configured != nil {
		if *configured <= 0 && legacy.ZeroDisables {
			return 0, true, nil
		}
		return *configured, false, nil
	}
	return legacy.Period, false, nil
}

func (s *Service) run(ctx context.Context, request RunRequest) (Run, error) {
	now := s.now()
	items, err := s.plan(ctx, request, now)
	if err != nil {
		return Run{}, err
	}
	if len(items) == 0 {
		return Run{}, nil
	}
	holds, err := privacydb.New(s.pool).ListOpenHolds(ctx)
	if err != nil {
		return Run{}, err
	}
	heldCategories := map[CategoryID]bool{}
	for _, hold := range holds {
		if hold.CategoryID != nil {
			heldCategories[CategoryID(*hold.CategoryID)] = true
		}
	}
	q := privacydb.New(s.pool)
	row, err := q.InsertRun(ctx, privacydb.InsertRunParams{
		ID: ids.New(), Mode: request.Mode, Trigger: request.Trigger, ActorAccountID: request.Actor,
	})
	if err != nil {
		return Run{}, err
	}
	run := Run{ID: row.ID, Mode: row.Mode, Trigger: row.Trigger, ActorID: row.ActorAccountID, StartedAt: row.StartedAt, Status: "running"}
	var failure string
	for _, item := range items {
		result := RunItem{Category: item.category, PolicyID: item.policyID, Action: item.action, Cutoff: item.cutoff, Status: ItemApplied}
		handler, handled := s.handlers[item.category]
		switch {
		case heldCategories[item.category]:
			result.Status = ItemSkippedHold
		case !handled:
			result.Status = ItemSkippedNoHandler
		default:
			affected, err := s.applyBatches(ctx, handler, item, request.Mode == ModeDryRun)
			result.Affected = affected
			if err != nil {
				result.Status = ItemFailed
				result.Error = errorCode(err)
				failure = result.Error
			}
		}
		var policyID *uuid.UUID
		if item.policyID != nil {
			id := *item.policyID
			policyID = &id
		}
		var errorCode *string
		if result.Error != "" {
			code := result.Error
			errorCode = &code
		}
		if err := q.InsertRunItem(ctx, privacydb.InsertRunItemParams{
			RunID: run.ID, CategoryID: string(item.category), PolicyID: policyID, Action: string(item.action),
			Cutoff: item.cutoff, AffectedCount: result.Affected, Status: result.Status, ErrorCode: errorCode,
		}); err != nil {
			return run, err
		}
		run.Items = append(run.Items, result)
	}
	status := "completed"
	var code *string
	if failure != "" {
		status = "failed"
		code = &failure
	}
	finished, err := q.FinishRun(ctx, privacydb.FinishRunParams{Status: status, ErrorCode: code, ID: run.ID})
	if err != nil {
		return run, err
	}
	run.Status = finished.Status
	run.ErrorCode = failure
	if finished.FinishedAt.Valid {
		at := finished.FinishedAt.Time
		run.FinishedAt = &at
	}
	return run, nil
}

// applyBatches runs the handler in batches, each in its own short transaction.
// A dry run uses one transaction that is rolled back at the end, so it sees
// its own earlier batches but leaves nothing behind.
func (s *Service) applyBatches(ctx context.Context, handler RetentionHandler, item plannedItem, dryRun bool) (int64, error) {
	var total int64
	if dryRun {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return 0, err
		}
		defer func() { _ = tx.Rollback(ctx) }()
		for range batchesPerRun {
			affected, err := handler.Apply(ctx, tx, item.action, item.cutoff, batchLimit)
			total += affected
			if err != nil {
				return total, err
			}
			if affected < int64(batchLimit) {
				break
			}
		}
		return total, nil
	}
	for range batchesPerRun {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return total, err
		}
		affected, err := handler.Apply(ctx, tx, item.action, item.cutoff, batchLimit)
		if err != nil {
			_ = tx.Rollback(ctx)
			return total, err
		}
		if err := tx.Commit(ctx); err != nil {
			return total, err
		}
		total += affected
		if affected < int64(batchLimit) {
			break
		}
	}
	return total, nil
}

func errorCode(err error) string {
	if errors.Is(err, ErrActionUnsupported) {
		return "action_unsupported"
	}
	var appErr *apperror.Error
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return "handler_failed"
}

// auditRun records one privacy-minimised audit event per run: counts only.
func (s *Service) auditRun(ctx context.Context, actor *uuid.UUID, run Run, requestID *uuid.UUID, source string) error {
	if run.ID == uuid.Nil {
		return nil
	}
	var affected int64
	var categories int
	for _, item := range run.Items {
		affected += item.Affected
		if item.Status == ItemApplied {
			categories++
		}
	}
	event := audit.Event{
		ActorAccountID: actor,
		Action:         "privacy.retention_run_" + run.Mode,
		ResourceType:   "privacy_retention_run",
		ResourceID:     &run.ID,
		RequestID:      requestID,
		ChangedFields:  []string{"status"},
		Metadata: map[string]any{
			"countAffectedRows": fmt.Sprintf("%d", affected),
			"countCategories":   fmt.Sprintf("%d", categories),
		},
		Source: audit.Source(source),
	}
	if actor == nil {
		event.ActorType = "system"
	}
	return audit.Write(ctx, s.pool, event)
}

// ListRuns returns the recent runs (privacy.read).
func (s *Service) ListRuns(ctx context.Context, p authorization.Principal) ([]Run, error) {
	if !p.Has(authorization.PrivacyRead) {
		return nil, apperror.PermissionDenied
	}
	rows, err := privacydb.New(s.pool).ListRuns(ctx, runHistoryLimit)
	if err != nil {
		return nil, err
	}
	result := make([]Run, 0, len(rows))
	for _, row := range rows {
		result = append(result, runFrom(row, nil))
	}
	return result, nil
}

// GetRun returns one run with its items (privacy.read).
func (s *Service) GetRun(ctx context.Context, p authorization.Principal, id uuid.UUID) (Run, error) {
	if !p.Has(authorization.PrivacyRead) {
		return Run{}, apperror.PermissionDenied
	}
	q := privacydb.New(s.pool)
	row, err := q.GetRun(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, apperror.NotFound
	}
	if err != nil {
		return Run{}, err
	}
	items, err := q.ListRunItems(ctx, id)
	if err != nil {
		return Run{}, err
	}
	return runFrom(row, items), nil
}

func runFrom(row privacydb.PrivacyRetentionRun, items []privacydb.PrivacyRetentionRunItem) Run {
	run := Run{ID: row.ID, Mode: row.Mode, Trigger: row.Trigger, ActorID: row.ActorAccountID, StartedAt: row.StartedAt, Status: row.Status}
	if row.ErrorCode != nil {
		run.ErrorCode = *row.ErrorCode
	}
	if row.FinishedAt.Valid {
		at := row.FinishedAt.Time
		run.FinishedAt = &at
	}
	run.Items = make([]RunItem, 0, len(items))
	for _, item := range items {
		result := RunItem{
			Category: CategoryID(item.CategoryID), PolicyID: item.PolicyID, Action: Action(item.Action),
			Cutoff: item.Cutoff, Affected: item.AffectedCount, Status: item.Status,
		}
		if item.ErrorCode != nil {
			result.Error = *item.ErrorCode
		}
		run.Items = append(run.Items, result)
	}
	return run
}
