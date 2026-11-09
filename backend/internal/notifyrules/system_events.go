package notifyrules

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// LabRulesConfirmLink is the page that shows the current Lab Rules and asks for the confirmation; the Lab Rules
// notifications and their e-mails link to it.
const LabRulesConfirmLink = "/lab-rules/confirm"

// SystemEvents raises the events the application itself produces: it loads the facts of a business event, fills them
// into a notifyrules.Event and hands it to the dispatcher inside the caller's transaction. What people are told, and
// who is told, is decided by the seeded and custom rules of each trigger, never here. Feature packages declare the
// few methods they call as their own narrow interface.
type SystemEvents struct {
	dispatcher *Dispatcher
}

// NewSystemEvents returns the event source for a dispatcher. A nil dispatcher stands for one without a pool, which is
// enough to emit events; only delivering waiting notifications needs the pool.
func NewSystemEvents(dispatcher *Dispatcher) *SystemEvents {
	if dispatcher == nil {
		dispatcher = NewDispatcher(nil, time.UTC)
	}
	return &SystemEvents{dispatcher: dispatcher}
}

func (e *SystemEvents) emit(ctx context.Context, tx pgx.Tx, ev Event) error {
	return e.dispatcher.Emit(ctx, tx, ev)
}

// weekdayKey is the catalog's key of a date's weekday.
func weekdayKey(t time.Time) string { return weekdayKeys[t.Weekday()] }

// daysUntil counts the whole days from now to a moment; the past counts as zero.
func daysUntil(now, moment time.Time) float64 {
	if !moment.After(now) {
		return 0
	}
	return float64(int(moment.Sub(now).Hours() / 24))
}

func uuidPtrList(ids ...*uuid.UUID) []uuid.UUID {
	var list []uuid.UUID
	for _, id := range ids {
		if id != nil {
			list = append(list, *id)
		}
	}
	return list
}

// RunFinished raises run_finished when a run with a job has ended. A run without a job, and a run that has not ended,
// raises nothing. excludedAccountIDs lets a person who ended the run themselves skip their own notification and
// e-mail.
func (e *SystemEvents) RunFinished(ctx context.Context, tx pgx.Tx, runID uuid.UUID, excludedAccountIDs ...uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	run, err := q.GetRunEventFacts(ctx, runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load run: %w", err)
	}
	if run.JobID == nil {
		return nil
	}
	ending, outcome, ok := runEnding(run.Outcome, run.State)
	if !ok {
		return nil
	}
	var excluded []uuid.UUID
	if len(excludedAccountIDs) > 0 {
		if excluded, err = q.ListPersonIDsOfAccounts(ctx, uuidStrings(excludedAccountIDs)); err != nil {
			return fmt.Errorf("resolve excluded accounts: %w", err)
		}
	}
	fields := map[string]any{"machine": run.MachineID.String(), "outcome": outcome}
	placeholders := map[string]string{
		"run": run.DisplayID, "machine": run.MachineName, "ending": ending, "job": "", "jobNote": "", "printPage": "",
	}
	// Only recorded runs have a print page.
	if run.Source == "recorded" {
		placeholders["printPage"] = e.dispatcher.printPageAddress(runID)
	}
	if run.JobTitle != nil && strings.TrimSpace(*run.JobTitle) != "" {
		placeholders["job"] = *run.JobTitle
		placeholders["jobNote"] = fmt.Sprintf(" of \"%s\"", *run.JobTitle)
	}
	if run.StartedAt.Valid && run.EndedAt.Valid && run.EndedAt.Time.After(run.StartedAt.Time) {
		length := run.EndedAt.Time.Sub(run.StartedAt.Time)
		fields["duration"] = length.Hours()
		placeholders["duration"] = formatDuration(length)
	}
	switch {
	case run.CustomerPersonID != nil:
		fields["recipientType"] = "person"
	case run.CustomerOrganizationID != nil:
		fields["recipientType"] = "organization"
	}
	return e.emit(ctx, tx, Event{
		Trigger:        "run_finished",
		Fields:         fields,
		Placeholders:   placeholders,
		Recipients:     map[string][]uuid.UUID{"operator": uuidPtrList(run.OperatorPersonID), "recipient": uuidPtrList(run.CustomerPersonID)},
		Organizations:  map[string][]uuid.UUID{"recipient": uuidPtrList(run.CustomerOrganizationID)},
		ExcludedPeople: excluded,
		Subjects:       map[string]string{"machine": run.MachineID.String()},
		Link:           "/workshop/jobs/runs/" + runID.String(),
	})
}

// TimelapseReady raises timelapse_ready when the timelapse video of a recorded run was stored. A run without a live
// job raises nothing. The notification opens the run's print page.
func (e *SystemEvents) TimelapseReady(ctx context.Context, tx pgx.Tx, runID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	run, err := q.GetTimelapseEventFacts(ctx, runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load run: %w", err)
	}
	job, title := run.JobDisplayID, ""
	if run.JobTitle != nil && strings.TrimSpace(*run.JobTitle) != "" {
		job = strings.TrimSpace(*run.JobTitle)
		title = job
	}
	if title == "" {
		if title, err = q.GetRunPrintName(ctx, runID); err != nil {
			return fmt.Errorf("load print name: %w", err)
		}
	}
	fields := map[string]any{"machine": run.MachineID.String()}
	if _, outcome, ok := runEnding(run.Outcome, run.State); ok {
		fields["outcome"] = outcome
	}
	switch {
	case run.CustomerPersonID != nil:
		fields["recipientType"] = "person"
	case run.CustomerOrganizationID != nil:
		fields["recipientType"] = "organization"
	}
	return e.emit(ctx, tx, Event{
		Trigger: "timelapse_ready",
		Fields:  fields,
		Placeholders: map[string]string{
			"run": run.DisplayID, "job": job, "machine": run.MachineName, "title": title,
			"printPage": e.dispatcher.printPageAddress(runID),
		},
		Recipients: map[string][]uuid.UUID{
			"operator": uuidPtrList(run.OperatorPersonID), "recipient": uuidPtrList(run.CustomerPersonID),
		},
		Organizations: map[string][]uuid.UUID{"recipient": uuidPtrList(run.CustomerOrganizationID)},
		Subjects:      map[string]string{"machine": run.MachineID.String()},
		Link:          PrintPageLink(runID),
	})
}

func formatDuration(length time.Duration) string {
	minutes := int(length.Round(time.Minute).Minutes())
	if minutes < 60 {
		return fmt.Sprintf("%d min", minutes)
	}
	return fmt.Sprintf("%d h %d min", minutes/60, minutes%60)
}

// runEnding words how a run ended from its recorded outcome or, without one, its machine state, and names the
// outcome the catalog's field offers.
func runEnding(outcome, state *string) (ending, field string, ok bool) {
	value := ""
	switch {
	case outcome != nil:
		value = *outcome
	case state != nil:
		value = *state
	}
	switch value {
	case "successful", "finished":
		return "finished", "successful", true
	case "partial_failure":
		return "finished with problems", "partial_failure", true
	case "failed":
		return "failed", "failed", true
	case "cancelled":
		return "was cancelled", "cancelled", true
	}
	return "", "", false
}

// machineParties are the people a printer event concerns, as the recipient keys of printer triggers.
func (e *SystemEvents) printerRecipients(
	ctx context.Context,
	q *notifyrulesdb.Queries,
	operator, customerPerson *uuid.UUID,
) (map[string][]uuid.UUID, error) {
	present, err := q.ListAllCheckedInPeople(ctx)
	if err != nil {
		return nil, fmt.Errorf("list people present: %w", err)
	}
	return map[string][]uuid.UUID{
		"operator": uuidPtrList(operator), "recipient": uuidPtrList(customerPerson), "present": present,
	}, nil
}

// PrinterError raises printer_error when a printer reported an error for the first time. Repeats of an open error
// and cleared errors never get here: the connector decides that before it asks.
func (e *SystemEvents) PrinterError(ctx context.Context, tx pgx.Tx, machineID uuid.UUID, family, code string, severity *string) error {
	q := notifyrulesdb.New(tx)
	machine, err := q.GetMachineEventFacts(ctx, machineID)
	if err != nil {
		return fmt.Errorf("load machine: %w", err)
	}
	meaning, err := q.GetPrinterErrorMeaning(ctx, notifyrulesdb.GetPrinterErrorMeaningParams{SourceFamily: family, Code: code})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("load printer error code: %w", err)
	}
	fields := map[string]any{"machine": machineID.String(), "code": code, "printing": machine.RunID != nil}
	placeholders := map[string]string{
		"machine": machine.MachineName, "code": code, "level": "", "levelNote": "", "meaning": meaning, "meaningNote": "",
		"run": "", "runNote": "", "job": "",
	}
	if severity != nil {
		// A level the catalog does not know is left out of the fields, so no condition on the level filters it away.
		if slices.Contains([]string{"info", "common", "serious", "fatal"}, *severity) {
			fields["level"] = *severity
		}
		placeholders["level"] = *severity
		placeholders["levelNote"] = " (" + *severity + ")"
	}
	if meaning != "" {
		placeholders["meaningNote"] = ": " + meaning
	}
	if machine.RunDisplayID != nil {
		placeholders["run"] = *machine.RunDisplayID
		placeholders["runNote"] = " during run " + *machine.RunDisplayID
	}
	if machine.JobTitle != nil {
		placeholders["job"] = *machine.JobTitle
	}
	if machine.OperatorPersonID != nil {
		memberships, err := q.ListMembershipsOfPeople(ctx, uuidStrings([]uuid.UUID{*machine.OperatorPersonID}))
		if err != nil {
			return fmt.Errorf("load operator membership: %w", err)
		}
		if len(memberships) > 0 {
			fields["operatorRole"] = memberships[0].Membership
		}
	}
	recipients, err := e.printerRecipients(ctx, q, machine.OperatorPersonID, machine.CustomerPersonID)
	if err != nil {
		return err
	}
	return e.emit(ctx, tx, Event{
		Trigger:       "printer_error",
		Fields:        fields,
		Placeholders:  placeholders,
		Recipients:    recipients,
		Organizations: map[string][]uuid.UUID{"recipient": uuidPtrList(machine.CustomerOrganizationID)},
		Subjects:      map[string]string{"machine": machineID.String(), "code": code},
		ResolveToken:  "printer_error:" + machineID.String() + ":" + code,
		Link:          machinePrinterLink(machineID),
	})
}

// FilamentChangeKind is what happened in a printer slot.
type FilamentChangeKind string

const (
	// FilamentLoaded: a spool Core knows was put into the slot.
	FilamentLoaded FilamentChangeKind = "loaded"
	// FilamentUnloaded: the slot that held a known spool is empty now.
	FilamentUnloaded FilamentChangeKind = "unloaded"
	// FilamentUnknownTag: the slot holds material with an RFID tag no spool in Core carries.
	FilamentUnknownTag FilamentChangeKind = "unknown_tag"
	// FilamentNoTag: the slot holds material without a readable RFID tag, so a spool must be assigned by hand.
	FilamentNoTag FilamentChangeKind = "no_tag"
)

// FilamentChange describes one slot change.
type FilamentChange struct {
	Kind FilamentChangeKind
	// Slot is the slot's name as people know it, such as "AMS A · 1".
	Slot string
	// SpoolID names the spool for loaded and unloaded; nil for the other kinds.
	SpoolID *uuid.UUID
	// Material is what the printer read from the tray (type and colour), when it knows.
	Material string
}

// FilamentChange raises filament_change when material in one of a machine's slots changed while a recorded run is
// printing. Without a running recorded run nobody is told; the printer page shows the change to whoever has it open.
func (e *SystemEvents) FilamentChange(ctx context.Context, tx pgx.Tx, machineID uuid.UUID, change FilamentChange) error {
	q := notifyrulesdb.New(tx)
	machine, err := q.GetMachineEventFacts(ctx, machineID)
	if err != nil {
		return fmt.Errorf("load machine: %w", err)
	}
	if machine.RunID == nil {
		return nil
	}
	switch change.Kind {
	case FilamentLoaded, FilamentUnloaded, FilamentUnknownTag, FilamentNoTag:
	default:
		return nil
	}
	spool := ""
	if change.SpoolID != nil {
		facts, err := q.GetSpoolEventFacts(ctx, *change.SpoolID)
		if err != nil {
			return fmt.Errorf("load spool: %w", err)
		}
		spool = facts.DisplayID
		if facts.MaterialName != nil {
			spool += " (" + *facts.MaterialName
			if facts.ColorName != nil && strings.TrimSpace(*facts.ColorName) != "" {
				spool += ", " + *facts.ColorName
			}
			spool += ")"
		}
	}
	material := strings.TrimSpace(change.Material)
	materialNote := ""
	if material != "" {
		materialNote = " (" + material + ")"
	}
	recipients, err := e.printerRecipients(ctx, q, machine.OperatorPersonID, machine.CustomerPersonID)
	if err != nil {
		return err
	}
	return e.emit(ctx, tx, Event{
		Trigger: "filament_change",
		Fields:  map[string]any{"change": string(change.Kind), "machine": machineID.String()},
		Placeholders: map[string]string{
			"machine": machine.MachineName, "slot": strings.TrimSpace(change.Slot), "spool": spool, "material": material,
			"materialNote": materialNote, "run": *machine.RunDisplayID,
		},
		Recipients:    recipients,
		Organizations: map[string][]uuid.UUID{"recipient": uuidPtrList(machine.CustomerOrganizationID)},
		Subjects:      map[string]string{"machine": machineID.String()},
		Link:          machinePrinterLink(machineID),
	})
}

// machinePrinterLink opens the machine's printer setup, where slots and errors are shown.
func machinePrinterLink(machineID uuid.UUID) string {
	return "/workshop/machines/" + machineID.String() + "/printer"
}

// LabRulesPublished raises lab_rules_published for everyone who must confirm the version and has not done so. People
// whose roles do not ask for the Lab Rules and people without an enabled account (who could not confirm) are left out.
func (e *SystemEvents) LabRulesPublished(ctx context.Context, tx pgx.Tx, versionID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	revision, err := q.GetLabRulesRevision(ctx, versionID)
	if err != nil {
		return fmt.Errorf("load Lab Rules version: %w", err)
	}
	people, err := q.ListPeopleAwaitingLabRules(ctx, versionID)
	if err != nil {
		return fmt.Errorf("resolve people awaiting Lab Rules: %w", err)
	}
	return e.emit(ctx, tx, Event{
		Trigger:      "lab_rules_published",
		Placeholders: map[string]string{"version": revision},
		Recipients:   map[string][]uuid.UUID{"need_confirm": people},
		ResolveToken: "lab_rules:" + versionID.String(),
		Link:         LabRulesConfirmLink,
	})
}

// LabRulesConfirmed marks the person's Lab Rules notifications read once they confirmed the Lab Rules.
func (e *SystemEvents) LabRulesConfirmed(ctx context.Context, tx pgx.Tx, personID uuid.UUID) error {
	if _, err := notifyrulesdb.New(tx).MarkLabRulesNoticesRead(ctx, personID); err != nil {
		return fmt.Errorf("mark Lab Rules notifications read: %w", err)
	}
	return nil
}

// PeriodOpens raises period_opens when sign-up for a period opened.
func (e *SystemEvents) PeriodOpens(ctx context.Context, tx pgx.Tx, periodID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	period, err := q.GetOpenDayPeriodEventFacts(ctx, periodID)
	if err != nil {
		return fmt.Errorf("load open day period: %w", err)
	}
	people, err := q.ListStaffingPeople(ctx)
	if err != nil {
		return fmt.Errorf("resolve staffing people: %w", err)
	}
	deadline := ""
	if period.SignUpDeadline.Valid {
		deadline = period.SignUpDeadline.Time.Format("2 Jan")
	}
	return e.emit(ctx, tx, Event{
		Trigger:      "period_opens",
		Placeholders: map[string]string{"period": period.Name, "deadline": deadline},
		Recipients:   map[string][]uuid.UUID{"staffing_people": people},
		Link:         "/open-days/" + periodID.String(),
	})
}

// OpenDayPeriodChangeKind says what happened to a period's schedule; the value is the trigger's "change" field.
type OpenDayPeriodChangeKind string

const (
	OpenDayPeriodPublished OpenDayPeriodChangeKind = "published"
	OpenDayPeriodChanged   OpenDayPeriodChangeKind = "changed"
)

// OpenDayPeriodChanged raises open_day_period_changed when a period was published or its schedule changed while people
// could already see it. The throttle subject "period" lets a rule limit a burst of saves.
func (e *SystemEvents) OpenDayPeriodChanged(
	ctx context.Context,
	tx pgx.Tx,
	periodID uuid.UUID,
	kind OpenDayPeriodChangeKind,
) error {
	q := notifyrulesdb.New(tx)
	period, err := q.GetOpenDayPeriodChangeFacts(ctx, periodID)
	if err != nil {
		return fmt.Errorf("load open day period: %w", err)
	}
	people, err := q.ListStaffingPeople(ctx)
	if err != nil {
		return fmt.Errorf("resolve staffing people: %w", err)
	}
	return e.emit(ctx, tx, Event{
		Trigger: "open_day_period_changed",
		Fields:  map[string]any{"period": period.Name, "change": string(kind), "days": float64(period.DayCount)},
		Placeholders: map[string]string{
			"period": period.Name, "change": string(kind), "days": fmt.Sprintf("%d", period.DayCount),
		},
		Recipients: map[string][]uuid.UUID{"staffing_people": people},
		Subjects:   map[string]string{"period": periodID.String()},
		Link:       "/open-days/" + periodID.String(),
	})
}

// PlaceFreed raises place_freed when leavingPersonID gave up a supervisor place in a timeslot of a scheduled open day
// that starts within the warning window of the staffing rules, the same window the dashboard hint for a free place
// uses. Trainee places never raise it, so callers pass only supervisor places. The date is shown in location.
func (e *SystemEvents) PlaceFreed(
	ctx context.Context,
	tx pgx.Tx,
	timeslotID, leavingPersonID uuid.UUID,
	location *time.Location,
) error {
	q := notifyrulesdb.New(tx)
	day, err := q.GetOpenDayTimeslotEventFacts(ctx, timeslotID)
	if err != nil {
		return fmt.Errorf("load open day timeslot: %w", err)
	}
	windowDays, err := q.GetStaffingWarningDays(ctx)
	if err != nil {
		return fmt.Errorf("load staffing warning window: %w", err)
	}
	horizon := time.Duration(windowDays) * 24 * time.Hour
	now := e.dispatcher.now()
	if day.Status != "scheduled" || !day.StartsAt.After(now) || day.StartsAt.After(now.Add(horizon)) {
		return nil
	}
	free, err := q.ListUnassignedSupervisorPeople(ctx, notifyrulesdb.ListUnassignedSupervisorPeopleParams{
		TimeslotID: timeslotID, ExcludedPersonID: leavingPersonID,
	})
	if err != nil {
		return fmt.Errorf("resolve unassigned supervisors: %w", err)
	}
	team, err := q.ListOpenDayTeam(ctx, day.OpenDayID)
	if err != nil {
		return fmt.Errorf("resolve open day team: %w", err)
	}
	local := day.StartsAt.In(location)
	until := daysUntil(now, day.StartsAt)
	return e.emit(ctx, tx, Event{
		Trigger: "place_freed",
		Fields:  map[string]any{"daysUntil": until, "weekday": weekdayKey(local)},
		Placeholders: map[string]string{
			"day":       local.Format("Mon 2 Jan 2006"),
			"time":      clockRange(day.StartsAt, day.EndsAt, location),
			"daysUntil": fmt.Sprintf("%d", int(until)),
		},
		Recipients:   map[string][]uuid.UUID{"free_supervisors": free, "day_team": team},
		Subjects:     map[string]string{"open_day": day.OpenDayID.String()},
		ResolveToken: "open_day_place:" + timeslotID.String(),
		Link:         fmt.Sprintf("/open-days/%s/days/%s", day.PeriodID, day.OpenDayID),
	})
}

// OpenDayChangeKind says what changed about a person's own staffing of an open day; the value is the trigger raised.
type OpenDayChangeKind string

const (
	OpenDayTimeslotChanged   OpenDayChangeKind = "open_day_timeslot_changed"
	OpenDayTimeslotRemoved   OpenDayChangeKind = "open_day_timeslot_removed"
	OpenDayCancelled         OpenDayChangeKind = "open_day_cancelled"
	OpenDayAssignedByOther   OpenDayChangeKind = "open_day_assigned_by_other"
	OpenDayUnassignedByOther OpenDayChangeKind = "open_day_unassigned_by_other"
)

// OpenDaySlot is one timeslot an open-day notice talks about. WasStartsAt and WasEndsAt hold the earlier times of a
// timeslot that moved and are zero otherwise.
type OpenDaySlot struct {
	StartsAt, EndsAt       time.Time
	WasStartsAt, WasEndsAt time.Time
}

// OpenDayNotice describes the timeslots of one open day that changed for one person. One notice covers a person's
// whole day, so a save that touches several of their timeslots still raises one event. A zero OpenDayID names an open
// day that no longer exists; the notice then links to its period.
type OpenDayNotice struct {
	PeriodID, OpenDayID uuid.UUID
	Slots               []OpenDaySlot
}

// OpenDayPersonNotice raises the open-day change trigger for one person whose own staffing changed. A person without
// an enabled account gets nothing. The times are written in location. It never decides who caused the change: callers
// leave out the person who acted.
func (e *SystemEvents) OpenDayPersonNotice(
	ctx context.Context,
	tx pgx.Tx,
	kind OpenDayChangeKind,
	personID uuid.UUID,
	input OpenDayNotice,
	location *time.Location,
) error {
	if len(input.Slots) == 0 {
		return nil
	}
	trigger, known := LookupTrigger(string(kind))
	if !known || trigger.Subject != SubjectSelf {
		return fmt.Errorf("%s is not an open-day change trigger", kind)
	}
	q := notifyrulesdb.New(tx)
	enabled, err := q.ListPeopleWithEnabledAccount(ctx, uuidStrings([]uuid.UUID{personID}))
	if err != nil {
		return fmt.Errorf("resolve open day notification account: %w", err)
	}
	if len(enabled) == 0 {
		return nil
	}
	slots := input.Slots
	local := slots[0].StartsAt.In(location)
	ranges := make([]string, 0, len(slots))
	for _, slot := range slots {
		text := clockRange(slot.StartsAt, slot.EndsAt, location)
		if !slot.WasStartsAt.IsZero() {
			text += " (was " + clockRange(slot.WasStartsAt, slot.WasEndsAt, location) + ")"
		}
		ranges = append(ranges, text)
	}
	plural := len(slots) > 1
	choose := func(singular, many string) string {
		if plural {
			return many
		}
		return singular
	}
	link := "/open-days/" + input.PeriodID.String()
	if input.OpenDayID != uuid.Nil {
		link += "/days/" + input.OpenDayID.String()
	}
	return e.emit(ctx, tx, Event{
		Trigger: string(kind),
		Fields:  map[string]any{"daysUntil": daysUntil(e.dispatcher.now(), slots[0].StartsAt), "weekday": weekdayKey(local)},
		Placeholders: map[string]string{
			"day":     local.Format("Mon 2 Jan 2006"),
			"time":    strings.Join(ranges, ", "),
			"slots":   choose("timeslot", "timeslots"),
			"changed": choose("has changed", "have changed"),
			"wasWere": choose("was", "were"),
			"them":    choose("it", "them"),
		},
		Recipients: map[string][]uuid.UUID{"self": {personID}},
		Link:       link,
	})
}

func clockRange(start, end time.Time, location *time.Location) string {
	return start.In(location).Format("15:04") + "–" + end.In(location).Format("15:04")
}

// PrinterErrorCleared ends the waiting escalations of the firings for the error: the printer no longer reports it.
func (e *SystemEvents) PrinterErrorCleared(ctx context.Context, tx pgx.Tx, machineID uuid.UUID, code string) error {
	return e.dispatcher.Resolve(ctx, tx, "printer_error:"+machineID.String()+":"+code, "error_cleared")
}

// PlaceTaken ends the waiting escalations of the firings for the timeslot's freed place.
func (e *SystemEvents) PlaceTaken(ctx context.Context, tx pgx.Tx, timeslotID uuid.UUID) error {
	return e.dispatcher.Resolve(ctx, tx, "open_day_place:"+timeslotID.String(), "place_taken")
}
