package inbox

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	inboxdb "github.com/Basmatireis/Makerspace-Core/backend/internal/inbox/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// placeFreedHorizon is how far ahead a freed supervisor place is worth a notification. It matches the
// dashboard hint for a free place (docs/staffing-and-dashboard.md).
const placeFreedHorizon = 14 * 24 * time.Hour

// Emitter writes system notifications inside the transaction of the mutation that caused them, so a
// notification exists exactly when its trigger committed. It holds no state; the features that emit
// declare the narrow interface they need and receive an *Emitter. Recipients are resolved at emit
// time, and an event with no recipients writes nothing. It imports no feature package (only the
// permission registry), so any feature can call it without an import cycle.
type Emitter struct {
	now func() time.Time
}

// NewEmitter returns an Emitter that reads the wall clock.
func NewEmitter() *Emitter {
	return &Emitter{now: func() time.Time { return time.Now().UTC() }}
}

// notice is the content of one system notification.
type notice struct {
	kind  Kind
	title string
	body  string
	link  string
}

// deliver stores the notice and one recipient row per account. Duplicate accounts are collapsed.
func (e *Emitter) deliver(ctx context.Context, tx pgx.Tx, n notice, accountIDs []uuid.UUID) error {
	if len(accountIDs) == 0 {
		return nil
	}
	now := e.now()
	queries := inboxdb.New(tx)
	link := n.link
	row, err := queries.InsertNotification(ctx, inboxdb.InsertNotificationParams{
		ID:        ids.New(),
		Kind:      string(n.kind),
		Title:     clip(n.title, MaxTitleLength),
		Body:      clip(n.body, MaxBodyLength),
		Link:      &link,
		CreatedAt: now,
		ExpiresAt: now.Add(Retention),
	})
	if err != nil {
		return fmt.Errorf("insert %s notification: %w", n.kind, err)
	}
	if _, err := queries.InsertRecipients(ctx, inboxdb.InsertRecipientsParams{
		NotificationID: row.ID, AccountIds: uuidTexts(accountIDs),
	}); err != nil {
		return fmt.Errorf("insert %s recipients: %w", n.kind, err)
	}
	return nil
}

// LabRulesConfirmationRequested tells everyone who may confirm Lab Rules signatures, except the
// requester, that a person asked for a confirmation. Call it when a new request was created.
func (e *Emitter) LabRulesConfirmationRequested(
	ctx context.Context,
	tx pgx.Tx,
	requesterAccountID uuid.UUID,
) error {
	queries := inboxdb.New(tx)
	person, err := queries.GetAccountPersonName(ctx, requesterAccountID)
	if err != nil {
		return fmt.Errorf("load requester name: %w", err)
	}
	recipients, err := queries.ListEnabledAccountIDsWithPermission(ctx, inboxdb.ListEnabledAccountIDsWithPermissionParams{
		PermissionID:       string(authorization.LaborordnungConfirm),
		ExcludedAccountIds: []string{requesterAccountID.String()},
	})
	if err != nil {
		return fmt.Errorf("resolve Lab Rules confirmers: %w", err)
	}
	name := strings.TrimSpace(person.FirstName + " " + person.LastName)
	return e.deliver(ctx, tx, notice{
		kind:  KindLabRulesConfirmationRequested,
		title: "Lab Rules confirmation requested",
		body:  name + " asked for a physical signature confirmation of the current Lab Rules.",
		link:  "/settings/laborordnung",
	}, recipients)
}

// OpenDayPeriodOpen tells everyone with an open day staffing level that sign-up for a period is open.
func (e *Emitter) OpenDayPeriodOpen(ctx context.Context, tx pgx.Tx, periodID uuid.UUID) error {
	queries := inboxdb.New(tx)
	period, err := queries.GetOpenDayPeriodFacts(ctx, periodID)
	if err != nil {
		return fmt.Errorf("load open day period: %w", err)
	}
	recipients, err := queries.ListEnabledStaffingAccountIDs(ctx)
	if err != nil {
		return fmt.Errorf("resolve staffing accounts: %w", err)
	}
	return e.deliver(ctx, tx, notice{
		kind:  KindOpenDayPeriodOpen,
		title: "Open day sign-up is open",
		body:  fmt.Sprintf("You can now sign up for open days in %s.", period.Name),
		link:  "/open-days/" + periodID.String(),
	}, recipients)
}

// OpenDayPlaceFreed tells the supervisors who are not on a scheduled open day that a supervisor
// place on it was freed by leavingPersonID. Only open days starting within the next 14 days
// qualify; trainee places never trigger a notification, so callers pass only supervisor places.
// The date is shown in location.
func (e *Emitter) OpenDayPlaceFreed(
	ctx context.Context,
	tx pgx.Tx,
	openDayID, leavingPersonID uuid.UUID,
	location *time.Location,
) error {
	queries := inboxdb.New(tx)
	day, err := queries.GetOpenDayFacts(ctx, openDayID)
	if err != nil {
		return fmt.Errorf("load open day: %w", err)
	}
	now := e.now()
	if day.Status != "scheduled" || !day.StartsAt.After(now) || day.StartsAt.After(now.Add(placeFreedHorizon)) {
		return nil
	}
	recipients, err := queries.ListUnassignedSupervisorAccountIDs(ctx, inboxdb.ListUnassignedSupervisorAccountIDsParams{
		OpenDayID: openDayID, ExcludedPersonID: leavingPersonID,
	})
	if err != nil {
		return fmt.Errorf("resolve unassigned supervisors: %w", err)
	}
	return e.deliver(ctx, tx, notice{
		kind:  KindOpenDayPlaceFreed,
		title: "Supervisor place freed",
		body: fmt.Sprintf(
			"A supervisor place on the open day of %s is free.", day.StartsAt.In(location).Format("Mon 2 Jan 2006, 15:04"),
		),
		link: fmt.Sprintf("/open-days/%s/days/%s", day.PeriodID, openDayID),
	}, recipients)
}

// RunFinished tells the operator of the run's job that the run ended. A run without a job or a job
// without an operator notifies nobody, and so does a run that has not ended. excludedAccountIDs lets
// a person who ended the run themselves skip their own notification.
func (e *Emitter) RunFinished(
	ctx context.Context,
	tx pgx.Tx,
	runID uuid.UUID,
	excludedAccountIDs ...uuid.UUID,
) error {
	queries := inboxdb.New(tx)
	run, err := queries.GetRunNotificationFacts(ctx, runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load run: %w", err)
	}
	if run.OperatorPersonID == nil {
		return nil
	}
	ending, ok := runEnding(run.Outcome, run.State)
	if !ok {
		return nil
	}
	recipients, err := queries.ListEnabledAccountIDsOfPerson(ctx, *run.OperatorPersonID)
	if err != nil {
		return fmt.Errorf("resolve run operator: %w", err)
	}
	recipients = slices.DeleteFunc(recipients, func(id uuid.UUID) bool { return slices.Contains(excludedAccountIDs, id) })
	body := fmt.Sprintf("Run %s on %s %s.", run.DisplayID, run.MachineName, ending)
	if run.JobTitle != nil && strings.TrimSpace(*run.JobTitle) != "" {
		body = fmt.Sprintf("Run %s of \"%s\" on %s %s.", run.DisplayID, *run.JobTitle, run.MachineName, ending)
	}
	return e.deliver(ctx, tx, notice{
		kind:  KindRunFinished,
		title: "Run " + run.DisplayID + " " + ending,
		body:  body,
		link:  "/machine-logbook/jobs/runs/" + runID.String(),
	}, recipients)
}

// runEnding words how a run ended from its recorded outcome or, without one, its machine state.
func runEnding(outcome, state *string) (string, bool) {
	value := ""
	switch {
	case outcome != nil:
		value = *outcome
	case state != nil:
		value = *state
	}
	switch value {
	case "successful", "finished":
		return "finished", true
	case "partial_failure":
		return "finished with problems", true
	case "failed":
		return "failed", true
	case "cancelled":
		return "was cancelled", true
	}
	return "", false
}
