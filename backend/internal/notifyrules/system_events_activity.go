package notifyrules

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"context"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The methods in this file raise the triggers of everyday activity: visits, accounts, trainings, surveys, roles,
// privacy requests, open day sign-ups, orders and jobs. They load the facts of what just happened inside the caller's
// transaction, so a rule sees the committed state of the mutation or none of it. Placeholders hold names only where
// staff see the same names in the application; they never hold addresses, tokens or free text.

func euros(amount float64) string { return fmt.Sprintf("€ %.2f", amount) }

func capitalize(text string) string {
	if text == "" {
		return text
	}
	return strings.ToUpper(text[:1]) + text[1:]
}

// nameOf is the display name of one person, empty when the person no longer exists.
func (e *SystemEvents) nameOf(ctx context.Context, q *notifyrulesdb.Queries, person *uuid.UUID) (string, error) {
	if person == nil {
		return "", nil
	}
	rows, err := q.ListPeopleNames(ctx, uuidStrings([]uuid.UUID{*person}))
	if err != nil {
		return "", fmt.Errorf("load person name: %w", err)
	}
	if len(rows) == 0 {
		return "", nil
	}
	return personName(rows[0].FirstName, rows[0].LastName), nil
}

// membershipOf is the system role (supervisor, trainee, visitor) of a person, empty without one.
func (e *SystemEvents) membershipOf(ctx context.Context, q *notifyrulesdb.Queries, person uuid.UUID) (string, error) {
	rows, err := q.ListMembershipsOfPeople(ctx, uuidStrings([]uuid.UUID{person}))
	if err != nil {
		return "", fmt.Errorf("load membership: %w", err)
	}
	if len(rows) == 0 {
		return "", nil
	}
	return rows[0].Membership, nil
}

func without(people []uuid.UUID, excluded uuid.UUID) []uuid.UUID {
	return removePeople(people, []uuid.UUID{excluded})
}

// CheckIn raises check_in for a visit that just started. The supervisors "on duty" are the supervisors who are checked
// in at that moment, not the ones signed up for an open day.
func (e *SystemEvents) CheckIn(ctx context.Context, tx pgx.Tx, visitID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	visit, err := q.GetVisitEventFacts(ctx, visitID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load visit: %w", err)
	}
	role, err := e.membershipOf(ctx, q, visit.PersonID)
	if err != nil {
		return err
	}
	onDuty, err := q.ListSupervisorsOnDuty(ctx)
	if err != nil {
		return fmt.Errorf("list supervisors on duty: %w", err)
	}
	fields := map[string]any{"firstVisit": visit.FirstVisit, "labRules": "confirmed"}
	if visit.AdmissionDecision == "warning" {
		fields["labRules"] = "not_confirmed"
	}
	placeholders := map[string]string{
		"person": personName(visit.FirstName, visit.LastName), "systemRole": capitalize(role), "method": "",
		"device": "", "deviceNote": "",
	}
	if role != "" {
		fields["systemRole"] = role
	}
	switch visit.CheckInMethod {
	case "password":
		fields["method"], placeholders["method"] = "password", "with their password"
	case "pin":
		fields["method"], placeholders["method"] = "pin", "with their PIN"
	case "supervisor":
		fields["method"], placeholders["method"] = "supervised", "with a supervisor"
	case "enrollment":
		fields["method"], placeholders["method"] = "enrollment", "through the enrolment"
	}
	if visit.CheckInDevice != nil {
		fields["device"] = *visit.CheckInDevice
		placeholders["device"] = *visit.CheckInDevice
		placeholders["deviceNote"] = " at " + *visit.CheckInDevice
	}
	return e.emit(ctx, tx, Event{
		Trigger:      "check_in",
		Fields:       fields,
		Placeholders: placeholders,
		Recipients:   map[string][]uuid.UUID{"self": {visit.PersonID}, "on_duty": without(onDuty, visit.PersonID)},
		Subjects:     map[string]string{"person": visit.PersonID.String()},
		Link:         "/attendance",
		OccurredAt:   visit.CheckedInAt,
	})
}

// CheckOut raises check_out for a visit that just ended.
func (e *SystemEvents) CheckOut(ctx context.Context, tx pgx.Tx, visitID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	visit, err := q.GetVisitEventFacts(ctx, visitID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load visit: %w", err)
	}
	if !visit.CheckedOutAt.Valid {
		return nil
	}
	role, err := e.membershipOf(ctx, q, visit.PersonID)
	if err != nil {
		return err
	}
	onDuty, err := q.ListSupervisorsOnDuty(ctx)
	if err != nil {
		return fmt.Errorf("list supervisors on duty: %w", err)
	}
	stayed := visit.CheckedOutAt.Time.Sub(visit.CheckedInAt)
	fields := map[string]any{"stayed": max(stayed, 0).Hours()}
	if role != "" {
		fields["systemRole"] = role
	}
	if visit.CheckOutMethod != nil {
		switch *visit.CheckOutMethod {
		case "password", "pin":
			fields["method"] = "self"
		case "public_tap":
			fields["method"] = "tap"
		case "supervisor":
			fields["method"] = "supervised"
		}
	}
	placeholders := map[string]string{
		"person": personName(visit.FirstName, visit.LastName), "systemRole": capitalize(role),
		"stayed": formatDuration(max(stayed, 0)), "device": "",
	}
	if visit.CheckOutDevice != nil {
		placeholders["device"] = *visit.CheckOutDevice
	}
	return e.emit(ctx, tx, Event{
		Trigger:      "check_out",
		Fields:       fields,
		Placeholders: placeholders,
		Recipients:   map[string][]uuid.UUID{"self": {visit.PersonID}, "on_duty": without(onDuty, visit.PersonID)},
		Subjects:     map[string]string{"person": visit.PersonID.String()},
		Link:         "/attendance",
		OccurredAt:   visit.CheckedOutAt.Time,
	})
}

// AccountCreated raises account_created for the person an account was just created for.
func (e *SystemEvents) AccountCreated(ctx context.Context, tx pgx.Tx, personID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	name, err := e.nameOf(ctx, q, &personID)
	if err != nil {
		return err
	}
	role, err := e.membershipOf(ctx, q, personID)
	if err != nil {
		return err
	}
	fields := map[string]any{}
	if role != "" {
		fields["systemRole"] = role
	}
	return e.emit(ctx, tx, Event{
		Trigger:      "account_created",
		Fields:       fields,
		Placeholders: map[string]string{"person": name, "systemRole": capitalize(role)},
		Recipients:   map[string][]uuid.UUID{"self": {personID}},
		Link:         "/people/" + personID.String(),
	})
}

// TrainingRecorded raises training_recorded when a person became trained or trainer for a training. status is
// "trained" or "trainer".
func (e *SystemEvents) TrainingRecorded(ctx context.Context, tx pgx.Tx, personID, trainingID uuid.UUID, status string) error {
	if status != "trained" && status != "trainer" {
		return nil
	}
	q := notifyrulesdb.New(tx)
	training, err := q.GetTrainingName(ctx, trainingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load training: %w", err)
	}
	name, err := e.nameOf(ctx, q, &personID)
	if err != nil {
		return err
	}
	trainers, err := q.ListTrainersOfTraining(ctx, trainingID)
	if err != nil {
		return fmt.Errorf("list trainers: %w", err)
	}
	return e.emit(ctx, tx, Event{
		Trigger:      "training_recorded",
		Fields:       map[string]any{"training": trainingID.String(), "status": status},
		Placeholders: map[string]string{"person": name, "training": training, "status": status},
		Recipients:   map[string][]uuid.UUID{"self": {personID}, "trainers": without(trainers, personID)},
		Subjects:     map[string]string{"training": trainingID.String()},
		Link:         "/people/" + personID.String(),
	})
}

// SurveyAnswered raises survey_answered for a stored response. The event carries the survey's name and the first rating
// only: nothing that points to the respondent, and no recipient from the response, so an anonymous survey stays
// anonymous in the notification centre as well.
func (e *SystemEvents) SurveyAnswered(ctx context.Context, tx pgx.Tx, responseID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	survey, err := q.GetSurveyResponseEventFacts(ctx, responseID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load survey response: %w", err)
	}
	fields := map[string]any{"survey": survey.SurveyName, "anonymous": survey.Anonymous}
	placeholders := map[string]string{"survey": survey.SurveyName, "rating": "", "ratingNote": ""}
	rating, err := q.GetFirstRatingOfResponse(ctx, responseID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("load rating: %w", err)
	}
	if err == nil {
		fields["rating"] = float64(rating)
		placeholders["rating"] = fmt.Sprintf("%d", rating)
		placeholders["ratingNote"] = fmt.Sprintf(" rated %d", rating)
	}
	return e.emit(ctx, tx, Event{
		Trigger:      "survey_answered",
		Fields:       fields,
		Placeholders: placeholders,
		Link:         "/settings/surveys",
	})
}

// RoleChanged raises role_changed after a role was added to or removed from a person by the account actorAccountID.
func (e *SystemEvents) RoleChanged(
	ctx context.Context,
	tx pgx.Tx,
	personID, roleID uuid.UUID,
	assigned bool,
	actorAccountID uuid.UUID,
) error {
	q := notifyrulesdb.New(tx)
	role, err := q.GetRoleEventFacts(ctx, roleID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load role: %w", err)
	}
	name, err := e.nameOf(ctx, q, &personID)
	if err != nil {
		return err
	}
	by := ""
	actors, err := q.ListPersonIDsOfAccounts(ctx, uuidStrings([]uuid.UUID{actorAccountID}))
	if err != nil {
		return fmt.Errorf("resolve actor: %w", err)
	}
	if len(actors) > 0 {
		if by, err = e.nameOf(ctx, q, &actors[0]); err != nil {
			return err
		}
	}
	change := "removed"
	if assigned {
		change = "assigned"
	}
	word := "removed"
	if assigned {
		word = "added"
	}
	return e.emit(ctx, tx, Event{
		Trigger:      "role_changed",
		Fields:       map[string]any{"change": change, "role": roleID.String(), "privileged": role.Privileged},
		Placeholders: map[string]string{"person": name, "role": role.Name, "change": word, "by": by},
		Recipients:   map[string][]uuid.UUID{"self": {personID}},
		Subjects:     map[string]string{"role": roleID.String()},
		Link:         "/people/" + personID.String(),
	})
}

// NotificationSettingsChanged raises notification_settings_changed once for a save that changed a person's channel
// choices, feedback-at-check-out switch or consents. changes are readable lines of what changed, labels only; the
// actor is the person who saved, the person themselves or a staff member.
func (e *SystemEvents) NotificationSettingsChanged(
	ctx context.Context,
	tx pgx.Tx,
	personID, actorPersonID uuid.UUID,
	changes []string,
	consentChanged bool,
) error {
	q := notifyrulesdb.New(tx)
	name, err := e.nameOf(ctx, q, &personID)
	if err != nil {
		return err
	}
	by := name
	if actorPersonID != personID {
		if by, err = e.nameOf(ctx, q, &actorPersonID); err != nil {
			return err
		}
	}
	return e.emit(ctx, tx, Event{
		Trigger:      "notification_settings_changed",
		Fields:       map[string]any{"bySelf": actorPersonID == personID, "consentChanged": consentChanged},
		Placeholders: map[string]string{"person": name, "by": by, "changes": strings.Join(changes, "\n")},
		Recipients:   map[string][]uuid.UUID{"self": {personID}},
		Subjects:     map[string]string{"person": personID.String()},
		Link:         "/people/" + personID.String(),
	})
}

// PrivacyRequestCreated raises privacy_request_created for a request that was just recorded. It has no person
// recipients: rules name the roles that handle privacy requests.
func (e *SystemEvents) PrivacyRequestCreated(ctx context.Context, tx pgx.Tx, requestID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	request, err := q.GetPrivacyRequestEventFacts(ctx, requestID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load privacy request: %w", err)
	}
	name, err := e.nameOf(ctx, q, request.SubjectPersonID)
	if err != nil {
		return err
	}
	kind := "access"
	word := "access"
	if request.Kind == "erasure" {
		kind, word = "erasure", "deletion"
	}
	return e.emit(ctx, tx, Event{
		Trigger: "privacy_request_created",
		Fields:  map[string]any{"type": kind},
		Placeholders: map[string]string{
			"type": word, "person": name, "reference": request.Reference, "due": request.DueAt.Format("2 Jan"),
		},
		Link: "/settings/privacy/requests/" + requestID.String(),
	})
}

// OpenDaySignup raises open_day_signup when a person took a place in a timeslot. placeType is "supervisor" or
// "trainee"; bySelf says the person signed up themselves. The times are written in location.
func (e *SystemEvents) OpenDaySignup(
	ctx context.Context,
	tx pgx.Tx,
	timeslotID, personID uuid.UUID,
	placeType string,
	bySelf bool,
	location *time.Location,
) error {
	q := notifyrulesdb.New(tx)
	day, err := q.GetOpenDayTimeslotEventFacts(ctx, timeslotID)
	if err != nil {
		return fmt.Errorf("load open day timeslot: %w", err)
	}
	team, err := q.ListOpenDayTeam(ctx, day.OpenDayID)
	if err != nil {
		return fmt.Errorf("resolve open day team: %w", err)
	}
	name, err := e.nameOf(ctx, q, &personID)
	if err != nil {
		return err
	}
	local := day.StartsAt.In(location)
	until := daysUntil(e.dispatcher.now(), day.StartsAt)
	return e.emit(ctx, tx, Event{
		Trigger: "open_day_signup",
		Fields: map[string]any{
			"placeType": placeType, "daysUntil": until, "weekday": weekdayKey(local), "bySelf": bySelf,
		},
		Placeholders: map[string]string{
			"person": name, "place": placeType + " place", "day": local.Format("Mon 2 Jan 2006"),
			"time": clockRange(day.StartsAt, day.EndsAt, location), "daysUntil": fmt.Sprintf("%d", int(until)),
		},
		Recipients: map[string][]uuid.UUID{"self": {personID}, "day_team": without(team, personID)},
		Subjects:   map[string]string{"open_day": day.OpenDayID.String()},
		Link:       fmt.Sprintf("/open-days/%s/days/%s", day.PeriodID, day.OpenDayID),
	})
}

// OrderCreated raises order_created for an order that was just finalized.
func (e *SystemEvents) OrderCreated(ctx context.Context, tx pgx.Tx, orderID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	order, err := q.GetOrderEventFacts(ctx, orderID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load order: %w", err)
	}
	fields := map[string]any{"amount": order.Total}
	switch {
	case order.CustomerPersonID != nil:
		fields["customerType"] = "person"
	case order.CustomerOrganizationID != nil:
		fields["customerType"] = "organization"
	}
	return e.emit(ctx, tx, Event{
		Trigger: "order_created",
		Fields:  fields,
		Placeholders: map[string]string{
			"order": order.Reference, "amount": euros(order.Total), "customer": order.CustomerName,
		},
		Recipients: map[string][]uuid.UUID{
			"customer": uuidPtrList(order.CustomerPersonID), "creator": uuidPtrList(order.CreatorPersonID),
		},
		Organizations: map[string][]uuid.UUID{"customer": uuidPtrList(order.CustomerOrganizationID)},
		Link:          "/orders/" + orderID.String(),
	})
}

// PaymentRecorded raises payment_recorded for a payment that was just booked on an order.
func (e *SystemEvents) PaymentRecorded(ctx context.Context, tx pgx.Tx, paymentID, orderID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	payment, err := q.GetPaymentEventFacts(ctx, paymentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load payment: %w", err)
	}
	order, err := q.GetOrderEventFacts(ctx, orderID)
	if err != nil {
		return fmt.Errorf("load order: %w", err)
	}
	method := payment.Method
	word := method
	if method == "external" {
		word = "wiRef invoice"
	}
	return e.emit(ctx, tx, Event{
		Trigger:      "payment_recorded",
		Fields:       map[string]any{"method": method, "amount": payment.Amount},
		Placeholders: map[string]string{"order": order.Reference, "amount": euros(payment.Amount), "method": word},
		Recipients: map[string][]uuid.UUID{
			"booker": uuidPtrList(payment.BookerPersonID), "customer": uuidPtrList(order.CustomerPersonID),
		},
		Organizations: map[string][]uuid.UUID{"customer": uuidPtrList(order.CustomerOrganizationID)},
		Link:          "/orders/" + orderID.String(),
	})
}

// CashCountDifference raises cash_count_difference for a count that differed from the expected amount. A count that
// matched raises nothing.
func (e *SystemEvents) CashCountDifference(ctx context.Context, tx pgx.Tx, countID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	count, err := q.GetCashCountEventFacts(ctx, countID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load cash count: %w", err)
	}
	if count.Difference == 0 {
		return nil
	}
	counter, err := e.nameOf(ctx, q, count.RecordedByPersonID)
	if err != nil {
		return err
	}
	direction, size := "over", count.Difference
	if count.Difference < 0 {
		direction, size = "short", -count.Difference
	}
	return e.emit(ctx, tx, Event{
		Trigger: "cash_count_difference",
		Fields:  map[string]any{"difference": count.Difference},
		Placeholders: map[string]string{
			"count": count.Reference, "difference": euros(size), "direction": direction,
			"expected": euros(count.Expected), "counted": euros(count.Counted), "counter": counter,
		},
		Recipients: map[string][]uuid.UUID{"counter": uuidPtrList(count.RecordedByPersonID)},
	})
}

// InvoiceRequestStatus raises wiref_invoice_status after a wiRef invoice request moved to a new state.
func (e *SystemEvents) InvoiceRequestStatus(ctx context.Context, tx pgx.Tx, requestID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	request, err := q.GetInvoiceRequestEventFacts(ctx, requestID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load invoice request: %w", err)
	}
	words := map[string]string{
		"draft": "returned to draft", "submitted": "waiting for approval", "issued": "issued",
		"cancellation_requested": "waiting for its cancellation", "cancelled": "cancelled",
	}
	link := ""
	if request.OrderID != nil {
		link = "/orders/" + request.OrderID.String()
	}
	return e.emit(ctx, tx, Event{
		Trigger: "wiref_invoice_status",
		Fields:  map[string]any{"status": request.State},
		Placeholders: map[string]string{
			"invoice": request.Reference, "order": request.OrderReference, "status": words[request.State],
		},
		Recipients: map[string][]uuid.UUID{"creator": uuidPtrList(request.CreatorPersonID)},
		Link:       link,
	})
}

// JobCreated raises job_created for a job that was just created.
func (e *SystemEvents) JobCreated(ctx context.Context, tx pgx.Tx, jobID uuid.UUID) error {
	q := notifyrulesdb.New(tx)
	job, err := q.GetJobEventFacts(ctx, jobID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load job: %w", err)
	}
	operator, err := e.nameOf(ctx, q, job.OperatorPersonID)
	if err != nil {
		return err
	}
	title := job.DisplayID
	if job.Title != nil && strings.TrimSpace(*job.Title) != "" {
		title = *job.Title
	}
	fields := map[string]any{"machine": job.MachineID.String()}
	switch {
	case job.CustomerPersonID != nil:
		fields["recipientType"] = "person"
	case job.CustomerOrganizationID != nil:
		fields["recipientType"] = "organization"
	}
	return e.emit(ctx, tx, Event{
		Trigger:      "job_created",
		Fields:       fields,
		Placeholders: map[string]string{"job": title, "machine": job.MachineName, "operator": operator},
		Recipients: map[string][]uuid.UUID{
			"operator": uuidPtrList(job.OperatorPersonID), "recipient": uuidPtrList(job.CustomerPersonID),
		},
		Organizations: map[string][]uuid.UUID{"recipient": uuidPtrList(job.CustomerOrganizationID)},
		Subjects:      map[string]string{"machine": job.MachineID.String()},
		Link:          "/workshop/jobs/" + jobID.String(),
	})
}
