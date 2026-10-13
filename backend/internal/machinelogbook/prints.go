package machinelogbook

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

type PrintReportedUsage struct {
	Quantity, QuantityBasis      string
	SpoolID, MaterialID          *uuid.UUID
	SpoolDisplayID, MaterialName *string
}

type PrintJobReference struct {
	ID        uuid.UUID
	DisplayID string
	Title     *string
}

type Print struct {
	ID, MachineID           uuid.UUID
	DisplayID, MachineName  string
	ConnectorName, FileName *string
	State                   string
	StartedAt               time.Time
	EndedAt, EstimatedEndAt *time.Time
	ProgressPercent         *int
	ReportedUsage           *PrintReportedUsage
	Job                     *PrintJobReference
	Version                 int64
}

// PrintEvent exposes what a printer event reported, never its raw payload.
type PrintEvent struct {
	ID              uuid.UUID
	Kind            string
	OccurredAt      time.Time
	State           *string
	ProgressPercent *int
	Quantity        *string
}

type PrintDetail struct {
	Print
	Events []PrintEvent
}

type MachineJobPrint struct {
	ID                      uuid.UUID
	DisplayID, State        string
	FileName, ConnectorName *string
}

type PrintFilters struct {
	Search         string
	MachineID      *uuid.UUID
	State          *string
	Linked         *bool
	From, To       *time.Time
	Page, PageSize int
}

type PrintJobInput struct {
	Title            *string
	Customer         PartyReference
	OperatorPersonID uuid.UUID
	Outcome          *string
	Notes            *string
	PricingGroupID   *uuid.UUID
	Usages           []UsageInput
}

// printStateFromRun maps the connector's observed run state to the print state.
func printStateFromRun(state string) string {
	switch state {
	case "completed":
		return "finished"
	case "failed":
		return "failed"
	case "cancelled":
		return "cancelled"
	case "uncertain":
		return "unknown"
	}
	return "printing"
}

func runStatesForPrintState(state string) []string {
	switch state {
	case "printing":
		return []string{"observed", "printing"}
	case "finished":
		return []string{"completed"}
	case "failed", "cancelled":
		return []string{state}
	case "unknown":
		return []string{"uncertain"}
	}
	return nil
}

func outcomeFromPrintState(state string) string {
	switch state {
	case "finished":
		return "successful"
	case "failed":
		return "failed"
	case "cancelled":
		return "cancelled"
	}
	return "unknown"
}

// printInterval is the run the printer reported, widened to a positive span.
func printInterval(row machinelogbookdb.PrinterObservedRun) (time.Time, time.Time) {
	start := row.FirstObservedAt.UTC()
	if row.StartedAt.Valid {
		start = row.StartedAt.Time.UTC()
	}
	end := row.LastObservedAt.UTC()
	if row.EndedAt.Valid {
		end = row.EndedAt.Time.UTC()
	}
	if !end.After(start) {
		end = start.Add(time.Second)
	}
	return start, end
}

func printFromRow(row machinelogbookdb.ListPrintsRow) Print {
	start := row.FirstObservedAt.UTC()
	if row.StartedAt.Valid {
		start = row.StartedAt.Time.UTC()
	}
	item := Print{ID: row.ID, DisplayID: row.DisplayID, MachineID: row.MachineID, MachineName: row.MachineName, ConnectorName: &row.ConnectorName, FileName: row.FileName, State: printStateFromRun(row.State), StartedAt: start, EndedAt: nullableTime(row.EndedAt), EstimatedEndAt: nullableTime(row.EstimatedEndAt), Version: row.Version}
	if row.ProgressPercent != nil {
		percent := int(*row.ProgressPercent)
		item.ProgressPercent = &percent
	}
	if row.ReportedQuantityG.Valid && row.ReportedQuantityBasis != nil {
		item.ReportedUsage = &PrintReportedUsage{Quantity: decimalString(row.ReportedQuantityG), QuantityBasis: *row.ReportedQuantityBasis, SpoolID: row.ReportedSpoolID, SpoolDisplayID: row.SpoolDisplayID, MaterialID: row.MaterialID, MaterialName: row.MaterialName}
	}
	if row.JobID != nil && row.JobDisplayID != nil {
		item.Job = &PrintJobReference{ID: *row.JobID, DisplayID: *row.JobDisplayID, Title: row.JobTitle}
	}
	return item
}

func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

func (s *Service) ListPrints(ctx context.Context, p authorization.Principal, filters PrintFilters) ([]Print, int64, error) {
	if err := require(p, authorization.MachineJobsRead); err != nil {
		return nil, 0, err
	}
	offset, limit, err := pageBounds(filters.Page, filters.PageSize)
	if err != nil {
		return nil, 0, err
	}
	if filters.From != nil && filters.To != nil && !filters.To.After(*filters.From) {
		return nil, 0, validation("to must be after from")
	}
	states := []string{}
	if filters.State != nil {
		states = runStatesForPrintState(*filters.State)
		if states == nil {
			return nil, 0, validation("invalid print state")
		}
	}
	search := escapeLike(strings.TrimSpace(filters.Search))
	q := machinelogbookdb.New(s.pool)
	rows, err := q.ListPrints(ctx, machinelogbookdb.ListPrintsParams{Search: search, MachineID: filters.MachineID, States: states, Linked: filters.Linked, FromTime: pgTime(filters.From), ToTime: pgTime(filters.To), PageOffset: offset, PageLimit: limit})
	if err != nil {
		return nil, 0, err
	}
	total, err := q.CountPrints(ctx, machinelogbookdb.CountPrintsParams{Search: search, MachineID: filters.MachineID, States: states, Linked: filters.Linked, FromTime: pgTime(filters.From), ToTime: pgTime(filters.To)})
	if err != nil {
		return nil, 0, err
	}
	items := make([]Print, 0, len(rows))
	for _, row := range rows {
		items = append(items, printFromRow(row))
	}
	return items, total, nil
}

func (s *Service) GetPrint(ctx context.Context, p authorization.Principal, id uuid.UUID) (PrintDetail, error) {
	if err := require(p, authorization.MachineJobsRead); err != nil {
		return PrintDetail{}, err
	}
	q := machinelogbookdb.New(s.pool)
	rows, err := q.ListPrints(ctx, machinelogbookdb.ListPrintsParams{PrintID: &id, States: []string{}, PageLimit: 1})
	if err != nil {
		return PrintDetail{}, err
	}
	if len(rows) == 0 {
		return PrintDetail{}, apperror.NotFound
	}
	events, err := q.ListPrintEvents(ctx, &id)
	if err != nil {
		return PrintDetail{}, err
	}
	detail := PrintDetail{Print: printFromRow(rows[0]), Events: make([]PrintEvent, 0, len(events))}
	for _, event := range events {
		detail.Events = append(detail.Events, printEventFromRow(event))
	}
	return detail, nil
}

// printEventFromRow keeps the few reported facts the print page shows and
// drops everything else in the connector payload.
func printEventFromRow(row machinelogbookdb.ListPrintEventsRow) PrintEvent {
	event := PrintEvent{ID: row.ID, Kind: row.Kind, OccurredAt: row.OccurredAt}
	var values map[string]any
	if json.Unmarshal(row.Payload, &values) != nil {
		return event
	}
	key := "state"
	if row.Kind == "terminal_outcome" {
		key = "outcome"
	}
	if value, ok := values[key].(string); ok && value != "" && len(value) <= 64 {
		event.State = &value
	}
	if value, ok := values["percent"].(float64); ok && value >= 0 && value <= 100 {
		percent := int(value + 0.5)
		event.ProgressPercent = &percent
	}
	if value, ok := values["quantityGrams"].(string); ok && row.Kind == "consumption_report" {
		if parsed, err := decimal.NewFromString(strings.TrimSpace(value)); err == nil && parsed.IsPositive() {
			quantity := parsed.String()
			event.Quantity = &quantity
		}
	}
	return event
}

func (s *Service) loadPrintReference(ctx context.Context, q *machinelogbookdb.Queries, id uuid.UUID) (*MachineJobPrint, error) {
	row, err := q.GetPrintReference(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &MachineJobPrint{ID: row.ID, DisplayID: row.DisplayID, State: printStateFromRun(row.State), FileName: row.FileName, ConnectorName: &row.ConnectorName}, nil
}

// checkPrintLinkable rejects prints that are still running or already linked.
func checkPrintLinkable(ctx context.Context, q *machinelogbookdb.Queries, print machinelogbookdb.PrinterObservedRun) error {
	if printStateFromRun(print.State) == "printing" {
		return conflict("print_in_progress", "The print is still running")
	}
	if _, err := q.GetMachineJobIDByPrint(ctx, &print.ID); err == nil {
		return conflict("print_already_linked", "The print is already linked to a job")
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	return nil
}

// LinkPrintToJob replaces a confirmed job's manual run with a print: the print
// supplies the times, the outcome when the job has none, and, when the printer
// reported a resolvable spool, the material usage.
func (s *Service) LinkPrintToJob(ctx context.Context, p authorization.Principal, printID, jobID uuid.UUID, expectedJobVersion int64, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expectedJobVersion < 1 {
		return MachineJob{}, validation("expectedJobVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	job, err := q.GetMachineJobForUpdate(ctx, jobID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	print, err := q.GetPrintForUpdate(ctx, printID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if err = checkPrintLinkable(ctx, q, print); err != nil {
		return MachineJob{}, err
	}
	if job.PrintID != nil {
		return MachineJob{}, conflict("job_already_linked", "The job is already linked to a print")
	}
	if job.ReviewState != "confirmed" {
		return MachineJob{}, conflict("job_not_confirmed", "Only confirmed jobs can be edited")
	}
	if job.MachineID != print.MachineID {
		return MachineJob{}, conflict("print_machine_mismatch", "The print ran on another machine than the job")
	}
	if job.Version != expectedJobVersion {
		return MachineJob{}, apperror.StaleWrite
	}
	startsAt, endsAt := printInterval(print)
	outcome := job.Outcome
	if outcome == "unknown" {
		outcome = outcomeFromPrintState(printStateFromRun(print.State))
	}
	updated, err := q.LinkMachineJobPrint(ctx, machinelogbookdb.LinkMachineJobPrintParams{ID: jobID, ExpectedVersion: expectedJobVersion, PrintID: &printID, StartsAt: startsAt, EndsAt: endsAt, Outcome: outcome})
	if errors.Is(err, pgx.ErrNoRows) {
		return MachineJob{}, apperror.StaleWrite
	}
	if err != nil {
		return MachineJob{}, databaseError(err)
	}
	fields := []string{"printId", "startsAt", "endsAt", "outcome", "effectivePrice"}
	replaced, err := s.replaceUsagesFromPrint(ctx, tx, q, p, print, updated, requestID)
	if err != nil {
		return MachineJob{}, err
	}
	if replaced {
		fields = append(fields, "usages", "inventory")
	} else if _, err = s.recalculateFromSnapshot(ctx, q, updated); err != nil {
		return MachineJob{}, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.print_linked", "machine_job", jobID, requestID, fields); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, jobID)
}

// replaceUsagesFromPrint swaps the job's usages for the printer-reported one
// and accepts the consumption report it came from. It reports false, leaving
// the job's usages alone, when the print has no resolvable spool.
func (s *Service) replaceUsagesFromPrint(ctx context.Context, tx pgx.Tx, q *machinelogbookdb.Queries, p authorization.Principal, print machinelogbookdb.PrinterObservedRun, job machinelogbookdb.MachineJob, requestID *uuid.UUID) (bool, error) {
	if !print.ReportedQuantityG.Valid || print.ReportedQuantityBasis == nil || print.ReportedSpoolID == nil || print.ReportedEventID == nil {
		return false, nil
	}
	spool, err := q.GetFilamentSpool(ctx, *print.ReportedSpoolID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if spool.MaterialID == nil {
		return false, nil
	}
	usage := UsageInput{MaterialID: *spool.MaterialID, SpoolID: print.ReportedSpoolID, Ownership: "makerspace", Quantity: decimalString(print.ReportedQuantityG), QuantityBasis: *print.ReportedQuantityBasis}
	if _, err = s.ReplaceJobUsagesInTransaction(ctx, tx, p, job.ID, job.Version, []UsageInput{usage}, print.ReportedEventID, requestID); err != nil {
		return false, err
	}
	actor := p.AccountID
	accepted, err := q.AcceptPrinterEventReconciliation(ctx, machinelogbookdb.AcceptPrinterEventReconciliationParams{ID: *print.ReportedEventID, ActorAccountID: &actor})
	if err != nil {
		return false, err
	}
	if accepted > 0 {
		if err = writeAudit(ctx, tx, p, "printer_event.reconciled", "printer_event", *print.ReportedEventID, requestID, []string{"reconciliationState"}); err != nil {
			return false, err
		}
	}
	return true, nil
}

// UnlinkPrint detaches the print from its job. The job keeps every value it
// took from the print; only the automatic run becomes a manual one.
func (s *Service) UnlinkPrint(ctx context.Context, p authorization.Principal, printID uuid.UUID, expectedJobVersion int64, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsEdit); err != nil {
		return MachineJob{}, err
	}
	if expectedJobVersion < 1 {
		return MachineJob{}, validation("expectedJobVersion must be positive")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	job, err := q.GetMachineJobByPrintForUpdate(ctx, &printID)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, printErr := q.GetPrintForUpdate(ctx, printID); printErr != nil {
			return MachineJob{}, noRows(printErr)
		}
		return MachineJob{}, conflict("print_not_linked", "The print is not linked to a job")
	}
	if err != nil {
		return MachineJob{}, err
	}
	if job.Version != expectedJobVersion {
		return MachineJob{}, apperror.StaleWrite
	}
	if _, err = q.SetMachineJobPrint(ctx, machinelogbookdb.SetMachineJobPrintParams{ID: job.ID, ExpectedVersion: expectedJobVersion}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MachineJob{}, apperror.StaleWrite
		}
		return MachineJob{}, err
	}
	if err = writeAudit(ctx, tx, p, "machine_job.print_unlinked", "machine_job", job.ID, requestID, []string{"printId"}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, job.ID)
}

// CreateJobFromPrint records a new confirmed job for an ended print and links
// them, taking the machine, times and, unless given, the outcome from the print.
func (s *Service) CreateJobFromPrint(ctx context.Context, p authorization.Principal, printID uuid.UUID, input PrintJobInput, requestID *uuid.UUID) (MachineJob, error) {
	if err := require(p, authorization.MachineJobsCreate); err != nil {
		return MachineJob{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return MachineJob{}, err
	}
	defer tx.Rollback(ctx)
	q := machinelogbookdb.New(tx)
	print, err := q.GetPrintForUpdate(ctx, printID)
	if err != nil {
		return MachineJob{}, noRows(err)
	}
	if err = checkPrintLinkable(ctx, q, print); err != nil {
		return MachineJob{}, err
	}
	startsAt, endsAt := printInterval(print)
	outcome := outcomeFromPrintState(printStateFromRun(print.State))
	if input.Outcome != nil {
		outcome = *input.Outcome
	}
	created, err := s.CreateManualJobInTransaction(ctx, tx, false, p, JobInput{MachineID: print.MachineID, Title: input.Title, StartsAt: startsAt, EndsAt: endsAt, Customer: input.Customer, OperatorPersonID: input.OperatorPersonID, Outcome: outcome, Notes: input.Notes, PricingGroupID: input.PricingGroupID, Usages: input.Usages}, requestID)
	if err != nil {
		return MachineJob{}, err
	}
	if _, err = q.SetMachineJobPrint(ctx, machinelogbookdb.SetMachineJobPrintParams{ID: created.ID, ExpectedVersion: created.Version, PrintID: &printID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MachineJob{}, apperror.StaleWrite
		}
		return MachineJob{}, databaseError(err)
	}
	if err = writeAudit(ctx, tx, p, "machine_job.print_linked", "machine_job", created.ID, requestID, []string{"printId"}); err != nil {
		return MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return MachineJob{}, err
	}
	return s.loadJob(ctx, created.ID)
}
