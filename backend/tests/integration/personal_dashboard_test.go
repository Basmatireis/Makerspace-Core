package integration_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/dashboard"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	"github.com/google/uuid"
)

// shift creates an event with one shift and one assignment of the person; it returns the event id.
func (e *staffingEnv) shift(
	eventName string,
	public bool,
	status string,
	startsAt time.Time,
	length time.Duration,
	p authorization.Principal,
	assignmentStatus string,
) uuid.UUID {
	e.t.Helper()
	eventID, shiftID, requirementID := ids.New(), ids.New(), ids.New()
	publicID := strings.Repeat("a", 43-len(eventID.String())) + eventID.String()
	e.exec(
		`INSERT INTO events(id,name,public_id,is_public,status) VALUES($1,$2,$3,$4,'confirmed')`,
		eventID, eventName, strings.ReplaceAll(publicID, "-", "_"), public,
	)
	e.exec(
		`INSERT INTO event_shifts(id,event_id,name,starts_at,ends_at,status) VALUES($1,$2,'Door',$3,$4,$5)`,
		shiftID, eventID, startsAt, startsAt.Add(length), status,
	)
	e.exec(
		`INSERT INTO event_shift_requirements(id,event_id,shift_id,name,required_count) VALUES($1,$2,$3,'Host',2)`,
		requirementID, eventID, shiftID,
	)
	e.exec(
		`INSERT INTO event_shift_assignments(
			id,event_id,shift_id,requirement_id,person_id,first_name_snapshot,last_name_snapshot,email_snapshot,
			email_normalized,source,status,cancelled_at)
		VALUES($1,$2,$3,$4,$5,'Test','Person','a@example.test','a@example.test','authenticated_self',$6,
			CASE WHEN $6 = 'cancelled' THEN now() END)`,
		ids.New(), eventID, shiftID, requirementID, p.PersonID, assignmentStatus,
	)
	return eventID
}

func TestPersonalDashboardIsScopedToTheSessionPerson(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("Supervisors", level(roles.MembershipSupervisor), authorization.OpenDaysRead, authorization.OpenDaysSignup)
	alice := e.person("alice", supervisorRole.ID)
	bob := e.person("bob", supervisorRole.ID)
	day := e.openDay(e.now.AddDate(0, 0, 3), 4*time.Hour, 3, 0, supervisorRole.ID)
	e.join(day, day.supervisorRequirement, alice)
	e.shift("Bob's exhibition", true, "open", e.now.AddDate(0, 0, 4), 2*time.Hour, bob, "active")

	aliceView, err := e.dashboard.Get(ctx, alice)
	if err != nil {
		t.Fatal(err)
	}
	bobView, err := e.dashboard.Get(ctx, bob)
	if err != nil {
		t.Fatal(err)
	}
	if len(aliceView.ComingUp) != 1 || aliceView.ComingUp[0].Kind != dashboard.ItemOpenDay {
		t.Fatalf("alice coming up = %+v, want only her open day", aliceView.ComingUp)
	}
	if len(bobView.ComingUp) != 1 || bobView.ComingUp[0].Kind != dashboard.ItemEventShift {
		t.Fatalf("bob coming up = %+v, want only his shift", bobView.ComingUp)
	}
	if aliceView.Staffing == nil || aliceView.Staffing.Counts.Booked != 1 || bobView.Staffing == nil || bobView.Staffing.Counts.Booked != 0 {
		t.Fatalf("staffing counts leak between people: alice=%+v bob=%+v", aliceView.Staffing, bobView.Staffing)
	}
}

func TestPersonalDashboardOmitsSectionsThePrincipalMayNotSee(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("Supervisors", level(roles.MembershipSupervisor), authorization.OpenDaysRead)
	guestRole := e.role("Guests", nil)
	guest := e.person("guest", guestRole.ID)
	staffWithoutOpenDays := e.person("staff-no-open-days", e.role("Staff without open days", level(roles.MembershipTrainee)).ID)
	day := e.openDay(e.now.AddDate(0, 0, 3), 4*time.Hour, 1, 0, supervisorRole.ID)
	supervisor := e.person("supervisor", supervisorRole.ID)
	e.join(day, day.supervisorRequirement, supervisor)
	e.join(day, day.supervisorRequirement, staffWithoutOpenDays)
	e.shift("Guest shift", false, "open", e.now.AddDate(0, 0, 2), time.Hour, guest, "active")

	guestView, err := e.dashboard.Get(ctx, guest)
	if err != nil {
		t.Fatal(err)
	}
	if guestView.Person.FirstName != "Test" || guestView.Staffing != nil || guestView.Statistics != nil {
		t.Fatalf("guest view = %+v, want only person and coming up", guestView)
	}
	if len(guestView.ComingUp) != 1 || guestView.ComingUp[0].Kind != dashboard.ItemEventShift ||
		guestView.ComingUp[0].PublicID != nil || guestView.ComingUp[0].EventID == nil {
		t.Fatalf("guest coming up = %+v, want one internal shift without public id", guestView.ComingUp)
	}

	// Staffing level without open_days.read: no staffing section and no open days, but statistics follow the level.
	noOpenDays, err := e.dashboard.Get(ctx, staffWithoutOpenDays)
	if err != nil {
		t.Fatal(err)
	}
	if noOpenDays.Staffing != nil || len(noOpenDays.ComingUp) != 0 || noOpenDays.Statistics == nil {
		t.Fatalf("staff without open_days.read view = %+v", noOpenDays)
	}

	staffView, err := e.dashboard.Get(ctx, supervisor)
	if err != nil {
		t.Fatal(err)
	}
	if staffView.Staffing == nil || staffView.Statistics == nil || len(staffView.ComingUp) != 1 {
		t.Fatalf("supervisor view = %+v", staffView)
	}
}

func TestPersonalDashboardStaffingNumbersAndNextOpenPlace(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("Supervisors", level(roles.MembershipSupervisor), authorization.OpenDaysRead, authorization.OpenDaysSignup)
	traineeRole := e.role("Trainees", level(roles.MembershipTrainee), authorization.OpenDaysRead, authorization.OpenDaysSignup)
	other := e.role("Other", nil)
	supervisor := e.person("supervisor", supervisorRole.ID)
	trainee := e.person("trainee", traineeRole.ID)
	colleague := e.person("colleague", supervisorRole.ID)
	hour := time.Hour

	e.openDay(e.now.AddDate(0, 0, -7), 4*hour, 1, 1, supervisorRole.ID, traineeRole.ID) // ended, nobody on it
	// Soonest: only supervisor places, but not open to people without the eligible role.
	e.openDay(e.now.Add(26*hour), 4*hour, 1, 1, other.ID)
	// Soonest eligible: full supervisor place, free trainee place.
	fullSupervisors := e.openDay(e.now.AddDate(0, 0, 2), 4*hour, 1, 2, supervisorRole.ID, traineeRole.ID)
	e.join(fullSupervisors, fullSupervisors.supervisorRequirement, colleague)
	// Free places of both kinds.
	free := e.openDay(e.now.AddDate(0, 0, 4), 4*hour, 2, 1, supervisorRole.ID, traineeRole.ID)
	e.join(free, free.supervisorRequirement, colleague)
	// Beyond the 14 day window.
	e.openDay(e.now.AddDate(0, 0, 20), 4*hour, 5, 5, supervisorRole.ID, traineeRole.ID)

	supervisorView, err := e.dashboard.Get(ctx, supervisor)
	if err != nil {
		t.Fatal(err)
	}
	section := supervisorView.Staffing
	if section == nil || section.Kind != roles.MembershipSupervisor || section.Semester == nil || section.Semester.ID != e.period ||
		section.Minimum.Value != 2 || section.TraineeThreshold != 3 || section.Standing.Status != staffing.StatusMissing ||
		section.Standing.Missing != 2 {
		t.Fatalf("supervisor staffing = %+v", section)
	}
	if section.NextOpenPlace == nil || section.NextOpenPlace.OpenDayID != free.id ||
		section.NextOpenPlace.RequirementID != free.supervisorRequirement || section.NextOpenPlace.FreePlaces != 1 ||
		section.NextOpenPlace.PeriodID != e.period {
		t.Fatalf("supervisor next open place = %+v, want the supervisor place of the day with room", section.NextOpenPlace)
	}

	traineeView, err := e.dashboard.Get(ctx, trainee)
	if err != nil {
		t.Fatal(err)
	}
	if traineeView.Staffing == nil || traineeView.Staffing.Kind != roles.MembershipTrainee ||
		traineeView.Staffing.NextOpenPlace == nil || traineeView.Staffing.NextOpenPlace.OpenDayID != fullSupervisors.id ||
		traineeView.Staffing.NextOpenPlace.RequirementID != fullSupervisors.traineeRequirement ||
		traineeView.Staffing.NextOpenPlace.FreePlaces != 2 {
		t.Fatalf("trainee next open place = %+v", traineeView.Staffing)
	}

	// Once the supervisor joins the day, it is no longer offered and is reported as the next open day.
	e.join(free, free.supervisorRequirement, supervisor)
	again, err := e.dashboard.Get(ctx, supervisor)
	if err != nil {
		t.Fatal(err)
	}
	if again.Staffing.NextOpenPlace != nil {
		t.Fatalf("next open place after joining = %+v, want none (only full or joined days left)", again.Staffing.NextOpenPlace)
	}
	if again.Staffing.Counts.Booked != 1 || again.Staffing.NextOpenDay == nil || again.Staffing.NextOpenDay.OpenDayID != free.id ||
		again.Staffing.NextOpenDay.ShortStaffed {
		t.Fatalf("after joining: %+v", again.Staffing)
	}
}

func TestPersonalDashboardComingUpMergesOpenDaysAndShiftsChronologically(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("Supervisors", level(roles.MembershipSupervisor), authorization.OpenDaysRead)
	person := e.person("busy", supervisorRole.ID)
	hour := time.Hour

	day := e.openDay(e.now.AddDate(0, 0, 3), 4*hour, 2, 1, supervisorRole.ID) // one supervisor place still open
	e.join(day, day.supervisorRequirement, person)
	e.openDay(e.now.AddDate(0, 0, 1), 4*hour, 1, 0, supervisorRole.ID) // not joined
	earlyEvent := e.shift("Early event", true, "open", e.now.AddDate(0, 0, 2), 2*hour, person, "active")
	e.shift("Late event", false, "closed", e.now.AddDate(0, 0, 9), 2*hour, person, "active")
	e.shift("Cancelled shift", true, "cancelled", e.now.AddDate(0, 0, 5), 2*hour, person, "active")
	e.shift("Cancelled assignment", true, "open", e.now.AddDate(0, 0, 6), 2*hour, person, "cancelled")
	e.shift("Ended event", true, "open", e.now.AddDate(0, 0, -3), 2*hour, person, "active")
	endedDay := e.openDay(e.now.AddDate(0, 0, -4), 4*hour, 1, 0, supervisorRole.ID)
	e.join(endedDay, endedDay.supervisorRequirement, person)

	view, err := e.dashboard.Get(ctx, person)
	if err != nil {
		t.Fatal(err)
	}
	kinds := make([]dashboard.ItemKind, 0, len(view.ComingUp))
	for _, item := range view.ComingUp {
		kinds = append(kinds, item.Kind)
	}
	want := []dashboard.ItemKind{dashboard.ItemEventShift, dashboard.ItemOpenDay, dashboard.ItemEventShift}
	if len(kinds) != len(want) || kinds[0] != want[0] || kinds[1] != want[1] || kinds[2] != want[2] {
		t.Fatalf("coming up kinds = %v, want %v", kinds, want)
	}
	early := view.ComingUp[0]
	if early.Title != "Early event – Door" || early.EventID == nil || *early.EventID != earlyEvent ||
		early.PublicID == nil || len(*early.PublicID) != 43 {
		t.Fatalf("early shift = %+v", early)
	}
	if view.ComingUp[2].PublicID != nil || early.PeriodID != nil {
		t.Fatal("an internal event leaked its public id")
	}
	openDay := view.ComingUp[1]
	if openDay.Title != "Current semester" || openDay.OpenDayID == nil || *openDay.OpenDayID != day.id ||
		openDay.PeriodID == nil || *openDay.PeriodID != e.period || openDay.ShortStaffed == nil || !*openDay.ShortStaffed {
		t.Fatalf("open day item = %+v, want short-staffed open day", openDay)
	}
	if view.Staffing.NextOpenDay == nil || !view.Staffing.NextOpenDay.ShortStaffed || view.Staffing.NextOpenDay.OpenSupervisorPlaces != 1 {
		t.Fatalf("next open day = %+v", view.Staffing.NextOpenDay)
	}
}

func TestPersonalDashboardStatisticsUseScheduledDurationsOfEndedAssignments(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	supervisorRole := e.role("Supervisors", level(roles.MembershipSupervisor), authorization.OpenDaysRead)
	person := e.person("statistics", supervisorRole.ID)
	hour := time.Hour

	for index, length := range []time.Duration{4 * hour, 3*hour + 30*time.Minute} {
		day := e.openDay(e.now.AddDate(0, 0, -10-index), length, 1, 0, supervisorRole.ID)
		e.join(day, day.supervisorRequirement, person)
	}
	upcoming := e.openDay(e.now.AddDate(0, 0, 3), 5*hour, 1, 0, supervisorRole.ID)
	e.join(upcoming, upcoming.supervisorRequirement, person)
	cancelled := e.openDay(e.now.AddDate(0, 0, -2), 5*hour, 1, 0, supervisorRole.ID)
	e.exec(`UPDATE open_days SET status='cancelled' WHERE id=$1`, cancelled.id)
	e.join(cancelled, cancelled.supervisorRequirement, person)
	e.shift("Past event", true, "open", e.now.AddDate(0, 0, -5), 90*time.Minute, person, "active")
	e.shift("Past cancelled assignment", true, "open", e.now.AddDate(0, 0, -6), 5*hour, person, "cancelled")
	e.shift("Upcoming event", true, "open", e.now.AddDate(0, 0, 5), 5*hour, person, "active")

	view, err := e.dashboard.Get(ctx, person)
	if err != nil {
		t.Fatal(err)
	}
	statistics := view.Statistics
	if statistics == nil || statistics.OpenDaysStaffed != 2 || statistics.OpenDayHours != 7.5 ||
		statistics.EventShifts != 1 || statistics.EventShiftHours != 1.5 || statistics.MemberSince.IsZero() {
		t.Fatalf("statistics = %+v, want 2 open days / 7.5 h and 1 shift / 1.5 h", statistics)
	}
	// The latest ended assignment is the shift five days ago; the cancelled open day after it does not count.
	if statistics.LastStaffedAt == nil || statistics.LastStaffedAt.Sub(e.now.AddDate(0, 0, -5)).Abs() > time.Millisecond {
		t.Fatalf("last staffed = %v, want the start of the past shift %v", statistics.LastStaffedAt, e.now.AddDate(0, 0, -5))
	}
	if statistics.Membership == nil || statistics.Membership.Membership != roles.MembershipSupervisor ||
		statistics.Membership.Since.IsZero() {
		t.Fatalf("membership = %+v, want supervisor with its assignment time", statistics.Membership)
	}

	// Before the first ended assignment there is no last time.
	fresh, err := e.dashboard.Get(ctx, e.person("fresh", supervisorRole.ID))
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Statistics == nil || fresh.Statistics.LastStaffedAt != nil {
		t.Fatalf("fresh statistics = %+v, want no last staffed time", fresh.Statistics)
	}
}

// TestPersonalDashboardJobStatisticsRankMachinesAndMaterials covers the job tiles: failed jobs, machine time per
// machine and material use per material type, all from the person's own jobs only.
func TestPersonalDashboardJobStatisticsRankMachinesAndMaterials(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	memberRole := e.role("Members", level(roles.MembershipSupervisor), authorization.MachineJobsRead)
	maker := e.person("maker", memberRole.ID)
	other := e.person("other-maker", memberRole.ID)
	tag := strings.ToUpper(strings.ReplaceAll(ids.New().String(), "-", "")[20:28])

	process := ids.New()
	e.exec(`INSERT INTO processes (id, name, integration) VALUES ($1, $2, 'none')`, process, "Dashboard process "+tag)
	printer, laser := ids.New(), ids.New()
	e.exec(`INSERT INTO machines (id, process_id, name) VALUES ($1, $3, $4), ($2, $3, $5)`,
		printer, laser, process, "Printer "+tag, "Laser "+tag)
	pla, plywood := ids.New(), ids.New()
	e.exec(`INSERT INTO material_types (id, name, unit, kind, code, machine_use) VALUES
		($1, $3, 'g', 'filament', $4, true), ($2, $5, 'm2', 'consumable', $6, true)`,
		pla, plywood, "PLA "+tag, "P"+tag, "Plywood "+tag, "W"+tag)
	red, sheet := ids.New(), ids.New()
	e.exec(`INSERT INTO materials (id, display_id, name, unit, material_type_id) VALUES
		($1, 'A-' || (900000000 + floor(random() * 99999999))::bigint, $3, 'g', $4),
		($2, 'A-' || (900000000 + floor(random() * 99999999))::bigint, $5, 'm2', $6)`,
		red, sheet, "PLA red "+tag, pla, "Plywood sheet "+tag, plywood)

	jobCounter := 0
	job := func(customer authorization.Principal, machine uuid.UUID, length time.Duration, outcome string) uuid.UUID {
		t.Helper()
		jobCounter++
		id, run := ids.New(), ids.New()
		random := ids.New() // UUIDv7: the last bytes are random
		number := 900000000 + (int(random[12])<<16|int(random[13])<<8|int(random[14]))*4 + jobCounter%4
		e.exec(`INSERT INTO machine_jobs (id, display_id, machine_id, customer_person_id) VALUES ($1, $2, $3, $4)`,
			id, fmt.Sprintf("J-2031-%d", number), machine, customer.PersonID)
		started := e.now.AddDate(0, 0, -jobCounter)
		e.exec(`INSERT INTO machine_runs (id, display_id, machine_id, source, job_id, started_at, ended_at, outcome)
			VALUES ($1, $2, $3, 'manual', $4, $5, $6, $7)`,
			run, fmt.Sprintf("R-2031-%d", number), machine, id, started, started.Add(length), outcome)
		return run
	}
	usage := func(run, material uuid.UUID, quantity string, unit any, active bool) {
		t.Helper()
		e.exec(`INSERT INTO machine_run_usages (id, run_id, material_id, quantity, material_unit, active)
			VALUES ($1, $2, $3, $4::numeric, $5, $6)`, ids.New(), run, material, quantity, unit, active)
	}

	first := job(maker, printer, 2*time.Hour, "successful")
	usage(first, red, "100", nil, true)
	usage(first, red, "500", nil, false) // inactive usage never counts
	second := job(maker, printer, time.Hour, "failed")
	usage(second, red, "0.05", "kg", true)
	third := job(maker, laser, 30*time.Minute, "partial_failure")
	usage(third, sheet, "0.5", nil, true)
	// Another person's long job on the laser with lots of material stays theirs.
	foreign := job(other, laser, 10*time.Hour, "successful")
	usage(foreign, red, "1000", nil, true)

	view, err := e.dashboard.Get(ctx, maker)
	if err != nil {
		t.Fatal(err)
	}
	if view.Statistics == nil || view.Statistics.Jobs == nil {
		t.Fatalf("statistics = %+v, want job statistics", view.Statistics)
	}
	jobs := view.Statistics.Jobs
	if jobs.Jobs != 3 || jobs.SuccessfulJobs != 1 || jobs.FailedJobs != 2 || jobs.FinishedJobs != 3 ||
		jobs.MaterialGrams != 150 || jobs.MachineSeconds != int64((3*time.Hour+30*time.Minute)/time.Second) {
		t.Fatalf("job totals = %+v", jobs)
	}
	if len(jobs.Machines) != 2 ||
		jobs.Machines[0].Name != "Printer "+tag || jobs.Machines[0].MachineSeconds != 3*3600 || jobs.Machines[0].Jobs != 2 ||
		jobs.Machines[1].Name != "Laser "+tag || jobs.Machines[1].MachineSeconds != 1800 || jobs.Machines[1].Jobs != 1 {
		t.Fatalf("machines = %+v, want the printer (3 h, 2 jobs) before the laser (30 min, 1 job)", jobs.Machines)
	}
	if len(jobs.Materials) != 2 ||
		jobs.Materials[0].Name != "PLA "+tag || jobs.Materials[0].Dimension != "mass" || jobs.Materials[0].Amount != 150 ||
		jobs.Materials[0].Jobs != 2 ||
		jobs.Materials[1].Name != "Plywood "+tag || jobs.Materials[1].Dimension != "area" || jobs.Materials[1].Amount != 5000 ||
		jobs.Materials[1].Jobs != 1 {
		t.Fatalf("materials = %+v, want PLA 150 g in 2 jobs before plywood 5000 cm2 in 1 job", jobs.Materials)
	}

	// Without jobs the lists are empty, not missing.
	empty, err := e.dashboard.Get(ctx, e.person("no-jobs", memberRole.ID))
	if err != nil {
		t.Fatal(err)
	}
	if empty.Statistics.Jobs == nil || empty.Statistics.Jobs.Machines == nil || len(empty.Statistics.Jobs.Machines) != 0 ||
		empty.Statistics.Jobs.Materials == nil || len(empty.Statistics.Jobs.Materials) != 0 || empty.Statistics.Jobs.FailedJobs != 0 {
		t.Fatalf("empty job statistics = %+v", empty.Statistics.Jobs)
	}
}

func TestPersonalDashboardFinanceSectionsFollowPermissions(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	treasurer := e.person("treasurer", e.role("Order readers", nil, authorization.OrdersRead).ID)
	operator := e.person("operator", e.role("Job readers", nil, authorization.MachineJobsRead).ID)
	member := e.person("member", e.role("Members", level(roles.MembershipSupervisor), authorization.MachineJobsRead).ID)
	guest := e.person("finance-guest", e.role("Finance guests", nil).ID)

	view, err := e.dashboard.Get(ctx, treasurer)
	if err != nil {
		t.Fatal(err)
	}
	// D3: the balance is shown also when nothing is owed.
	if view.Balance == nil || view.Balance.Total != "0.00" || view.Balance.UnpaidOrdersTotal != "0.00" ||
		view.Balance.UnbilledJobsTotal != "0.00" || view.RecentOrders == nil || view.RecentJobs != nil {
		t.Fatalf("orders.read view = %+v", view)
	}
	view, err = e.dashboard.Get(ctx, operator)
	if err != nil {
		t.Fatal(err)
	}
	if view.Balance != nil || view.RecentOrders != nil || view.RecentJobs == nil || view.Statistics != nil {
		t.Fatalf("machine_jobs.read view = %+v", view)
	}
	view, err = e.dashboard.Get(ctx, member)
	if err != nil {
		t.Fatal(err)
	}
	if view.Statistics == nil || view.Statistics.Jobs == nil || len(view.Statistics.Jobs.JobsPerMonth) != 12 ||
		view.Balance != nil {
		t.Fatalf("member view = %+v", view)
	}
	view, err = e.dashboard.Get(ctx, guest)
	if err != nil {
		t.Fatal(err)
	}
	if view.Balance != nil || view.RecentOrders != nil || view.RecentJobs != nil || view.Statistics != nil {
		t.Fatalf("guest view = %+v", view)
	}
}
