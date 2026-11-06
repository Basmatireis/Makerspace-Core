package notifyrules

import (
	"context"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

// maxLoopItems bounds how many items one rule run looks at.
const maxLoopItems = 5000

// Item is one thing of a collection a rule loops over.
type Item struct {
	Key  string
	Name string
	// Fields hold the values of the collection's fields by bare key.
	Fields map[string]any
	// Text overrides how a field reads in texts (a machine's name instead of its identifier).
	Text          map[string]string
	Recipients    map[string][]uuid.UUID
	Organizations map[string][]uuid.UUID
	Link          string
}

// display words a field value for texts and previews.
func (i Item) display(field Field) string {
	if text, ok := i.Text[field.Key]; ok {
		return text
	}
	return formatValue(field, i.Fields[field.Key])
}

// placeholders are the item's fields as {prefix.field} texts.
func (i Item) placeholders(c Collection) map[string]string {
	values := make(map[string]string, len(c.Fields))
	for _, field := range c.Fields {
		if _, ok := i.Fields[field.Key]; ok {
			values[c.PlaceholderPrefix+"."+field.Key] = i.display(field)
		}
	}
	return values
}

// formatValue words a field value: option labels, money with its sign, durations with their unit.
func formatValue(field Field, value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case bool:
		if typed {
			return "yes"
		}
		return "no"
	case string:
		for _, option := range field.Options {
			if option.Value == typed {
				return option.Label
			}
		}
		return typed
	case []string:
		return strings.Join(typed, ", ")
	}
	number, ok := toFloat(value)
	if !ok {
		return fmt.Sprint(value)
	}
	return formatNumber(number, field.Unit)
}

func formatNumber(number float64, unit string) string {
	switch unit {
	case "€":
		return strconv.FormatFloat(math.Round(number*100)/100, 'f', 2, 64) + " €"
	case "":
		return trimNumber(number)
	}
	return trimNumber(number) + " " + unit
}

func trimNumber(number float64) string {
	if number == math.Trunc(number) {
		return strconv.FormatInt(int64(number), 10)
	}
	return strconv.FormatFloat(math.Round(number*10)/10, 'f', 1, 64)
}

func personName(first, last string) string {
	return strings.TrimSpace(first + " " + last)
}

func wholeDays(from, to time.Time) float64 {
	if !to.After(from) {
		return 0
	}
	return math.Floor(to.Sub(from).Hours() / 24)
}

// loadCollection loads the items of a collection as they are at the moment.
func (d *Dispatcher) loadCollection(ctx context.Context, q *store, c Collection, now time.Time) ([]Item, error) {
	var items []Item
	var err error
	switch c.Key {
	case "people":
		items, err = d.loadPeople(ctx, q, now)
	case "open_days":
		items, err = d.loadCurrentOpenDays(ctx, q, now)
	case "machines":
		items, err = d.loadMachines(ctx, q, now)
	case "spools":
		items, err = d.loadSpools(ctx, q, now)
	case "orders":
		items, err = d.loadOrders(ctx, q, now)
	case "jobs":
		items, err = d.loadJobs(ctx, q, now)
	case "articles":
		items, err = d.loadArticles(ctx, q)
	case "trainings":
		items, err = d.loadTrainings(ctx, q, now)
	default:
		return nil, fmt.Errorf("unknown collection %q", c.Key)
	}
	if err != nil {
		return nil, fmt.Errorf("load %s: %w", c.Plural, err)
	}
	return items, nil
}

type staffingFact struct {
	Done, Minimum int
	Below         bool
}

// staffingFacts counts each person's open days of the current semester against their minimum with the staffing
// package's own rules, so the notification rules and the staffing pages agree.
func (d *Dispatcher) staffingFacts(
	ctx context.Context,
	q *store,
	people []uuid.UUID,
	now time.Time,
) (map[uuid.UUID]staffingFact, error) {
	facts := make(map[uuid.UUID]staffingFact, len(people))
	reader := staffing.NewReader(q.db, d.location)
	rules, err := reader.Rules(ctx)
	if err != nil {
		return nil, fmt.Errorf("load staffing rules: %w", err)
	}
	semester, err := reader.CurrentSemester(ctx, rules, now)
	if err != nil || semester == nil {
		return facts, err
	}
	counts, err := reader.Counts(ctx, rules, semester, now, nil)
	if err != nil {
		return nil, fmt.Errorf("count open days: %w", err)
	}
	minimums, err := reader.Minimums(ctx, rules, semester, nil)
	if err != nil {
		return nil, fmt.Errorf("load minimums: %w", err)
	}
	memberships, err := q.ListMembershipsOfPeople(ctx, uuidStrings(people))
	if err != nil {
		return nil, fmt.Errorf("load memberships: %w", err)
	}
	held := map[uuid.UUID]roles.Membership{}
	for _, row := range memberships {
		held[row.PersonID] = roles.Membership(row.Membership)
	}
	for _, person := range people {
		membership, ok := held[person]
		if !ok {
			membership = roles.MembershipVisitor
		}
		minimum := minimums.For(person, membership)
		standing := staffing.StatusFor(membership, counts[person], rules, minimum)
		facts[person] = staffingFact{
			Done: counts[person].Staffed + counts[person].Booked, Minimum: minimum.Value,
			Below: standing.Status == staffing.StatusMissing,
		}
	}
	return facts, nil
}

type unpaidFact struct {
	Amount float64
	Orders int
	Days   float64
}

func (d *Dispatcher) unpaidFacts(
	ctx context.Context,
	q *store,
	people []uuid.UUID,
	now time.Time,
) (map[uuid.UUID]unpaidFact, error) {
	rows, err := q.ListUnpaidOfPeople(ctx, uuidStrings(people))
	if err != nil {
		return nil, fmt.Errorf("load unpaid orders: %w", err)
	}
	facts := make(map[uuid.UUID]unpaidFact, len(rows))
	for _, row := range rows {
		if row.PersonID == nil {
			continue
		}
		facts[*row.PersonID] = unpaidFact{Amount: row.Amount, Orders: int(row.Orders), Days: wholeDays(row.Oldest, now)}
	}
	return facts, nil
}

func (d *Dispatcher) loadPeople(ctx context.Context, q *store, now time.Time) ([]Item, error) {
	rows, err := q.LoadPeopleItems(ctx, maxLoopItems)
	if err != nil {
		return nil, err
	}
	people := make([]uuid.UUID, len(rows))
	for i, row := range rows {
		people[i] = row.ID
	}
	memberships, err := q.ListMembershipsOfPeople(ctx, uuidStrings(people))
	if err != nil {
		return nil, err
	}
	membership := map[uuid.UUID]string{}
	for _, row := range memberships {
		membership[row.PersonID] = row.Membership
	}
	roleRows, err := q.ListRoleIDsOfPeople(ctx, uuidStrings(people))
	if err != nil {
		return nil, err
	}
	roleNames, err := q.ListRoleOptions(ctx)
	if err != nil {
		return nil, err
	}
	nameOf := map[uuid.UUID]string{}
	for _, role := range roleNames {
		nameOf[role.ID] = role.Name
	}
	held := map[uuid.UUID][]string{}
	heldNames := map[uuid.UUID][]string{}
	for _, row := range roleRows {
		held[row.PersonID] = append(held[row.PersonID], row.RoleID.String())
		heldNames[row.PersonID] = append(heldNames[row.PersonID], nameOf[row.RoleID])
	}
	visits, err := q.ListLastVisits(ctx, uuidStrings(people))
	if err != nil {
		return nil, err
	}
	lastVisit := map[uuid.UUID]time.Time{}
	for _, row := range visits {
		lastVisit[row.PersonID] = row.LastVisit
	}
	unpaid, err := d.unpaidFacts(ctx, q, people, now)
	if err != nil {
		return nil, err
	}
	staffed, err := d.staffingFacts(ctx, q, people, now)
	if err != nil {
		return nil, err
	}
	awaiting := map[uuid.UUID]bool{}
	if version, versionErr := q.GetCurrentLabRulesVersion(ctx, pgtype.Timestamptz{Time: now, Valid: true}); versionErr == nil {
		waiting, err := q.ListPeopleAwaitingVersion(ctx, version)
		if err != nil {
			return nil, err
		}
		for _, person := range waiting {
			awaiting[person] = true
		}
	}
	items := make([]Item, 0, len(rows))
	for _, row := range rows {
		system := membership[row.ID]
		if system == "" {
			system = "visitor"
		}
		days := float64(neverVisitedDays)
		if visited, ok := lastVisit[row.ID]; ok {
			days = wholeDays(visited, now)
		}
		labRules := "confirmed"
		if awaiting[row.ID] {
			labRules = "not_confirmed"
		}
		held := held[row.ID]
		if held == nil {
			held = []string{}
		}
		name := personName(row.FirstName, row.LastName)
		items = append(items, Item{
			Key: row.ID.String(), Name: name,
			Fields: map[string]any{
				"name": name, "systemRole": system, "roles": held, "hasAccount": row.HasAccount,
				"unpaid": unpaid[row.ID].Amount, "unpaidOrders": float64(unpaid[row.ID].Orders),
				"oldestUnpaid": unpaid[row.ID].Days, "openDays": float64(staffed[row.ID].Done),
				"minimum": float64(staffed[row.ID].Minimum), "lastVisit": days, "labRules": labRules,
				"running": float64(row.Running),
			},
			Text:       map[string]string{"roles": strings.Join(heldNames[row.ID], ", ")},
			Recipients: map[string][]uuid.UUID{"item": {row.ID}},
		})
	}
	return items, nil
}

func (d *Dispatcher) localClock(start, end time.Time) string {
	return start.In(d.location).Format("15:04") + "–" + end.In(d.location).Format("15:04")
}

func (d *Dispatcher) localDay(moment time.Time) string {
	return moment.In(d.location).Format("Mon 2 Jan")
}

// openDayItems loads open days starting in the window together with the people signed up for them.
func (d *Dispatcher) openDayItems(
	ctx context.Context,
	q *store,
	period *uuid.UUID,
	from, to, now time.Time,
) ([]Item, error) {
	rows, err := q.LoadOpenDayItems(ctx, notifyrulesdb.LoadOpenDayItemsParams{
		PeriodID: period, FromTime: from, ToTime: to, MaxItems: maxLoopItems,
	})
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, len(rows))
	for i, row := range rows {
		ids[i] = row.ID
	}
	teamRows, err := q.ListOpenDayTeams(ctx, uuidStrings(ids))
	if err != nil {
		return nil, err
	}
	team := map[uuid.UUID][]uuid.UUID{}
	onDuty := map[uuid.UUID][]uuid.UUID{}
	for _, row := range teamRows {
		team[row.OpenDayID] = append(team[row.OpenDayID], row.PersonID)
		if row.Kind == "supervisor" {
			onDuty[row.OpenDayID] = append(onDuty[row.OpenDayID], row.PersonID)
		}
	}
	items := make([]Item, 0, len(rows))
	for _, row := range rows {
		weekday := weekdayKey(row.StartsAt.In(d.location))
		clock := d.localClock(row.StartsAt, row.EndsAt)
		items = append(items, Item{
			Key: row.ID.String(), Name: d.localDay(row.StartsAt) + " " + clock,
			Fields: map[string]any{
				"weekday": weekday, "startsIn": daysUntil(now, row.StartsAt), "supervisors": float64(row.Supervisors),
				"free": float64(row.Free), "trainees": float64(row.Trainees), "timeslots": float64(row.Timeslots),
				"cancelled": row.Status != "scheduled",
			},
			Text:          map[string]string{"day": d.localDay(row.StartsAt), "time": clock},
			Recipients:    map[string][]uuid.UUID{"team": dedupePeople(team[row.ID]), "supervisors_on": dedupePeople(onDuty[row.ID])},
			Link:          "/open-days/" + row.PeriodID.String() + "/days/" + row.ID.String(),
			Organizations: nil,
		})
		items[len(items)-1].Fields["status"] = row.Status
		items[len(items)-1].Fields["startsAt"] = row.StartsAt
		items[len(items)-1].Fields["endsAt"] = row.EndsAt
	}
	return items, nil
}

func (d *Dispatcher) loadCurrentOpenDays(ctx context.Context, q *store, now time.Time) ([]Item, error) {
	reader := staffing.NewReader(q.db, d.location)
	rules, err := reader.Rules(ctx)
	if err != nil {
		return nil, err
	}
	semester, err := reader.CurrentSemester(ctx, rules, now)
	if err != nil || semester == nil {
		return nil, err
	}
	items, err := d.openDayItems(ctx, q, &semester.ID, time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC),
		time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC), now)
	for i := range items {
		// Only the catalog's fields stay in the item; the helper fields served the schedules.
		delete(items[i].Fields, "status")
		delete(items[i].Fields, "startsAt")
		delete(items[i].Fields, "endsAt")
	}
	return items, err
}

func (d *Dispatcher) loadMachines(ctx context.Context, q *store, now time.Time) ([]Item, error) {
	local := now.In(d.location)
	dayStart := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, d.location)
	rows, err := q.LoadMachineItems(ctx, notifyrulesdb.LoadMachineItemsParams{
		DayStart: pgtype.Timestamptz{Time: dayStart, Valid: true}, WeekStart: now.Add(-7 * 24 * time.Hour),
		OnlineSince: pgtype.Timestamptz{Time: now.Add(-5 * time.Minute), Valid: true}, MaxItems: maxLoopItems,
	})
	if err != nil {
		return nil, err
	}
	processes, err := q.ListProcessNames(ctx)
	if err != nil {
		return nil, err
	}
	processName := map[uuid.UUID]string{}
	for _, process := range processes {
		processName[process.ID] = process.Name
	}
	items := make([]Item, 0, len(rows))
	for _, row := range rows {
		items = append(items, Item{
			Key: row.ID.String(), Name: row.Name,
			Fields: map[string]any{
				"name": row.Name, "process": row.ProcessID.String(), "status": row.Status,
				"runsToday": float64(row.RunsToday), "errorsWeek": float64(row.ErrorsWeek), "online": row.Online,
			},
			Text: map[string]string{"process": processName[row.ProcessID]},
		})
	}
	return items, nil
}

func (d *Dispatcher) loadSpools(ctx context.Context, q *store, now time.Time) ([]Item, error) {
	rows, err := q.LoadSpoolItems(ctx, maxLoopItems)
	if err != nil {
		return nil, err
	}
	items := make([]Item, 0, len(rows))
	for _, row := range rows {
		label := row.MaterialTypeName
		if row.ColorName != "" {
			label += ", " + row.ColorName
		}
		name := row.DisplayID + " (" + label + ")"
		items = append(items, Item{
			Key: row.ID.String(), Name: name,
			Fields: map[string]any{
				"name": name, "material": row.MaterialTypeID.String(), "remaining": row.Remaining,
				"loaded": row.Loaded, "idle": wholeDays(row.LastUse, now),
			},
			Text: map[string]string{"material": row.MaterialTypeName},
		})
	}
	return items, nil
}

func (d *Dispatcher) loadOrders(ctx context.Context, q *store, now time.Time) ([]Item, error) {
	rows, err := q.LoadOrderItems(ctx, maxLoopItems)
	if err != nil {
		return nil, err
	}
	items := make([]Item, 0, len(rows))
	for _, row := range rows {
		status := row.Status
		if row.Status == "finalized" {
			status = "paid"
			if row.Outstanding > 0.004 {
				status = "open"
			}
		}
		kind := ""
		switch {
		case row.CustomerPersonID != nil:
			kind = "person"
		case row.CustomerOrganizationID != nil:
			kind = "organization"
		}
		outstanding := math.Max(row.Outstanding, 0)
		if status != "open" {
			outstanding = 0
		}
		var creator *uuid.UUID
		if row.CreatorPersonID != uuid.Nil {
			creator = &row.CreatorPersonID
		}
		item := Item{
			Key: row.ID.String(), Name: row.Reference,
			Fields: map[string]any{
				"number": row.Reference, "customerType": kind, "amount": row.Amount, "outstanding": outstanding,
				"daysOpen": wholeDays(row.Since, now), "status": status, "invoice": row.Invoice,
			},
			Recipients:    map[string][]uuid.UUID{"customer": uuidPtrList(row.CustomerPersonID), "creator": uuidPtrList(creator)},
			Organizations: map[string][]uuid.UUID{"customer": uuidPtrList(row.CustomerOrganizationID)},
		}
		items = append(items, item)
	}
	return items, nil
}

func (d *Dispatcher) loadJobs(ctx context.Context, q *store, now time.Time) ([]Item, error) {
	rows, err := q.LoadJobItems(ctx, maxLoopItems)
	if err != nil {
		return nil, err
	}
	items := make([]Item, 0, len(rows))
	for _, row := range rows {
		status := "needs_outcome"
		outcome := row.DerivedOutcome
		if row.OutcomeOverride != nil && *row.OutcomeOverride != "" {
			outcome = *row.OutcomeOverride
		}
		switch {
		case row.Running:
			status = "running"
		case row.RunCount == 0:
			status = "planned"
		case slices.Contains([]string{"successful", "partial_failure", "failed", "cancelled"}, outcome):
			status = outcome
		}
		name := row.Title
		if name == "" {
			name = row.DisplayID
		}
		items = append(items, Item{
			Key: row.ID.String(), Name: name,
			Fields: map[string]any{
				"name": name, "status": status, "pricing": row.PricingStatus, "waiting": wholeDays(row.Since, now),
				"machine": row.MachineID.String(), "onOrder": row.OnOrder,
			},
			Text:          map[string]string{"machine": row.MachineName},
			Recipients:    map[string][]uuid.UUID{"operator": uuidPtrList(row.OperatorPersonID), "recipient": uuidPtrList(row.CustomerPersonID)},
			Organizations: map[string][]uuid.UUID{"recipient": uuidPtrList(row.CustomerOrganizationID)},
		})
	}
	return items, nil
}

func (d *Dispatcher) loadArticles(ctx context.Context, q *store) ([]Item, error) {
	rows, err := q.LoadArticleItems(ctx, maxLoopItems)
	if err != nil {
		return nil, err
	}
	items := make([]Item, 0, len(rows))
	for _, row := range rows {
		items = append(items, Item{
			Key: row.ID.String(), Name: row.Name,
			Fields: map[string]any{
				"name": row.Name, "category": row.MaterialTypeID.String(), "stock": row.Stock, "minimum": row.Minimum,
				"location": row.Location,
			},
			Text: map[string]string{"category": row.MaterialTypeName},
		})
	}
	return items, nil
}

func (d *Dispatcher) loadTrainings(ctx context.Context, q *store, now time.Time) ([]Item, error) {
	rows, err := q.LoadTrainingItems(ctx, maxLoopItems)
	if err != nil {
		return nil, err
	}
	trainerRows, err := q.ListTrainersOfTrainings(ctx)
	if err != nil {
		return nil, err
	}
	trainers := map[uuid.UUID][]uuid.UUID{}
	for _, row := range trainerRows {
		trainers[row.TrainingID] = append(trainers[row.TrainingID], row.PersonID)
	}
	items := make([]Item, 0, len(rows))
	for _, row := range rows {
		person := personName(row.FirstName, row.LastName)
		fields := map[string]any{
			"person": person, "training": row.TrainingID.String(), "status": row.Status, "completedAgo": float64(0),
		}
		if row.CompletedOn.Valid {
			fields["completedAgo"] = wholeDays(row.CompletedOn.Time, now)
		}
		items = append(items, Item{
			Key: row.PersonID.String() + ":" + row.TrainingID.String(), Name: person + " · " + row.TrainingName,
			Fields:     fields,
			Text:       map[string]string{"training": row.TrainingName},
			Recipients: map[string][]uuid.UUID{"item": {row.PersonID}, "trainers": dedupePeople(trainers[row.TrainingID])},
		})
	}
	return items, nil
}
