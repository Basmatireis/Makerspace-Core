package machinelogbook

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// restrictedPrincipal is a non-master account holding exactly the given permissions.
func restrictedPrincipal(
	t *testing.T,
	pool *pgxpool.Pool,
	permissions ...authorization.Permission,
) authorization.Principal {
	t.Helper()
	ctx := t.Context()
	person, account, role := ids.New(), ids.New(), ids.New()
	for _, step := range []struct {
		sql  string
		args []any
	}{
		{
			"INSERT INTO people(id,first_name,last_name,email) VALUES($1,'Restricted','Reader',$2)",
			[]any{person, "restricted-" + person.String() + "@example.test"},
		},
		{"INSERT INTO accounts(id,person_id,status) VALUES($1,$2,'enabled')", []any{account, person}},
		{"INSERT INTO roles(id,name) VALUES($1,$2)", []any{role, "restricted-" + role.String()}},
		{"INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)", []any{person, role}},
	} {
		if _, err := pool.Exec(ctx, step.sql, step.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = pool.Exec(cleanup, `DELETE FROM role_permission_grants WHERE role_id = $1`, role)
		_, _ = pool.Exec(cleanup, `DELETE FROM person_roles WHERE role_id = $1`, role)
		_, _ = pool.Exec(cleanup, `DELETE FROM roles WHERE id = $1`, role)
		_, _ = pool.Exec(cleanup, `DELETE FROM accounts WHERE id = $1`, account)
		_, _ = pool.Exec(cleanup, `DELETE FROM people WHERE id = $1`, person)
	})
	for _, permission := range permissions {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES($1,$2,$3)`,
			ids.New(),
			role,
			string(permission),
		); err != nil {
			t.Fatal(err)
		}
	}
	p, err := authorization.LoadPermissionsFrom(
		ctx,
		pool,
		authorization.Principal{AccountID: account, PersonID: person},
	)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

type workItemFixture struct {
	*runHarness
	running, needsOutcome, recorded, linked, noPrice MachineJob
	linkedRun, printing, ended                       uuid.UUID
}

func newWorkItemFixture(t *testing.T) *workItemFixture {
	t.Helper()
	h := newLiveRunHarness(t)
	w := &workItemFixture{runHarness: h}
	gearUnderscore, gearPlain := "Gear_100%", "Gear1100x"

	running := h.input(-time.Hour, 3*time.Hour, "unknown")
	running.Title = &gearPlain
	w.running = h.create(t, running)
	needs := h.input(-5*time.Hour, time.Hour, "unknown")
	w.needsOutcome = h.create(t, needs)
	recorded := h.input(-10*time.Hour, time.Hour, "successful")
	recorded.Title = &gearUnderscore
	recorded.Usages = []UsageInput{{MaterialID: h.jobFixture.material.ID, Quantity: "30"}}
	w.recorded = h.create(t, recorded)

	w.linkedRun = h.insertRun(
		t,
		runSpec{
			machine:  h.machine.ID,
			started:  at(h.now, -20*time.Hour),
			ended:    at(h.now, -19*time.Hour),
			fileName: "benchy.gcode",
		},
	)
	h.finish(t, w.linkedRun, "finished", *at(h.now, -19*time.Hour))
	manual := h.input(-30*time.Hour, time.Hour, "unknown")
	w.linked = h.attach(t, w.linkedRun, h.create(t, manual), true)
	if _, err := h.s.UpdateRun(
		t.Context(),
		h.p,
		w.linkedRun,
		h.run(t, w.linkedRun).Version,
		RunUpdate{Outcome: outcomePtr("successful")},
		&h.request,
	); err != nil {
		t.Fatal(err)
	}
	w.linked, _ = h.s.GetJob(t.Context(), h.p, w.linked.ID)

	noPrice := h.input(-12*time.Hour, time.Hour, "successful")
	noPrice.MachineID = h.bareMachine.ID
	w.noPrice = h.create(t, noPrice)

	percent := 40
	w.printing = h.insertRun(
		t,
		runSpec{
			machine:  h.bareMachine.ID,
			state:    "running",
			started:  at(h.now, -30*time.Minute),
			fileName: "vase.gcode",
			percent:  &percent,
		},
	)
	w.ended = h.insertRun(
		t,
		runSpec{
			machine:  h.bareMachine.ID,
			started:  at(h.now, -6*time.Hour),
			ended:    at(h.now, -5*time.Hour),
			fileName: "lid.gcode",
			grams:    "10",
			basis:    "actual",
			spool:    &h.spool.ID,
		},
	)
	h.finish(t, w.ended, "finished", *at(h.now, -5*time.Hour))
	return w
}

func (w *workItemFixture) list(t *testing.T, filters WorkItemFilters) ([]WorkItem, int64) {
	t.Helper()
	if filters.MachineIDs == nil {
		filters.MachineIDs = []uuid.UUID{w.machine.ID, w.bareMachine.ID}
	}
	if filters.Page == 0 {
		filters.Page, filters.PageSize = 1, 100
	}
	items, total, err := w.s.ListWorkItems(t.Context(), w.p, filters)
	if err != nil {
		t.Fatal(err)
	}
	return items, total
}

func idsOf(items []WorkItem) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	return ids
}

func sameIDs(t *testing.T, label string, items []WorkItem, want ...uuid.UUID) {
	t.Helper()
	got := idsOf(items)
	slices.SortFunc(got, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	slices.SortFunc(want, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	if !slices.Equal(got, want) {
		t.Fatalf("%s: got %d items %v, want %v", label, len(got), got, want)
	}
}

func TestWorkItemsUnifyJobsAndUnassignedRuns(t *testing.T) {
	w := newWorkItemFixture(t)
	items, total := w.list(t, WorkItemFilters{})
	if total != 7 {
		t.Fatalf("total = %d", total)
	}
	sameIDs(
		t,
		"all",
		items,
		w.running.ID,
		w.needsOutcome.ID,
		w.recorded.ID,
		w.linked.ID,
		w.noPrice.ID,
		w.printing,
		w.ended,
	)
	byID := map[uuid.UUID]WorkItem{}
	for _, item := range items {
		byID[item.ID] = item
	}
	if _, listed := byID[w.linkedRun]; listed {
		t.Fatal("a run assigned to a job must only appear through the job")
	}
	type expectation struct {
		kind   WorkItemKind
		status WorkItemStatus
		source RunSource
	}
	for id, want := range map[uuid.UUID]expectation{
		w.running.ID: {"job", "running", "manual"}, w.needsOutcome.ID: {
			"job",
			"needs_outcome",
			"manual",
		}, w.recorded.ID: {"job", "successful", "manual"},
		w.linked.ID: {"job", "successful", "recorded"}, w.noPrice.ID: {"job", "successful", "manual"}, w.printing: {
			"run",
			"running_unassigned",
			"recorded",
		}, w.ended: {"run", "unassigned", "recorded"},
	} {
		got := byID[id]
		if got.Kind != want.kind || got.Status != want.status || got.Source != want.source {
			t.Fatalf("%s = %s/%s/%s, want %+v", id, got.Kind, got.Status, got.Source, want)
		}
	}
	linked := byID[w.linked.ID]
	if linked.RunCount != 1 || linked.FileName == nil || *linked.FileName != "benchy.gcode" {
		t.Fatalf("linked job run data = %+v", linked)
	}
	printing := byID[w.printing]
	if printing.ProgressPercent == nil || *printing.ProgressPercent != 40 || printing.Customer != nil ||
		printing.Operator != nil ||
		printing.Billing != nil ||
		printing.EffectivePrice != nil ||
		printing.Title != nil {
		t.Fatalf("printing print = %+v", printing)
	}
	if ended := byID[w.ended]; ended.EndsAt == nil || ended.Billing != nil {
		t.Fatalf("ended print = %+v", ended)
	}
	job := byID[w.recorded.ID]
	if job.Customer == nil || job.Customer.ID != w.person || job.Operator == nil || job.Operator.PersonID != w.person ||
		job.EffectivePrice == nil ||
		job.Billing == nil {
		t.Fatalf("job = %+v", job)
	}
	if job.Billing.State != "not_on_order" || job.Billing.OrderID != nil {
		t.Fatalf("recorded billing = %+v", job.Billing)
	}
	if got := byID[w.noPrice.ID].Billing; got == nil || got.State != "price_incomplete" ||
		byID[w.noPrice.ID].EffectivePrice != nil {
		t.Fatalf("incomplete billing = %+v", got)
	}
}

func TestWorkItemFilters(t *testing.T) {
	w := newWorkItemFixture(t)
	only := func(label string, filters WorkItemFilters, want ...uuid.UUID) {
		t.Helper()
		items, total := w.list(t, filters)
		if total != int64(len(want)) {
			t.Fatalf("%s: total = %d, want %d", label, total, len(want))
		}
		sameIDs(t, label, items, want...)
	}
	only("status", WorkItemFilters{Statuses: []WorkItemStatus{"running", "running_unassigned"}}, w.running.ID, w.printing)
	only("status unlinked", WorkItemFilters{Statuses: []WorkItemStatus{"unassigned"}}, w.ended)
	only("status needs_outcome", WorkItemFilters{Statuses: []WorkItemStatus{"needs_outcome", "cancelled"}}, w.needsOutcome.ID)
	only("machine", WorkItemFilters{MachineIDs: []uuid.UUID{w.bareMachine.ID}}, w.noPrice.ID, w.printing, w.ended)
	only(
		"source manual",
		WorkItemFilters{Sources: []RunSource{"manual"}},
		w.running.ID,
		w.needsOutcome.ID,
		w.recorded.ID,
		w.noPrice.ID,
	)
	only("source recorded", WorkItemFilters{Sources: []RunSource{"recorded"}}, w.linked.ID, w.printing, w.ended)
	only("job material", WorkItemFilters{MaterialIDs: []uuid.UUID{w.jobFixture.material.ID}}, w.recorded.ID)
	only("print material", WorkItemFilters{MaterialIDs: []uuid.UUID{w.material.ID}}, w.ended)
	only("billing excludes prints", WorkItemFilters{Billing: []BillingState{"price_incomplete"}}, w.noPrice.ID)
	only("billing none match", WorkItemFilters{Billing: []BillingState{"on_order", "order_outdated"}})
	only(
		"customer excludes prints",
		WorkItemFilters{CustomerID: &w.person, Statuses: []WorkItemStatus{"successful"}},
		w.recorded.ID,
		w.linked.ID,
		w.noPrice.ID,
	)
	only(
		"operator",
		WorkItemFilters{OperatorID: &w.person, Statuses: []WorkItemStatus{"unassigned", "running_unassigned", "running"}},
		w.running.ID,
	)
	stranger := ids.New()
	only("unknown customer", WorkItemFilters{CustomerID: &stranger})

	from, to := *w.recorded.StartedAt, *w.running.StartedAt
	only(
		"from inclusive to exclusive",
		WorkItemFilters{From: &from, To: &to},
		w.recorded.ID,
		w.needsOutcome.ID,
		w.ended,
	)
	only("from is inclusive", WorkItemFilters{From: &to, To: ptr(to.Add(time.Microsecond))}, w.running.ID)
	only("to is exclusive", WorkItemFilters{From: ptr(to.Add(-time.Microsecond)), To: &to})

	only("search title with underscore stays literal", WorkItemFilters{Search: "gear_1"}, w.recorded.ID)
	only("search title with percent stays literal", WorkItemFilters{Search: "100%"}, w.recorded.ID)
	only("search wildcard only", WorkItemFilters{Search: "%"}, w.recorded.ID)
	only("search backslash", WorkItemFilters{Search: `\`})
	only("search file name", WorkItemFilters{Search: "BENCHY"}, w.linked.ID)
	only("search unlinked file name", WorkItemFilters{Search: "vase"}, w.printing)
	only("search job display id", WorkItemFilters{Search: w.needsOutcome.DisplayID}, w.needsOutcome.ID)
	only(
		"search run display id of a job",
		WorkItemFilters{Search: w.linked.Runs[len(w.linked.Runs)-1].DisplayID},
		w.linked.ID,
	)
	only("search unassigned run display id", WorkItemFilters{Search: w.printingDisplayID(t)}, w.printing)
}

// searchPeopleAndJobs adds two people, an organization and two jobs whose
// searchable fields (recipient, operator, notes) are unique to them.
func (w *workItemFixture) searchPeopleAndJobs(t *testing.T) (personJob, orgJob MachineJob, token string) {
	t.Helper()
	ctx := t.Context()
	token = strings.ReplaceAll(ids.New().String(), "-", "")[:8]
	grace, ada := ids.New(), ids.New()
	for _, person := range []struct {
		id          uuid.UUID
		first, last string
	}{{grace, "Grace", "Hopper" + token}, {ada, "Ada", "Lovelace" + token}} {
		if _, err := w.pool.Exec(
			ctx,
			`INSERT INTO people (id, first_name, last_name, email) VALUES ($1, $2, $3, $4)`,
			person.id, person.first, person.last, person.first+"-"+token+"@example.test",
		); err != nil {
			t.Fatal(err)
		}
	}
	adaAccount := ids.New()
	if _, err := w.pool.Exec(
		ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, adaAccount, ada,
	); err != nil {
		t.Fatal(err)
	}
	org, err := w.s.CreateOrganization(
		ctx, w.p, "Zenith Robotics "+token, OrganizationCompany, OrganizationDetailsInput{}, &w.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = w.pool.Exec(cleanup, `DELETE FROM machine_runs WHERE job_id IN (SELECT id FROM machine_jobs WHERE customer_person_id = $1 OR operator_person_id = $2)`, grace, ada)
		_, _ = w.pool.Exec(cleanup, `DELETE FROM machine_jobs WHERE customer_person_id = $1 OR operator_person_id = $2 OR customer_organization_id = $3`, grace, ada, org.ID)
		_, _ = w.pool.Exec(cleanup, `DELETE FROM organizations WHERE id = $1`, org.ID)
		_, _ = w.pool.Exec(cleanup, `DELETE FROM accounts WHERE id = $1`, adaAccount)
		_, _ = w.pool.Exec(cleanup, `DELETE FROM people WHERE id IN ($1, $2)`, grace, ada)
	})
	notes := "needs sanding" + token + " afterwards"
	person := w.input(-40*time.Hour, time.Hour, "successful")
	person.Customer = PartyReference{Kind: "person", ID: grace}
	person.Notes = &notes
	personJob = w.create(t, person)
	organization := w.input(-45*time.Hour, time.Hour, "successful")
	organization.Customer = PartyReference{Kind: "organization", ID: org.ID}
	organization.OperatorPersonID = ada
	orgJob = w.create(t, organization)
	return personJob, orgJob, token
}

func TestWorkItemSearchCoversWhatTheTableShows(t *testing.T) {
	w := newWorkItemFixture(t)
	personJob, orgJob, token := w.searchPeopleAndJobs(t)
	only := func(label, search string, want ...uuid.UUID) {
		t.Helper()
		items, total := w.list(t, WorkItemFilters{Search: search})
		if total != int64(len(want)) {
			t.Fatalf("%s: total = %d, want %d (%v)", label, total, len(want), idsOf(items))
		}
		sameIDs(t, label, items, want...)
	}
	only("recipient first and last name, partial and lower-case", "grace hopper"+strings.ToLower(token[:4]), personJob.ID)
	only("recipient last name", "HOPPER"+token, personJob.ID)
	only("organization recipient", "zenith robotics "+token, orgJob.ID)
	only("operator name", "ada lovelace"+token, orgJob.ID)
	only("job notes", "SANDING"+token, personJob.ID)
	only("machine name of prints", "jobs bare machine", w.noPrice.ID, w.printing, w.ended)
	only("job display id", orgJob.DisplayID, orgJob.ID)
	only("nothing matches", "no-such-term-"+token)
}

func TestListJobsSearchFindsTitleNotesAndRunFileNames(t *testing.T) {
	w := newWorkItemFixture(t)
	personJob, _, token := w.searchPeopleAndJobs(t)
	search := func(term string) []uuid.UUID {
		t.Helper()
		jobs, total, err := w.s.ListJobs(t.Context(), w.p, JobFilters{Search: term, Page: 1, PageSize: 50})
		if err != nil {
			t.Fatal(err)
		}
		if total != int64(len(jobs)) {
			t.Fatalf("%q: total %d, page %d", term, total, len(jobs))
		}
		out := make([]uuid.UUID, 0, len(jobs))
		for _, job := range jobs {
			out = append(out, job.ID)
		}
		return out
	}
	for _, c := range []struct {
		label, term string
		want        uuid.UUID
	}{
		{"title", "GEAR1100", w.running.ID},
		{"run file name", "Benchy", w.linked.ID},
		{"notes", "sanding" + token, personJob.ID},
	} {
		if got := search(c.term); len(got) != 1 || got[0] != c.want {
			t.Fatalf("%s: search %q = %v, want [%s]", c.label, c.term, got, c.want)
		}
	}
	if got := search("no-such-term-" + token); len(got) != 0 {
		t.Fatalf("unmatched search = %v", got)
	}
}

func ptr[T any](v T) *T { return &v }

func (w *workItemFixture) printingDisplayID(t *testing.T) string {
	t.Helper()
	var display string
	if err := w.pool.QueryRow(
		t.Context(),
		`SELECT display_id FROM machine_runs WHERE id = $1`,
		w.printing,
	).Scan(&display); err != nil {
		t.Fatal(err)
	}
	return display
}

func TestWorkItemSortingAndPagination(t *testing.T) {
	w := newWorkItemFixture(t)
	order := func(sort string, direction SortDirection) []WorkItem {
		t.Helper()
		items, _ := w.list(t, WorkItemFilters{Sort: sort, Direction: direction})
		return items
	}
	started := order("startedAt", "")
	for i := 1; i < len(started); i++ {
		if started[i-1].StartedAt.Before(started[i].StartedAt) {
			t.Fatalf("default sort is not startedAt desc: %v", started)
		}
	}
	asc := order("startedAt", "asc")
	for i := 1; i < len(asc); i++ {
		if asc[i-1].StartedAt.After(asc[i].StartedAt) {
			t.Fatal("startedAt asc is not ascending")
		}
	}
	key := func(item WorkItem) string {
		switch {
		case item.Title != nil:
			return strings.ToLower(*item.Title)
		case item.FileName != nil:
			return strings.ToLower(*item.FileName)
		}
		return strings.ToLower(item.DisplayID)
	}
	for _, direction := range []SortDirection{SortAsc, SortDesc} {
		names := order("name", direction)
		sorted := slices.IsSortedFunc(names, func(a, b WorkItem) int {
			if direction == "desc" {
				return strings.Compare(key(b), key(a))
			}
			return strings.Compare(key(a), key(b))
		})
		if !sorted {
			t.Fatalf("name %s order wrong", direction)
		}
		machines := order("machine", direction)
		if !slices.IsSortedFunc(machines, func(a, b WorkItem) int {
			if direction == "desc" {
				return strings.Compare(strings.ToLower(b.MachineName), strings.ToLower(a.MachineName))
			}
			return strings.Compare(strings.ToLower(a.MachineName), strings.ToLower(b.MachineName))
		}) {
			t.Fatalf("machine %s order wrong", direction)
		}
		for _, sort := range []string{"price", "customer"} {
			items := order(sort, direction)
			seenNull := false
			for _, item := range items {
				missing := item.EffectivePrice == nil
				if sort == "customer" {
					missing = item.Customer == nil
				}
				if seenNull && !missing {
					t.Fatalf("%s %s: NULLs must sort last: %v", sort, direction, items)
				}
				seenNull = seenNull || missing
			}
			if !seenNull {
				t.Fatalf("%s %s: expected rows without a value", sort, direction)
			}
		}
		prices := order("price", direction)
		var last *string
		for _, item := range prices {
			if item.EffectivePrice == nil {
				continue
			}
			if last != nil {
				a, _ := parseDecimal(*last, false)
				b, _ := parseDecimal(*item.EffectivePrice, false)
				if (direction == "asc" && a.GreaterThan(b)) || (direction == "desc" && a.LessThan(b)) {
					t.Fatalf("price %s order wrong: %s then %s", direction, *last, *item.EffectivePrice)
				}
			}
			last = item.EffectivePrice
		}
	}

	var seen []uuid.UUID
	for page, wantSize := range []int{3, 3, 1} {
		items, total := w.list(t, WorkItemFilters{Page: page + 1, PageSize: 3, Sort: "name", Direction: "asc"})
		if total != 7 || len(items) != wantSize {
			t.Fatalf("page %d: %d items, total %d", page+1, len(items), total)
		}
		seen = append(seen, idsOf(items)...)
	}
	if len(slices.Compact(slices.Clone(seen))) != 7 {
		t.Fatalf("pages overlap: %v", seen)
	}
	items, total := w.list(t, WorkItemFilters{Page: 5, PageSize: 3})
	if len(items) != 0 || total != 7 {
		t.Fatalf("page past the end: %d items, total %d", len(items), total)
	}
	if _, _, err := w.s.ListWorkItems(
		t.Context(),
		w.p,
		WorkItemFilters{Sort: "bogus", Page: 1, PageSize: 10},
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("unknown sort: %v", err)
	}
}

func TestWorkItemsAndActivityRequireTheirPermissions(t *testing.T) {
	w := newWorkItemFixture(t)
	machinesOnly := restrictedPrincipal(t, w.pool, authorization.MachinesRead)
	if _, _, err := w.s.ListWorkItems(
		t.Context(),
		machinesOnly,
		WorkItemFilters{Page: 1, PageSize: 10},
	); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("work items without machine_jobs.read: %v", err)
	}
	jobsOnly := restrictedPrincipal(t, w.pool, authorization.MachineJobsRead)
	if _, err := w.s.MachineActivity(t.Context(), jobsOnly); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("activity without machines.read: %v", err)
	}
	if _, _, err := w.s.ListWorkItems(t.Context(), jobsOnly, WorkItemFilters{Page: 1, PageSize: 10}); err != nil {
		t.Fatal(err)
	}
}

func TestMachineActivityAvailabilityAndConnector(t *testing.T) {
	h := newLiveRunHarness(t)
	ctx := t.Context()
	extra := func(name string, status MachineStatus) Machine {
		t.Helper()
		m, err := h.s.CreateMachine(
			ctx,
			h.p,
			h.machine.MachineType.ID,
			name+" "+h.machine.ID.String()[:8],
			status,
			nil,
			false,
			&h.request,
		)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_, _ = h.pool.Exec(cleanup, `DELETE FROM machine_runs WHERE machine_id = $1`, m.ID)
			_, _ = h.pool.Exec(cleanup, `DELETE FROM machine_jobs WHERE machine_id = $1`, m.ID)
			_, _ = h.pool.Exec(cleanup, `DELETE FROM machines WHERE id = $1`, m.ID)
		})
		return m
	}
	retired, maintenance, future, free := extra(
		"Retired",
		"active",
	), extra(
		"Maintenance",
		"maintenance",
	), extra(
		"Future",
		"active",
	), extra(
		"Free",
		"active",
	)
	// h.machine has a printing print, h.bareMachine a running manual job.
	printID := h.insertRun(
		t,
		runSpec{machine: h.machine.ID, state: "running", started: at(h.now, -time.Hour), fileName: "live.gcode"},
	)
	estimated := h.now.Truncate(time.Second).Add(2 * time.Hour)
	if _, err := h.pool.Exec(
		ctx,
		`UPDATE machine_runs SET estimated_end_at = $2 WHERE id = $1`,
		printID,
		estimated,
	); err != nil {
		t.Fatal(err)
	}
	title := "Running now"
	runningInput := h.input(-time.Hour, 3*time.Hour, "unknown")
	runningInput.MachineID, runningInput.Title = h.bareMachine.ID, &title
	running := h.create(t, runningInput)
	futureInput := h.input(time.Hour, 2*time.Hour, "unknown")
	futureInput.MachineID = future.ID
	h.create(t, futureInput)
	retiredInput := h.input(-time.Hour, 3*time.Hour, "unknown")
	retiredInput.MachineID = retired.ID
	h.create(t, retiredInput)
	// A machine retired while a job is still running stays retired.
	if _, err := h.pool.Exec(ctx, `UPDATE machines SET status = 'retired' WHERE id = $1`, retired.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(
		ctx,
		`UPDATE printer_connector_assignments SET runtime_state = 'degraded', runtime_error_code = 'auth_failed' WHERE id = $1`,
		h.assignments[h.machine.ID],
	); err != nil {
		t.Fatal(err)
	}
	heartbeat := h.now.Truncate(time.Second).Add(-time.Minute)
	if _, err := h.pool.Exec(
		ctx,
		`UPDATE printer_connectors SET last_heartbeat_at = $2 WHERE id = $1`,
		h.connectorID,
		heartbeat,
	); err != nil {
		t.Fatal(err)
	}

	fetch := func(p authorization.Principal) map[uuid.UUID]MachineActivity {
		t.Helper()
		items, err := h.s.MachineActivity(ctx, p)
		if err != nil {
			t.Fatal(err)
		}
		result := map[uuid.UUID]MachineActivity{}
		for _, item := range items {
			result[item.MachineID] = item
		}
		return result
	}
	all := fetch(h.p)
	// A run is running until its planned end, as the job aggregates see it.
	for id, want := range map[uuid.UUID]MachineAvailability{
		h.machine.ID:     "in_use",
		h.bareMachine.ID: "in_use",
		retired.ID:       "retired",
		maintenance.ID:   "maintenance",
		future.ID:        "in_use",
		free.ID:          "available",
	} {
		if got := all[id].Availability; got != want {
			t.Fatalf("machine %s availability = %q, want %q", id, got, want)
		}
	}
	printing := all[h.machine.ID]
	if printing.Current == nil || printing.Current.Kind != "run" || printing.Current.ID != printID ||
		printing.Current.FileName == nil ||
		*printing.Current.FileName != "live.gcode" ||
		printing.Current.EndsAt == nil ||
		!printing.Current.EndsAt.Equal(estimated) {
		t.Fatalf("printing current = %+v", printing.Current)
	}
	if c := printing.Connector; c == nil || c.RuntimeState == nil || *c.RuntimeState != "degraded" ||
		c.RuntimeErrorCode == nil ||
		*c.RuntimeErrorCode != "auth_failed" ||
		c.LastHeartbeatAt == nil ||
		!c.LastHeartbeatAt.Equal(heartbeat) {
		t.Fatalf("connector = %+v", printing.Connector)
	}
	manual := all[h.bareMachine.ID]
	if manual.Current == nil || manual.Current.Kind != "job" || manual.Current.ID != running.ID ||
		manual.Current.Title == nil ||
		*manual.Current.Title != title ||
		manual.Current.EndsAt == nil ||
		!manual.Current.EndsAt.Equal(*running.ExpectedEndAt) {
		t.Fatalf("running job current = %+v", manual.Current)
	}
	if manual.LastJobStartedAt == nil || !manual.LastJobStartedAt.Equal(*running.StartedAt) {
		t.Fatalf("lastJobStartedAt = %v", manual.LastJobStartedAt)
	}
	if got := all[future.ID]; got.Connector != nil || got.LastJobStartedAt != nil {
		t.Fatalf("a job that has not started has no last start: %+v", got)
	}
	if all[free.ID].Current != nil || all[free.ID].LastJobStartedAt != nil {
		t.Fatalf("free machine = %+v", all[free.ID])
	}

	// Without machine_jobs.read the availability is still derived but the current item is hidden.
	hidden := fetch(restrictedPrincipal(t, h.pool, authorization.MachinesRead))
	if hidden[h.machine.ID].Availability != "in_use" || hidden[h.bareMachine.ID].Availability != "in_use" {
		t.Fatal("availability must not depend on machine_jobs.read")
	}
	for id, item := range hidden {
		if item.Current != nil {
			t.Fatalf("machine %s leaks its current item without machine_jobs.read", id)
		}
	}
	if hidden[h.machine.ID].Connector == nil {
		t.Fatal("connector state belongs to machines.read")
	}
}

func TestOverviewWorkItemCountsAndActiveItems(t *testing.T) {
	h := newLiveRunHarness(t)
	ctx := t.Context()
	read := func(p authorization.Principal) Overview {
		t.Helper()
		o, err := h.s.Overview(ctx, p)
		if err != nil {
			t.Fatal(err)
		}
		return o
	}
	w := &workItemFixture{runHarness: h}
	// Same shape as the work item fixture, rebuilt on this harness.
	running := h.create(t, h.input(-time.Hour, 3*time.Hour, "unknown"))
	needs := h.create(t, h.input(-5*time.Hour, time.Hour, "unknown"))
	bare := h.input(-12*time.Hour, time.Hour, "successful")
	bare.MachineID = h.bareMachine.ID
	bare.Customer = PartyReference{Kind: "person", ID: h.person}
	incomplete := h.create(t, bare)
	printing := h.insertRun(
		t,
		runSpec{
			machine:  h.bareMachine.ID,
			state:    "running",
			started:  at(h.now, -30*time.Minute),
			fileName: "vase.gcode",
		},
	)
	ended := h.insertRun(
		t,
		runSpec{
			machine:  h.bareMachine.ID,
			started:  at(h.now, -6*time.Hour),
			ended:    at(h.now, -5*time.Hour),
			fileName: "lid.gcode",
		},
	)
	linkedRun := h.insertRun(
		t,
		runSpec{machine: h.machine.ID, started: at(h.now, -20*time.Hour), ended: at(h.now, -19*time.Hour)},
	)
	h.attach(t, linkedRun, h.create(t, h.input(-30*time.Hour, time.Hour, "unknown")), true)
	_ = w

	after := read(h.p)
	// The database is shared with concurrently running tests, so the global overview
	// counts can only be bounded from below by this fixture's contribution (other
	// data can add to them but cannot remove ours). Exact counts are asserted
	// scoped to the machines this test owns.
	atLeast := func(label string, got *int64, want int64) {
		t.Helper()
		if got == nil || *got < want {
			t.Fatalf("overview %s = %v, want at least %d", label, got, want)
		}
	}
	atLeast("runningNow", after.RunningNow, 2)
	atLeast("needsOutcome", after.NeedsOutcome, 1)
	atLeast("unassignedRuns", after.UnassignedRuns, 1)
	atLeast("billingIssues", after.BillingIssues, 1)
	atLeast("activeTotal", after.ActiveTotal, 5)
	mine4 := []uuid.UUID{h.machine.ID, h.bareMachine.ID}
	scoped := func(label string, filters WorkItemFilters, want int64) {
		t.Helper()
		filters.MachineIDs = mine4
		filters.Page, filters.PageSize = 1, 50
		_, total, err := h.s.ListWorkItems(ctx, h.p, filters)
		if err != nil {
			t.Fatal(err)
		}
		if total != want {
			t.Fatalf("%s = %d on this fixture's machines, want %d", label, total, want)
		}
	}
	scoped("running+printing", WorkItemFilters{Statuses: []WorkItemStatus{"running", "running_unassigned"}}, 2)
	// The attached run has no outcome yet, so its job waits for one as well.
	scoped("needs_outcome", WorkItemFilters{Statuses: []WorkItemStatus{"needs_outcome"}}, 2)
	scoped("unlinked", WorkItemFilters{Statuses: []WorkItemStatus{"unassigned"}}, 1)
	scoped("billing issues", WorkItemFilters{Billing: []BillingState{"price_incomplete", "order_outdated"}}, 1)
	scoped(
		"active",
		WorkItemFilters{Statuses: []WorkItemStatus{"running", "running_unassigned", "unassigned", "needs_outcome"}},
		5,
	)
	for _, name := range []string{h.machine.Name, h.bareMachine.Name} {
		if !slices.Contains(after.RunningMachineNames, name) {
			t.Fatalf("running machine names %v lack %s", after.RunningMachineNames, name)
		}
	}
	if len(after.ActiveItems) == 0 || len(after.ActiveItems) > 6 {
		t.Fatalf("active items = %d", len(after.ActiveItems))
	}
	rank := map[WorkItemStatus]int{
		WorkItemRunning: 1, WorkItemRunningUnassigned: 2, WorkItemUnassigned: 3, WorkItemNeedsOutcome: 4,
	}
	var mine []uuid.UUID
	for i, item := range after.ActiveItems {
		if rank[item.Status] == 0 {
			t.Fatalf("active item with status %s", item.Status)
		}
		if i > 0 {
			prev := after.ActiveItems[i-1]
			if rank[prev.Status] > rank[item.Status] ||
				(rank[prev.Status] == rank[item.Status] && prev.StartedAt.Before(item.StartedAt)) {
				t.Fatalf(
					"active items out of order at %d: %s/%v then %s/%v",
					i,
					prev.Status,
					prev.StartedAt,
					item.Status,
					item.StartedAt,
				)
			}
		}
		if slices.Contains([]uuid.UUID{running.ID, printing, ended, needs.ID}, item.ID) {
			mine = append(mine, item.ID)
		}
	}
	// The fixture is newer than any other data, so it leads inside each status.
	want := []uuid.UUID{running.ID, printing, ended, needs.ID}
	if !slices.Equal(mine, want[:len(mine)]) {
		t.Fatalf("active items of this fixture = %v, want a prefix of %v", mine, want)
	}
	_ = incomplete

	// The new fields are hidden from a caller who may only read statistics.
	statsOnly := read(restrictedPrincipal(t, h.pool, authorization.StatisticsRead))
	if statsOnly.RunningNow != nil || statsOnly.NeedsOutcome != nil || statsOnly.UnassignedRuns != nil ||
		statsOnly.BillingIssues != nil ||
		statsOnly.ActiveTotal != nil ||
		statsOnly.ActiveItems != nil ||
		statsOnly.RunningMachineNames != nil {
		t.Fatalf("statistics-only overview exposes work items: %+v", statsOnly)
	}
	if statsOnly.JobsThisWeek < 0 {
		t.Fatal("existing fields stay available")
	}
}
