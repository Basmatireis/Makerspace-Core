package integration_test

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	requestsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// promoteToTrainee gives a person the Trainee membership role: new people start as visitors, who cannot join groups.
func promoteToTrainee(t *testing.T, pool *pgxpool.Pool, personID uuid.UUID) {
	t.Helper()
	if _, err := pool.Exec(testContext(t),
		`UPDATE person_roles SET role_id = (SELECT id FROM roles WHERE system_key = 'trainee')
		 WHERE person_id = $1 AND role_id = (SELECT id FROM roles WHERE system_key = 'visitor')`, personID); err != nil {
		t.Fatal(err)
	}
}

func insertGroupPerson(t *testing.T, pool *pgxpool.Pool, email string) uuid.UUID {
	t.Helper()
	id := insertPlainPerson(t, pool, email)
	promoteToTrainee(t, pool, id)
	return id
}

func groupPrincipal(
	t *testing.T,
	pool *pgxpool.Pool,
	suffix string,
	permissions ...string,
) (authorization.Principal, seededAccount) {
	t.Helper()
	p, seeded := principalWithPermissions(t, pool, suffix, permissions...)
	promoteToTrainee(t, pool, seeded.personID)
	return p, seeded
}

func insertWorkingGroupMachine(t *testing.T, pool *pgxpool.Pool, name string) uuid.UUID {
	t.Helper()
	ctx := testContext(t)
	processID, machineID := ids.New(), ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO processes(id,name,integration) VALUES($1,$2,'fdm_printer')`,
		processID, "Process of "+name); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO machines(id,process_id,name) VALUES($1,$2,$3)`,
		machineID, processID, name); err != nil {
		t.Fatal(err)
	}
	return machineID
}

func TestWorkingGroupsRequireReadPermissionEverywhere(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	service := workinggroups.NewService(pool)
	// Even working_groups.manage does not help without working_groups.read.
	manageOnly, _ := groupPrincipal(t, pool, "wg-manage-only", "working_groups.manage")
	nobody, _ := groupPrincipal(t, pool, "wg-nobody", "machines.read")
	group, person := ids.New(), ids.New()

	for name, p := range map[string]authorization.Principal{"manage only": manageOnly, "nobody": nobody} {
		check := func(operation string, err error) {
			t.Helper()
			if !apperror.IsCode(err, "permission_denied") {
				t.Fatalf("%s as %s: error = %v, want permission_denied", operation, name, err)
			}
		}
		_, err := service.List(ctx, p)
		check("list", err)
		_, err = service.Get(ctx, p, group)
		check("get", err)
		_, err = service.Create(ctx, p, workinggroups.CreateInput{Name: "Laser", LeadPersonID: person}, nil)
		check("create", err)
		_, err = service.Update(ctx, p, group, workinggroups.UpdateInput{ExpectedVersion: 1}, nil)
		check("update", err)
		check("delete", service.Delete(ctx, p, group, nil))
		_, err = service.AddMember(ctx, p, group, person, nil)
		check("add member", err)
		_, err = service.RemoveMember(ctx, p, group, person, nil)
		check("remove member", err)
		_, err = service.SetLead(ctx, p, group, person, nil)
		check("set lead", err)
		_, err = service.SetMachines(ctx, p, group, nil, nil)
		check("set machines", err)
		_, err = service.AddPlace(ctx, p, group, "Corner", nil)
		check("add place", err)
		_, err = service.RemovePlace(ctx, p, group, ids.New(), nil)
		check("remove place", err)
		_, err = service.FindPeople(ctx, p, "")
		check("find people", err)
		_, err = service.ListMachineOptions(ctx, p)
		check("machine options", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM working_groups`, 0)
}

func TestWorkingGroupsManageLifecycle(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	service := workinggroups.NewService(pool)
	manager, _ := groupPrincipal(t, pool, "wg-manager", "working_groups.read", "working_groups.manage")
	leadPerson := insertGroupPerson(t, pool, "wg-lead@example.test")

	_, err := service.Create(ctx, manager, workinggroups.CreateInput{Name: "  ", LeadPersonID: leadPerson}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "")
	_, err = service.Create(ctx, manager, workinggroups.CreateInput{Name: "Laser", LeadPersonID: ids.New()}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "person_not_found")
	assertCount(t, pool, `SELECT count(*) FROM working_groups`, 0)

	laser, err := service.Create(ctx, manager, workinggroups.CreateInput{
		Name: " Laser ", Description: "Laser cutters", LeadPersonID: leadPerson,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if laser.Name != "Laser" || laser.Version != 1 || laser.Lead == nil || laser.Lead.ID != leadPerson ||
		len(laser.Members) != 1 || !laser.Members[0].IsLead || !laser.CanEdit || !laser.CanManage {
		t.Fatalf("group = %+v", laser)
	}
	_, err = service.Create(ctx, manager, workinggroups.CreateInput{Name: "LASER", LeadPersonID: leadPerson}, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_exists")
	a3d, err := service.Create(ctx, manager, workinggroups.CreateInput{Name: "3D printing", LeadPersonID: leadPerson}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// A person may lead or join several groups.
	items, err := service.List(ctx, manager)
	if err != nil || len(items) != 2 || items[0].ID != a3d.ID || items[1].ID != laser.ID || items[1].MemberCount != 1 {
		t.Fatalf("list = %+v, %v", items, err)
	}

	// Renaming is audited, stale versions are refused and a name clash is a 409.
	name := "Laser cutting"
	renamed, err := service.Update(ctx, manager, laser.ID, workinggroups.UpdateInput{ExpectedVersion: 1, Name: &name}, nil)
	if err != nil || renamed.Name != name || renamed.Version != 2 {
		t.Fatalf("renamed = %+v, %v", renamed, err)
	}
	_, err = service.Update(ctx, manager, laser.ID, workinggroups.UpdateInput{ExpectedVersion: 1, Name: &name}, nil)
	requireAppError(t, err, http.StatusConflict, "stale_write")
	clash := "3d PRINTING"
	_, err = service.Update(ctx, manager, laser.ID, workinggroups.UpdateInput{ExpectedVersion: 2, Name: &clash}, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_exists")

	// Only the group's own sub-resources are addressed through its id.
	missing := ids.New()
	_, err = service.Get(ctx, manager, missing)
	requireAppError(t, err, http.StatusNotFound, "not_found")
	_, err = service.AddMember(ctx, manager, missing, leadPerson, nil)
	requireAppError(t, err, http.StatusNotFound, "not_found")
	_, err = service.SetLead(ctx, manager, missing, leadPerson, nil)
	requireAppError(t, err, http.StatusNotFound, "not_found")
	_, err = service.SetMachines(ctx, manager, missing, nil, nil)
	requireAppError(t, err, http.StatusNotFound, "not_found")
	_, err = service.AddPlace(ctx, manager, missing, "Corner", nil)
	requireAppError(t, err, http.StatusNotFound, "not_found")
	requireAppError(t, service.Delete(ctx, manager, missing, nil), http.StatusNotFound, "not_found")

	// Changing the lead keeps the previous lead as a normal member and adds a new person as a member.
	newLead := insertGroupPerson(t, pool, "wg-new-lead@example.test")
	changed, err := service.SetLead(ctx, manager, laser.ID, newLead, nil)
	if err != nil || changed.Lead == nil || changed.Lead.ID != newLead || changed.MemberCount != 2 ||
		!changed.Members[0].IsLead || changed.Members[0].PersonID != newLead || changed.Members[1].IsLead {
		t.Fatalf("changed lead = %+v, %v", changed, err)
	}
	_, err = service.SetLead(ctx, manager, laser.ID, ids.New(), nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "person_not_found")
	assertCount(t, pool, `SELECT count(*) FROM working_group_members WHERE group_id = $1 AND is_lead`, 1, laser.ID)

	// Adding an existing member is a conflict; the lead cannot be removed.
	_, err = service.AddMember(ctx, manager, laser.ID, newLead, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_member_exists")
	_, err = service.RemoveMember(ctx, manager, laser.ID, newLead, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_lead_required")
	_, err = service.RemoveMember(ctx, manager, laser.ID, ids.New(), nil)
	requireAppError(t, err, http.StatusNotFound, "not_found")
	if _, err := service.RemoveMember(ctx, manager, laser.ID, leadPerson, nil); err != nil {
		t.Fatal(err)
	}

	// Deleting a group removes its dependants and is audited without free text.
	place, err := service.AddPlace(ctx, manager, laser.ID, "Soldering corner", nil)
	if err != nil || len(place.Places) != 1 {
		t.Fatalf("place = %+v, %v", place, err)
	}
	if err := service.Delete(ctx, manager, laser.ID, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM working_group_members WHERE group_id = $1`, 0, laser.ID)
	assertCount(t, pool, `SELECT count(*) FROM working_group_places WHERE group_id = $1`, 0, laser.ID)
	for _, action := range []string{
		"working_group.created", "working_group.updated", "working_group.deleted", "working_group_lead.changed",
		"working_group_member.removed", "working_group_place.added",
	} {
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = $1`, action).Scan(&count); err != nil || count == 0 {
			t.Fatalf("audit events %s = %d, %v", action, count, err)
		}
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE resource_type = 'working_group' AND metadata::text LIKE '%Soldering%'`, 0)
}

func TestWorkingGroupLeadScopeAndDenials(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	service := workinggroups.NewService(pool)
	manager, _ := groupPrincipal(t, pool, "wg-scope-manager", "working_groups.read", "working_groups.manage")
	lead, leadAccount := groupPrincipal(t, pool, "wg-scope-lead", "working_groups.read")
	_, otherAccount := groupPrincipal(t, pool, "wg-scope-other-lead", "working_groups.read")
	reader, readerAccount := groupPrincipal(t, pool, "wg-scope-reader", "working_groups.read")
	extra := insertGroupPerson(t, pool, "wg-scope-extra@example.test")

	own, err := service.Create(ctx, manager, workinggroups.CreateInput{Name: "Wood", LeadPersonID: leadAccount.personID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := service.Create(ctx, manager, workinggroups.CreateInput{Name: "Textile", LeadPersonID: otherAccount.personID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ownMachine := insertWorkingGroupMachine(t, pool, "Table saw")
	foreignMachine := insertWorkingGroupMachine(t, pool, "Sewing machine")
	if _, err := service.SetMachines(ctx, manager, foreign.ID, []uuid.UUID{foreignMachine}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AddMember(ctx, manager, own.ID, extra, nil); err != nil {
		t.Fatal(err)
	}
	foreignPlace, err := service.AddPlace(ctx, manager, foreign.ID, "Fabric shelf", nil)
	if err != nil {
		t.Fatal(err)
	}

	// A reader who neither leads a group nor manages cannot change anything and gets no pickers.
	text := "Changed"
	_, err = service.Update(ctx, reader, own.ID, workinggroups.UpdateInput{ExpectedVersion: 1, Description: &text}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.AddMember(ctx, reader, own.ID, extra, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.RemoveMember(ctx, reader, own.ID, extra, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.SetLead(ctx, reader, own.ID, extra, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.SetMachines(ctx, reader, own.ID, []uuid.UUID{ownMachine}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.AddPlace(ctx, reader, own.ID, "Corner", nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.RemovePlace(ctx, reader, foreign.ID, foreignPlace.Places[0].ID, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	requireAppError(t, service.Delete(ctx, reader, own.ID, nil), http.StatusForbidden, "permission_denied")
	_, err = service.Create(ctx, reader, workinggroups.CreateInput{Name: "New", LeadPersonID: extra}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.FindPeople(ctx, reader, "")
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.ListMachineOptions(ctx, reader)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")

	// The lead edits the own group: description, chat link, members, machines and places.
	chat := "https://chat.example.test/wood"
	updated, err := service.Update(ctx, lead, own.ID, workinggroups.UpdateInput{
		ExpectedVersion: 1, Description: &text, ChatURL: workinggroups.OptionalText{Set: true, Value: &chat},
	}, nil)
	if err != nil || updated.Description != text || updated.ChatURL == nil || *updated.ChatURL != chat ||
		updated.Version != 2 || !updated.CanEdit || updated.CanManage || !updated.IsLead {
		t.Fatalf("updated = %+v, %v", updated, err)
	}
	for _, bad := range []string{"http://chat.example.test", "https://", "ftp://chat.example.test", "https://a b.test", "javascript:alert(1)"} {
		_, err = service.Update(ctx, lead, own.ID, workinggroups.UpdateInput{
			ExpectedVersion: 2, ChatURL: workinggroups.OptionalText{Set: true, Value: &bad},
		}, nil)
		requireAppError(t, err, http.StatusUnprocessableEntity, "")
	}
	withMember, err := service.AddMember(ctx, lead, own.ID, readerAccount.personID, nil)
	if err != nil || withMember.MemberCount != 3 {
		t.Fatalf("with member = %+v, %v", withMember, err)
	}
	if _, err := service.RemoveMember(ctx, lead, own.ID, extra, nil); err != nil {
		t.Fatal(err)
	}
	_, err = service.RemoveMember(ctx, lead, own.ID, leadAccount.personID, nil)
	requireAppError(t, err, http.StatusConflict, "working_group_lead_required")
	withMachine, err := service.SetMachines(ctx, lead, own.ID, []uuid.UUID{ownMachine, ownMachine}, nil)
	if err != nil || len(withMachine.Machines) != 1 || withMachine.MachineCount != 1 {
		t.Fatalf("with machine = %+v, %v", withMachine, err)
	}
	withPlace, err := service.AddPlace(ctx, lead, own.ID, "Sawdust corner", nil)
	if err != nil || len(withPlace.Places) != 1 {
		t.Fatalf("with place = %+v, %v", withPlace, err)
	}
	_, err = service.AddPlace(ctx, lead, own.ID, "SAWDUST corner", nil)
	requireAppError(t, err, http.StatusConflict, "working_group_place_exists")
	withoutPlace, err := service.RemovePlace(ctx, lead, own.ID, withPlace.Places[0].ID, nil)
	if err != nil || len(withoutPlace.Places) != 0 {
		t.Fatalf("without place = %+v, %v", withoutPlace, err)
	}
	_, err = service.RemovePlace(ctx, lead, own.ID, withPlace.Places[0].ID, nil)
	requireAppError(t, err, http.StatusNotFound, "not_found")

	// ... but not the name, the lead or the group itself.
	rename := "Carpentry"
	_, err = service.Update(ctx, lead, own.ID, workinggroups.UpdateInput{ExpectedVersion: 2, Name: &rename}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.SetLead(ctx, lead, own.ID, extra, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	requireAppError(t, service.Delete(ctx, lead, own.ID, nil), http.StatusForbidden, "permission_denied")
	_, err = service.Create(ctx, lead, workinggroups.CreateInput{Name: "New", LeadPersonID: extra}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")

	// ... and not another group.
	_, err = service.Update(ctx, lead, foreign.ID, workinggroups.UpdateInput{ExpectedVersion: 1, Description: &text}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.AddMember(ctx, lead, foreign.ID, extra, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.RemoveMember(ctx, lead, foreign.ID, otherAccount.personID, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.SetMachines(ctx, lead, foreign.ID, nil, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.AddPlace(ctx, lead, foreign.ID, "Corner", nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.RemovePlace(ctx, lead, foreign.ID, foreignPlace.Places[0].ID, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	assertCount(t, pool, `SELECT count(*) FROM working_group_machines WHERE group_id = $1`, 1, foreign.ID)
	assertCount(t, pool, `SELECT count(*) FROM working_group_places WHERE group_id = $1`, 1, foreign.ID)

	// The chat link is only visible to members of the group and to managers.
	for who, p := range map[string]authorization.Principal{"reader member": reader, "lead": lead, "manager": manager} {
		group, err := service.Get(ctx, p, own.ID)
		if err != nil || group.ChatURL == nil || *group.ChatURL != chat {
			t.Fatalf("%s sees chat %v, %v", who, group.ChatURL, err)
		}
	}
	nonMember, _ := groupPrincipal(t, pool, "wg-scope-non-member", "working_groups.read")
	group, err := service.Get(ctx, nonMember, own.ID)
	if err != nil || group.ChatURL != nil || group.IsMember || group.CanEdit || group.CanManage ||
		group.Description != text || len(group.Members) != 2 {
		t.Fatalf("non-member view = %+v, %v", group, err)
	}
	if listed, err := service.List(ctx, nonMember); err != nil || len(listed) != 2 {
		t.Fatalf("non-member list = %+v, %v", listed, err)
	}
	if listed, err := service.List(ctx, lead); err != nil || len(listed) != 2 || !listed[1].IsLead || listed[0].IsLead {
		t.Fatalf("lead list = %+v, %v", listed, err)
	}

	// A machine belongs to at most one group; the machine picker shows where it is.
	_, err = service.SetMachines(ctx, lead, own.ID, []uuid.UUID{ownMachine, foreignMachine}, nil)
	requireAppError(t, err, http.StatusConflict, "machine_in_other_working_group")
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || appErr.Details["machineId"] != foreignMachine.String() {
		t.Fatalf("details = %v", err)
	}
	_, err = service.SetMachines(ctx, manager, own.ID, []uuid.UUID{ids.New()}, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "machine_not_found")
	assertCount(t, pool, `SELECT count(*) FROM working_group_machines WHERE group_id = $1`, 1, own.ID)
	options, err := service.ListMachineOptions(ctx, lead)
	if err != nil || len(options) != 2 {
		t.Fatalf("machine options = %+v, %v", options, err)
	}
	for _, option := range options {
		wantGroup, wantName := own.ID, "Wood"
		if option.ID == foreignMachine {
			wantGroup, wantName = foreign.ID, "Textile"
		}
		if option.GroupID == nil || *option.GroupID != wantGroup || option.GroupName == nil || *option.GroupName != wantName {
			t.Fatalf("option = %+v", option)
		}
	}

	// The people picker is for managers and leads and offers names only.
	people, err := service.FindPeople(ctx, lead, "")
	if err != nil || len(people) == 0 {
		t.Fatalf("people = %+v, %v", people, err)
	}
	if _, err := service.FindPeople(ctx, manager, "plain"); err != nil {
		t.Fatal(err)
	}
	if found, err := service.FindPeople(ctx, lead, "Nobody has this name"); err != nil || len(found) != 0 {
		t.Fatalf("found = %+v, %v", found, err)
	}
}

func TestWorkingGroupsOverHTTP(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	const (
		origin        = "http://makerspace.example.test"
		adminLogin    = "groups-admin@example.test"
		adminPassword = "Groups admin workshop password 65"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Groups", LastName: "Admin", LoginEmail: adminLogin, Password: adminPassword,
	}); err != nil {
		t.Fatal(err)
	}
	baseURL, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		PublicBaseURL:      baseURL,
		SessionCookieName:  "makerspace_session",
		CSRFCookieName:     "makerspace_csrf",
		SessionIdleTTL:     6 * time.Hour,
		SessionAbsoluteTTL: 72 * time.Hour,
		PasswordResetTTL:   30 * time.Minute,
	}
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	client := newCookieClient(t)
	response := doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "",
		map[string]any{"email": adminLogin, "password": adminPassword})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	csrf := cookieValue(t, client, server.URL, cfg.CSRFCookieName)
	api := server.URL + "/api/v1/working-groups"

	lead := insertGroupPerson(t, pool, "groups-http-lead@example.test")
	machine := insertWorkingGroupMachine(t, pool, "Vinyl cutter")

	response = doJSON(t, client, http.MethodPost, api, origin, csrf,
		map[string]any{"name": "Vinyl", "description": "Plotter and heat press", "leadPersonId": lead})
	assertStatus(t, response, http.StatusCreated)
	var group openapi.WorkingGroup
	decodeResponse(t, response, &group)
	if group.Lead == nil || group.Lead.PersonId != lead || !group.CanManage || group.Version != 1 {
		t.Fatalf("group = %+v", group)
	}
	groupURL := api + "/" + group.Id.String()

	// The static picker paths are not mistaken for a group id.
	response = doJSON(t, client, http.MethodGet, api+"/people?search=Plain", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	assertNoStoreAndRequestID(t, response)
	var people openapi.WorkingGroupPersonOptionList
	decodeResponse(t, response, &people)
	if len(people.Items) == 0 {
		t.Fatalf("people = %+v", people)
	}
	response = doJSON(t, client, http.MethodGet, api+"/machines", "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var machines openapi.WorkingGroupMachineOptionList
	decodeResponse(t, response, &machines)
	if len(machines.Items) != 1 || machines.Items[0].Id != machine || machines.Items[0].WorkingGroupId != nil {
		t.Fatalf("machines = %+v", machines)
	}

	response = doJSON(t, client, http.MethodPut, groupURL+"/machines", origin, csrf,
		map[string]any{"machineIds": []uuid.UUID{machine}})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &group)
	if len(group.Machines) != 1 || group.MachineCount != 1 {
		t.Fatalf("machines of group = %+v", group)
	}

	// Omitting chatUrl keeps it, a value sets it and null clears it.
	response = doJSON(t, client, http.MethodPatch, groupURL, origin, csrf,
		map[string]any{"expectedVersion": 1, "chatUrl": "https://chat.example.test/vinyl"})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &group)
	if group.ChatUrl == nil || *group.ChatUrl != "https://chat.example.test/vinyl" || group.Version != 2 {
		t.Fatalf("with chat = %+v", group)
	}
	response = doJSON(t, client, http.MethodPatch, groupURL, origin, csrf,
		map[string]any{"expectedVersion": 2, "description": "Plotter"})
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &group)
	if group.ChatUrl == nil || group.Description != "Plotter" {
		t.Fatalf("after description = %+v", group)
	}
	response = doJSON(t, client, http.MethodPatch, groupURL, origin, csrf,
		map[string]any{"expectedVersion": 3, "chatUrl": nil})
	assertStatus(t, response, http.StatusOK)
	var cleared openapi.WorkingGroup
	decodeResponse(t, response, &cleared)
	if cleared.ChatUrl != nil {
		t.Fatalf("cleared chat = %+v", cleared)
	}

	response = doJSON(t, client, http.MethodGet, api, "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var list openapi.WorkingGroupList
	decodeResponse(t, response, &list)
	if len(list.Items) != 1 || list.Items[0].Id != group.Id {
		t.Fatalf("list = %+v", list)
	}

	response = doJSON(t, client, http.MethodDelete, groupURL, origin, csrf, nil)
	assertStatus(t, response, http.StatusNoContent)
	response = doJSON(t, client, http.MethodGet, groupURL, "", "", nil)
	assertStatus(t, response, http.StatusNotFound)
	response.Body.Close()
}

func TestWorkingGroupsExcludeVisitors(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	service := workinggroups.NewService(pool)
	manager, _ := groupPrincipal(t, pool, "wg-visitor-manager", "working_groups.read", "working_groups.manage")
	member := insertGroupPerson(t, pool, "wg-visitor-member@example.test")
	guest := insertPlainPerson(t, pool, "wg-visitor-guest@example.test")
	assertCount(t, pool, `SELECT count(*) FROM person_roles pr JOIN roles r ON r.id = pr.role_id
		WHERE pr.person_id = $1 AND r.system_key = 'visitor'`, 1, guest)
	if _, err := service.Create(ctx, manager, workinggroups.CreateInput{Name: "Guests", LeadPersonID: guest}, nil); err == nil {
		t.Fatal("a visitor became lead on create")
	} else {
		requireAppError(t, err, http.StatusUnprocessableEntity, "person_not_eligible")
	}
	group, err := service.Create(ctx, manager, workinggroups.CreateInput{Name: "Members", LeadPersonID: member}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.AddMember(ctx, manager, group.ID, guest, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "person_not_eligible")
	_, err = service.SetLead(ctx, manager, group.ID, guest, nil)
	requireAppError(t, err, http.StatusUnprocessableEntity, "person_not_eligible")
	assertCount(t, pool, `SELECT count(*) FROM working_group_members WHERE person_id = $1`, 0, guest)
	people, err := service.FindPeople(ctx, manager, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, option := range people {
		if option.ID == guest {
			t.Fatal("the picker offers a visitor")
		}
	}
}

func TestWorkingGroupsCheckPermissionsBeforeInput(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	service := workinggroups.NewService(pool)
	manager, _ := groupPrincipal(t, pool, "wg-order-manager", "working_groups.read", "working_groups.manage")
	reader, _ := groupPrincipal(t, pool, "wg-order-reader", "working_groups.read")
	nobody, _ := groupPrincipal(t, pool, "wg-order-nobody", "machines.read")
	group, err := service.Create(ctx, manager, workinggroups.CreateInput{
		Name: "Order", LeadPersonID: insertGroupPerson(t, pool, "wg-order-lead@example.test"),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []authorization.Principal{reader, nobody} {
		_, err = service.AddPlace(ctx, p, group.ID, "  ", nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
		_, err = service.SetMachines(ctx, p, group.ID, []uuid.UUID{ids.New()}, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
		bad := strings.Repeat("x", 600)
		_, err = service.Update(ctx, p, group.ID, workinggroups.UpdateInput{ExpectedVersion: 1, Description: &bad}, nil)
		requireAppError(t, err, http.StatusForbidden, "permission_denied")
	}
}

func TestWorkingGroupLeadChangesAreAuditedAndFormerLeadLosesRights(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	service := workinggroups.NewService(pool)
	manager, _ := groupPrincipal(t, pool, "wg-audit-manager", "working_groups.read", "working_groups.manage")
	lead, leadAccount := groupPrincipal(t, pool, "wg-audit-lead", "working_groups.read")
	successor := insertGroupPerson(t, pool, "wg-audit-successor@example.test")
	extra := insertGroupPerson(t, pool, "wg-audit-extra@example.test")
	machine := insertWorkingGroupMachine(t, pool, "Audit lathe")
	group, err := service.Create(ctx, manager, workinggroups.CreateInput{Name: "Audit", LeadPersonID: leadAccount.personID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.AddMember(ctx, lead, group.ID, extra, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetMachines(ctx, lead, group.ID, []uuid.UUID{machine}, nil); err != nil {
		t.Fatal(err)
	}
	withPlace, err := service.AddPlace(ctx, lead, group.ID, "Bench", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.RemovePlace(ctx, lead, group.ID, withPlace.Places[0].ID, nil); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"working_group_member.added", "working_group_machines.changed", "working_group_place.removed"} {
		assertCount(t, pool,
			`SELECT count(*) FROM audit_events WHERE action = $1 AND actor_account_id = $2 AND resource_id = $3`,
			1, action, leadAccount.accountID, group.ID)
	}

	// After the lead moved to someone else the former lead is an ordinary member without edit rights.
	if _, err := service.SetLead(ctx, manager, group.ID, successor, nil); err != nil {
		t.Fatal(err)
	}
	text := "Still me"
	_, err = service.Update(ctx, lead, group.ID, workinggroups.UpdateInput{ExpectedVersion: 1, Description: &text}, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.AddMember(ctx, lead, group.ID, insertGroupPerson(t, pool, "wg-audit-late@example.test"), nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.SetMachines(ctx, lead, group.ID, nil, nil)
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
	_, err = service.FindPeople(ctx, lead, "")
	requireAppError(t, err, http.StatusForbidden, "permission_denied")
}

func TestPeopleMergeMovesWorkingGroupMemberships(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	actor, _ := groupPrincipal(t, pool, "wg-merge-actor", mergePermissions...)
	manager, _ := groupPrincipal(t, pool, "wg-merge-manager", "working_groups.read", "working_groups.manage")
	service := workinggroups.NewService(pool)
	target := insertGroupPerson(t, pool, "wg-merge-target@example.test")
	source := insertGroupPerson(t, pool, "wg-merge-source@example.test")
	other := insertGroupPerson(t, pool, "wg-merge-other@example.test")

	led, err := service.Create(ctx, manager, workinggroups.CreateInput{Name: "Led by source", LeadPersonID: source}, nil)
	if err != nil {
		t.Fatal(err)
	}
	sourceOnly, err := service.Create(ctx, manager, workinggroups.CreateInput{Name: "Source only", LeadPersonID: other}, nil)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := service.Create(ctx, manager, workinggroups.CreateInput{Name: "Shared", LeadPersonID: other}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, add := range []struct{ group, person uuid.UUID }{
		{led.ID, target}, {sourceOnly.ID, source}, {shared.ID, source}, {shared.ID, target},
	} {
		if _, err := service.AddMember(ctx, manager, add.group, add.person, nil); err != nil {
			t.Fatal(err)
		}
	}

	result, err := people.NewService(pool, nil).Merge(ctx, actor, people.MergeInput{
		MergeSelection:   people.MergeSelection{TargetPersonID: target, SourcePersonIDs: []uuid.UUID{source}},
		ExpectedVersions: mergeVersions(t, pool, target, source),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM working_group_members WHERE person_id = $1`, 0, source)
	assertCount(t, pool, `SELECT count(*) FROM working_group_members WHERE group_id = $1 AND person_id = $2 AND is_lead`, 1, led.ID, target)
	assertCount(t, pool, `SELECT count(*) FROM working_group_members WHERE group_id = $1`, 1, led.ID)
	assertCount(t, pool, `SELECT count(*) FROM working_group_members WHERE group_id = $1 AND person_id = $2 AND NOT is_lead`, 1, sourceOnly.ID, target)
	assertCount(t, pool, `SELECT count(*) FROM working_group_members WHERE group_id = $1 AND person_id = $2`, 1, shared.ID, target)
	// Two duplicates were dropped and one membership moved.
	var count int64
	for _, moved := range result.Moved {
		if moved.Category == people.MergedWorkingGroupMemberships {
			count = moved.Count
		}
	}
	if count != 3 {
		t.Fatalf("working group memberships merged = %d, want 3 (moved %+v)", count, result.Moved)
	}
}

func TestSubjectRequestWorkingGroupExportHoldsOnlyTheSubjectsMembership(t *testing.T) {
	pool := statementPool(t)
	ctx := testContext(t)
	service := workinggroups.NewService(pool)
	manager, _ := groupPrincipal(t, pool, "wg-export-manager", "working_groups.read", "working_groups.manage")
	subject := insertGroupPerson(t, pool, "wg-export-subject@example.test")
	colleague := insertGroupPerson(t, pool, "wg-export-colleague@example.test")
	group, err := service.Create(ctx, manager, workinggroups.CreateInput{Name: "Export", LeadPersonID: subject}, nil)
	if err != nil {
		t.Fatal(err)
	}
	chat := "https://chat.example.test/secret-room"
	if _, err := service.Update(ctx, manager, group.ID, workinggroups.UpdateInput{
		ExpectedVersion: 1, ChatURL: workinggroups.OptionalText{Set: true, Value: &chat},
	}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AddMember(ctx, manager, group.ID, colleague, nil); err != nil {
		t.Fatal(err)
	}
	queries := requestsdb.New(pool)
	count, err := queries.CountWorkingGroupMemberships(ctx, subject)
	if err != nil || count != 1 {
		t.Fatalf("count = %d, %v", count, err)
	}
	document, err := queries.ExportWorkingGroupMemberships(ctx, subject)
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	if err := json.Unmarshal(document, &rows); err != nil || len(rows) != 1 {
		t.Fatalf("export = %s, %v", document, err)
	}
	if rows[0]["group"] != "Export" || rows[0]["isLead"] != true || rows[0]["joinedAt"] == nil || len(rows[0]) != 3 {
		t.Fatalf("export row = %v", rows[0])
	}
	if strings.Contains(string(document), "secret-room") {
		t.Fatalf("export holds the chat link: %s", document)
	}
}
