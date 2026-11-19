package integration_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	requestsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	"github.com/google/uuid"
)

// pinboardFixture extends the task fixture with a second group (and one member of it) and a place.
type pinboardFixture struct {
	taskFixture
	otherGroup  workinggroups.Group
	otherMember authorization.Principal
	place       uuid.UUID
}

func newPinFixture(t *testing.T, tag string) pinboardFixture {
	t.Helper()
	pool := statementPool(t)
	ctx := testContext(t)
	f := pinboardFixture{taskFixture: newTaskFixture(t, pool, tag)}
	var seeded seededAccount
	f.otherMember, seeded = groupPrincipal(t, pool, tag+"-other", "working_groups.read")
	other, err := f.service.Create(ctx, f.manager, workinggroups.CreateInput{Name: "Wood " + tag, LeadPersonID: seeded.personID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.otherGroup = other
	group, err := f.service.AddPlace(ctx, f.manager, f.group.ID, "Back room", nil)
	if err != nil {
		t.Fatal(err)
	}
	f.place = group.Places[0].ID
	return f
}

func (f pinboardFixture) pin(t *testing.T, p authorization.Principal, group *uuid.UUID, public bool, text string) workinggroups.Note {
	t.Helper()
	note, err := f.service.CreateNote(testContext(t), p, workinggroups.CreateNoteInput{GroupID: group, Public: public, Text: text}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return note
}

func noteTexts(notes []workinggroups.Note) string {
	texts := make([]string, 0, len(notes))
	for _, n := range notes {
		texts = append(texts, n.Text)
	}
	return strings.Join(texts, "|")
}

func TestWorkingGroupPinboardRequiresReadEverywhere(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	service := workinggroups.NewService(pool)
	manageOnly, _ := groupPrincipal(t, pool, "wgp-manage-only", "working_groups.manage")
	nobody, _ := groupPrincipal(t, pool, "wgp-nobody", "machines.read")
	id := ids.New()
	for _, p := range []authorization.Principal{manageOnly, nobody} {
		_, err := service.ListNotes(ctx, p, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
		_, err = service.CreateNote(ctx, p, workinggroups.CreateNoteInput{GroupID: &id, Text: "x"}, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
		_, err = service.CreateNote(ctx, p, workinggroups.CreateNoteInput{Public: true, Text: "x"}, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
		requireAppError(t, service.DeleteNote(ctx, p, id, nil), http.StatusForbidden, "permission_denied")
		_, err = service.SetMachineStatus(ctx, p, id, id, workinggroups.StatusInput{Usage: workinggroups.UsageLimited}, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
		_, err = service.SetPlaceStatus(ctx, p, id, id, workinggroups.StatusInput{Usage: workinggroups.UsageLimited}, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
		_, err = service.ListStatus(ctx, p)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
	}
}

func TestWorkingGroupNotesVisibilityAndWriting(t *testing.T) {
	f := newPinFixture(t, "wgp-notes")
	ctx := testContext(t)
	group := f.group.ID

	// Who may write what, and permission before validation.
	_, err := f.service.CreateNote(ctx, f.outsider, workinggroups.CreateNoteInput{GroupID: &group, Public: true, Text: ""}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = f.service.CreateNote(ctx, f.otherMember, workinggroups.CreateNoteInput{GroupID: &group, Text: "nope"}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = f.service.CreateNote(ctx, f.member, workinggroups.CreateNoteInput{Public: true, Text: ""}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = f.service.CreateNote(ctx, f.lead, workinggroups.CreateNoteInput{Public: true, Text: "makerspace"}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	unknown := ids.New()
	_, err = f.service.CreateNote(ctx, f.member, workinggroups.CreateNoteInput{GroupID: &unknown, Text: "x"}, nil)
	requireAppError(t, err, http.StatusNotFound, "")
	_, err = f.service.CreateNote(ctx, f.member, workinggroups.CreateNoteInput{GroupID: &group, Text: " "}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = f.service.CreateNote(ctx, f.member, workinggroups.CreateNoteInput{GroupID: &group, Text: strings.Repeat("ä", 501)}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = f.service.CreateNote(ctx, f.manager, workinggroups.CreateNoteInput{Public: false, Text: "hidden makerspace"}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")

	inside := f.pin(t, f.member, &group, false, "inside only")
	public := f.pin(t, f.member, &group, true, "public of group")
	leadNote := f.pin(t, f.lead, &group, false, "lead inside")
	space := f.pin(t, f.manager, nil, true, "for everybody")
	f.pin(t, f.otherMember, &f.otherGroup.ID, false, "other group inside")
	if !inside.CanDelete || inside.Author == nil || inside.GroupName != f.group.Name || public.Public != true || space.GroupID != nil {
		t.Fatalf("created notes = %+v %+v %+v", inside, public, space)
	}

	listed := func(p authorization.Principal, groupID *uuid.UUID) string {
		notes, err := f.service.ListNotes(ctx, p, groupID)
		if err != nil {
			t.Fatal(err)
		}
		return noteTexts(notes)
	}
	contains := func(list string, notes ...string) bool {
		for _, n := range notes {
			if !strings.Contains(list, n) {
				return false
			}
		}
		return true
	}
	// An outsider and the member of another group see public and makerspace notes, never this group's inside notes.
	for _, p := range []authorization.Principal{f.outsider, f.otherMember} {
		all, scoped := listed(p, nil), listed(p, &group)
		if strings.Contains(all, "inside only") || strings.Contains(all, "lead inside") || !contains(all, "public of group", "for everybody") {
			t.Fatalf("outsider list = %q", all)
		}
		if scoped != "public of group" {
			t.Fatalf("outsider list of the group = %q", scoped)
		}
	}
	// Inside people (member, lead, manager) see everything of the group.
	for _, p := range []authorization.Principal{f.member, f.lead, f.manager} {
		scoped := listed(p, &group)
		if !contains(scoped, "inside only", "public of group", "lead inside") || strings.Contains(scoped, "other group inside") {
			t.Fatalf("inside list = %q", scoped)
		}
	}
	if !strings.Contains(listed(f.manager, nil), "other group inside") || strings.Contains(listed(f.member, nil), "other group inside") {
		t.Fatalf("manager sees every note, a member only their own groups'")
	}

	// Deleting: an invisible note does not exist, a visible one needs author, lead or manage.
	notFound := f.service.DeleteNote(ctx, f.outsider, inside.ID, nil)
	requireAppError(t, notFound, http.StatusNotFound, "not_found")
	requireAppError(t, f.service.DeleteNote(ctx, f.otherMember, inside.ID, nil), http.StatusNotFound, "not_found")
	requireAppError(t, f.service.DeleteNote(ctx, f.outsider, ids.New(), nil), http.StatusNotFound, "not_found")
	requireAppError(t, f.service.DeleteNote(ctx, f.outsider, public.ID, nil), http.StatusForbidden, "permission_denied")
	requireAppError(t, f.service.DeleteNote(ctx, f.member, leadNote.ID, nil), http.StatusForbidden, "permission_denied")
	requireAppError(t, f.service.DeleteNote(ctx, f.lead, space.ID, nil), http.StatusForbidden, "permission_denied")
	if err := f.service.DeleteNote(ctx, f.lead, inside.ID, nil); err != nil {
		t.Fatalf("lead removes a member's note: %v", err)
	}
	if err := f.service.DeleteNote(ctx, f.member, public.ID, nil); err != nil {
		t.Fatalf("author removes own note: %v", err)
	}
	if err := f.service.DeleteNote(ctx, f.manager, leadNote.ID, nil); err != nil {
		t.Fatalf("manager removes a note: %v", err)
	}
	if err := f.service.DeleteNote(ctx, f.manager, space.ID, nil); err != nil {
		t.Fatalf("manager removes a makerspace note: %v", err)
	}
	requireAppError(t, f.service.DeleteNote(ctx, f.manager, space.ID, nil), http.StatusNotFound, "not_found")

	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_note.pinned' AND resource_id = $1`, 1, inside.ID)
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_note.removed' AND resource_id = $1`, 1, inside.ID)
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE resource_type = 'working_group_note'
		AND (to_jsonb(audit_events)::text LIKE '%inside only%' OR to_jsonb(audit_events)::text LIKE '%public of group%')`, 0)
}

func TestWorkingGroupNoteOfDeletedAuthorStays(t *testing.T) {
	f := newPinFixture(t, "wgp-former")
	ctx := testContext(t)
	author := insertGroupPerson(t, f.pool, "wgp-former-author@example.test")
	group := f.group.ID
	id := ids.New()
	if _, err := f.pool.Exec(ctx, `INSERT INTO working_group_notes(id, group_id, is_public, text, author_person_id) VALUES($1, $2, true, 'Still here', $3)`,
		id, group, author); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `DELETE FROM people WHERE id = $1`, author); err != nil {
		t.Fatal(err)
	}
	notes, err := f.service.ListNotes(ctx, f.outsider, &group)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range notes {
		if n.ID == id {
			if n.Author != nil || n.CanDelete {
				t.Fatalf("note = %+v", n)
			}
			return
		}
	}
	t.Fatalf("note vanished with its author: %v", noteTexts(notes))
}

func TestWorkingGroupStatusOfMachinesAndPlaces(t *testing.T) {
	f := newPinFixture(t, "wgp-status")
	ctx := testContext(t)
	group := f.group.ID
	until := day(2027, 3, 1)
	note := "PLA and PETG only until the fan is replaced"
	limited := workinggroups.StatusInput{Usage: workinggroups.UsageLimited, Note: &note, Until: &until}

	// Outsiders and members of other groups are denied before anything else is looked at.
	for _, p := range []authorization.Principal{f.outsider, f.otherMember} {
		_, err := f.service.SetMachineStatus(ctx, p, group, f.machine, limited, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
		_, err = f.service.SetPlaceStatus(ctx, p, group, f.place, workinggroups.StatusInput{Usage: "bogus"}, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
	}
	other := insertWorkingGroupMachine(t, f.pool, "Elsewhere wgp-status")
	_, err := f.service.SetMachineStatus(ctx, f.member, group, other, limited, nil)
	requireAppError(t, err, http.StatusNotFound, "")
	_, err = f.service.SetPlaceStatus(ctx, f.member, group, ids.New(), limited, nil)
	requireAppError(t, err, http.StatusNotFound, "")
	_, err = f.service.SetMachineStatus(ctx, f.member, ids.New(), f.machine, limited, nil)
	requireAppError(t, err, http.StatusNotFound, "")
	_, err = f.service.SetMachineStatus(ctx, f.member, group, f.machine, workinggroups.StatusInput{Usage: "bogus"}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	long := strings.Repeat("x", 201)
	_, err = f.service.SetMachineStatus(ctx, f.member, group, f.machine, workinggroups.StatusInput{Usage: workinggroups.UsageLimited, Note: &long}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")

	// A member sets limited with note and date; the group detail and the overview show it.
	detail, err := f.service.SetMachineStatus(ctx, f.member, group, f.machine, limited, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := detail.Machines[0]
	if m.Usage != workinggroups.UsageLimited || m.Note == nil || *m.Note != note || m.Until == nil || !m.Until.Equal(until) ||
		m.ChangedBy == nil || m.ChangedBy.ID != f.memberID || m.ChangedAt == nil {
		t.Fatalf("machine = %+v", m)
	}
	if detail.Places[0].Usage != workinggroups.UsageOK {
		t.Fatalf("place = %+v", detail.Places[0])
	}
	reader, err := f.service.Get(ctx, f.outsider, group)
	if err != nil || reader.Machines[0].Usage != workinggroups.UsageLimited {
		t.Fatalf("outsider detail = %+v, %v", reader.Machines, err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action = 'working_group_machine.status_changed' AND resource_id = $1`, 1, f.machine)
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE resource_type = 'working_group_machine' AND to_jsonb(audit_events)::text LIKE '%fan is replaced%'`, 0)

	// The same values again change and record nothing.
	if _, err := f.service.SetMachineStatus(ctx, f.member, group, f.machine, limited, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM working_group_status_changes WHERE machine_id = $1`, 1, f.machine)

	// ok clears note and date even when the request still carries them.
	detail, err = f.service.SetMachineStatus(ctx, f.lead, group, f.machine, workinggroups.StatusInput{Usage: workinggroups.UsageOK, Note: &note, Until: &until}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m = detail.Machines[0]; m.Usage != workinggroups.UsageOK || m.Note != nil || m.Until != nil {
		t.Fatalf("machine after ok = %+v", m)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM working_group_status_changes WHERE machine_id = $1`, 2, f.machine)

	// Places work the same, for the manager too (always inside).
	detail, err = f.service.SetPlaceStatus(ctx, f.manager, group, f.place, workinggroups.StatusInput{Usage: workinggroups.UsageMaintenance}, nil)
	if err != nil || detail.Places[0].Usage != workinggroups.UsageMaintenance {
		t.Fatalf("place = %+v, %v", detail.Places, err)
	}

	// The overview lists everything with not-ok items first.
	items, err := f.service.ListStatus(ctx, f.outsider)
	if err != nil {
		t.Fatal(err)
	}
	seenOK, found := false, false
	for _, item := range items {
		if item.State.Usage == workinggroups.UsageOK {
			seenOK = true
		} else if seenOK {
			t.Fatalf("a not-ok item follows an ok one: %+v", items)
		}
		if item.ID == f.place {
			found = item.Kind == "place" && item.GroupID == group && item.DaysNotOkLast90 == 1
		}
	}
	if !found {
		t.Fatalf("place missing or wrong in %+v", items)
	}

	// A machine that stays keeps its status when the set changes; one that leaves and returns starts at ok.
	if _, err := f.service.SetMachineStatus(ctx, f.member, group, f.machine, workinggroups.StatusInput{Usage: workinggroups.UsageOutOfOrder}, nil); err != nil {
		t.Fatal(err)
	}
	second := insertWorkingGroupMachine(t, f.pool, "Second wgp-status")
	if detail, err = f.service.SetMachines(ctx, f.manager, group, []uuid.UUID{f.machine, second}, nil); err != nil {
		t.Fatal(err)
	}
	for _, machine := range detail.Machines {
		if machine.ID == f.machine && machine.Usage != workinggroups.UsageOutOfOrder {
			t.Fatalf("status lost when another machine joined: %+v", machine)
		}
	}
	if _, err = f.service.SetMachines(ctx, f.manager, group, []uuid.UUID{second}, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM working_group_status_changes WHERE machine_id = $1`, 0, f.machine)
	if detail, err = f.service.SetMachines(ctx, f.manager, group, []uuid.UUID{f.machine, second}, nil); err != nil {
		t.Fatal(err)
	}
	for _, machine := range detail.Machines {
		if machine.ID == f.machine && (machine.Usage != workinggroups.UsageOK || machine.ChangedAt != nil) {
			t.Fatalf("reassigned machine = %+v", machine)
		}
	}
}

func TestWorkingGroupStatusDaysNotOkLast90(t *testing.T) {
	f := newPinFixture(t, "wgp-days")
	ctx := testContext(t)
	group := f.group.ID
	today := time.Now().UTC().Truncate(24 * time.Hour)
	at := func(daysAgo, hour int) time.Time {
		return today.AddDate(0, 0, -daysAgo).Add(time.Duration(hour) * time.Hour)
	}
	change := func(machine, place *uuid.UUID, status string, when time.Time) {
		if _, err := f.pool.Exec(ctx, `INSERT INTO working_group_status_changes(id, group_id, machine_id, place_id, status, changed_at)
			VALUES($1, $2, $3, $4, $5, $6)`, ids.New(), group, machine, place, status, when); err != nil {
			t.Fatal(err)
		}
	}
	// The place was out of order from five days ago 10:00 until two days ago 08:00: four calendar days.
	change(nil, &f.place, "out_of_order", at(5, 10))
	change(nil, &f.place, "ok", at(2, 8))
	// The machine went into maintenance long before the window and is still there: every one of the 90 days.
	second := insertWorkingGroupMachine(t, f.pool, "Long wgp-days")
	if _, err := f.service.SetMachines(ctx, f.manager, group, []uuid.UUID{f.machine, second}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE working_group_machines SET status = 'maintenance' WHERE machine_id = $1`, second); err != nil {
		t.Fatal(err)
	}
	change(&second, nil, "maintenance", at(200, 9))
	// A machine that was never touched has no days.
	items, err := f.service.ListStatus(ctx, f.member)
	if err != nil {
		t.Fatal(err)
	}
	days := map[uuid.UUID]int{}
	for _, item := range items {
		days[item.ID] = item.DaysNotOkLast90
	}
	if days[f.place] != 4 || days[second] != 90 || days[f.machine] != 0 {
		t.Fatalf("days place=%d long=%d untouched=%d", days[f.place], days[second], days[f.machine])
	}
}

func TestWorkingGroupSummaryCounts(t *testing.T) {
	f := newPinFixture(t, "wgp-counts")
	ctx := testContext(t)
	f.newTicket(t, f.outsider, "Broken lens")
	if _, err := f.service.CreateTodo(ctx, f.member, workinggroups.CreateTodoInput{GroupID: f.group.ID, Title: "Clean", DueOn: day(2027, 4, 1)}, nil); err != nil {
		t.Fatal(err)
	}
	find := func(p authorization.Principal) workinggroups.Summary {
		list, err := f.service.List(ctx, p)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range list {
			if s.ID == f.group.ID {
				detail, err := f.service.Get(ctx, p, f.group.ID)
				if err != nil || detail.OpenTicketCount != s.OpenTicketCount || (detail.OpenTodoCount == nil) != (s.OpenTodoCount == nil) {
					t.Fatalf("detail counts differ from the list: %+v vs %+v, %v", detail.Summary, s, err)
				}
				return s
			}
		}
		t.Fatal("group missing")
		return workinggroups.Summary{}
	}
	for _, p := range []authorization.Principal{f.outsider, f.otherMember} {
		if s := find(p); s.OpenTicketCount != 1 || s.OpenTodoCount != nil {
			t.Fatalf("outsider summary = %+v", s)
		}
	}
	for _, p := range []authorization.Principal{f.member, f.lead, f.manager} {
		if s := find(p); s.OpenTicketCount != 1 || s.OpenTodoCount == nil || *s.OpenTodoCount != 1 {
			t.Fatalf("inside summary = %+v", s)
		}
	}
}

func TestPeopleMergeMovesWorkingGroupPinboardReferences(t *testing.T) {
	f := newPinFixture(t, "wgp-merge")
	ctx := testContext(t)
	actor, _ := groupPrincipal(t, f.pool, "wgp-merge-actor", mergePermissions...)
	target := insertGroupPerson(t, f.pool, "wgp-merge-target@example.test")
	source := insertGroupPerson(t, f.pool, "wgp-merge-source@example.test")
	mergeExec(t, f.pool, `INSERT INTO working_group_notes(id, group_id, is_public, text, author_person_id) VALUES($1, $2, true, 'By source', $3)`,
		ids.New(), f.group.ID, source)
	mergeExec(t, f.pool, `UPDATE working_group_machines SET status = 'limited', status_changed_by = $2, status_changed_at = now() WHERE machine_id = $1`,
		f.machine, source)
	mergeExec(t, f.pool, `UPDATE working_group_places SET status = 'limited', status_changed_by = $2, status_changed_at = now() WHERE id = $1`,
		f.place, source)
	mergeExec(t, f.pool, `INSERT INTO working_group_status_changes(id, group_id, machine_id, status, changed_at, changed_by_person_id)
		VALUES($1, $2, $3, 'limited', now(), $4)`, ids.New(), f.group.ID, f.machine, source)

	result, err := people.NewService(f.pool, nil).Merge(ctx, actor, people.MergeInput{
		MergeSelection:   people.MergeSelection{TargetPersonID: target, SourcePersonIDs: []uuid.UUID{source}},
		ExpectedVersions: mergeVersions(t, f.pool, target, source),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM working_group_notes WHERE author_person_id = $1`, 1, target)
	assertCount(t, f.pool, `SELECT count(*) FROM working_group_machines WHERE status_changed_by = $1`, 1, target)
	assertCount(t, f.pool, `SELECT count(*) FROM working_group_places WHERE status_changed_by = $1`, 1, target)
	assertCount(t, f.pool, `SELECT count(*) FROM working_group_status_changes WHERE changed_by_person_id = $1`, 1, target)
	var moved int64
	for _, m := range result.Moved {
		if m.Category == people.MergedWorkingGroupTasks {
			moved = m.Count
		}
	}
	if moved != 4 {
		t.Fatalf("working group tasks merged = %d, want 4 (%+v)", moved, result.Moved)
	}
}

func TestSubjectRequestExportHoldsOnlyTheSubjectsNotes(t *testing.T) {
	f := newPinFixture(t, "wgp-export")
	ctx := testContext(t)
	subject := insertGroupPerson(t, f.pool, "wgp-export-subject@example.test")
	mergeExec(t, f.pool, `INSERT INTO working_group_notes(id, group_id, is_public, text, author_person_id) VALUES($1, $2, false, 'Subject wrote this', $3)`,
		ids.New(), f.group.ID, subject)
	mergeExec(t, f.pool, `INSERT INTO working_group_notes(id, group_id, is_public, text, author_person_id) VALUES($1, $2, true, 'Colleague wrote this', $3)`,
		ids.New(), f.group.ID, f.memberID)
	mergeExec(t, f.pool, `UPDATE working_group_places SET status = 'limited', status_note = 'Subject status note', status_changed_by = $2 WHERE id = $1`,
		f.place, subject)
	mergeExec(t, f.pool, `INSERT INTO working_group_status_changes(id, group_id, place_id, status, changed_at, changed_by_person_id)
		VALUES($1, $2, $3, 'limited', now(), $4)`, ids.New(), f.group.ID, f.place, subject)

	queries := requestsdb.New(f.pool)
	count, err := queries.CountWorkingGroupTasks(ctx, subject)
	if err != nil || count != 2 { // note + status change
		t.Fatalf("count = %d, %v", count, err)
	}
	document, err := queries.ExportWorkingGroupTasks(ctx, subject)
	if err != nil {
		t.Fatal(err)
	}
	var export map[string][]map[string]any
	if err := json.Unmarshal(document, &export); err != nil {
		t.Fatal(err)
	}
	if len(export["notes"]) != 1 || export["notes"][0]["text"] != "Subject wrote this" || len(export["statusChanges"]) != 1 ||
		len(export["statusNotes"]) != 1 || strings.Contains(string(document), "Colleague wrote this") {
		t.Fatalf("export = %s", document)
	}
}
