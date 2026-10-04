package integration_test

import (
	"bytes"
	"errors"
	"io"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
)

func TestEventsLifecyclePublicPrivacyAssignmentsAndRetention(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	managerAccount := seedAccount(t, pool, "event-manager", true)
	manager := authorization.Principal{AccountID: managerAccount.accountID, PersonID: managerAccount.personID, Master: true}
	baseURL, _ := url.Parse("https://makerspace.example.test")
	localStore, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fileService := files.NewService(pool, localStore)
	service, err := events.NewService(pool, config.Config{MakerspaceTimeZone: "Europe/Vienna", PublicBaseURL: baseURL, ChallengeHMACKey: []byte("event-limiter-key")}, fileService)
	if err != nil {
		t.Fatal(err)
	}

	owner := manager.PersonID
	internal := "internal setup and supplier notes"
	event, err := service.Create(ctx, manager, events.EventInput{Name: "Autumn exhibition", InternalDescription: &internal, OwnerPersonID: &owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if event.Status != "draft" || event.Version != 1 || len(event.PublicID) != 43 {
		t.Fatalf("created event = %#v", event)
	}
	if _, err = service.GetPublic(ctx, event.PublicID); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("unpublished lookup error = %v, want not found", err)
	}

	start := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Minute)
	_, err = service.CreateSession(ctx, manager, event.ID, events.SessionInput{Name: stringPointer("Exhibition"), StartsAt: start, EndsAt: start.Add(6 * time.Hour), IsPublic: true, Status: "scheduled"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	shift, err := service.CreateShift(ctx, manager, event.ID, events.ShiftInput{Name: "Setup", StartsAt: start.Add(-2 * time.Hour), EndsAt: start.Add(-time.Hour), IsPublic: true, Status: "open"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	requirement, err := service.CreateRequirement(ctx, manager, event.ID, shift.ID, events.RequirementInput{Name: "Setup helper", RequiredCount: 1, EligibilityMode: "anyone"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	planning, err := service.Transition(ctx, manager, event.ID, event.Version, "planning", nil)
	if err != nil {
		t.Fatal(err)
	}
	publicTitle := "Open workshop exhibition"
	planning, err = service.Update(ctx, manager, event.ID, events.EventInput{Name: event.Name, InternalDescription: &internal, OwnerPersonID: &owner, PublicTitle: &publicTitle, PublicSignupEnabled: true, ExpectedVersion: planning.Version}, nil)
	if err != nil {
		t.Fatalf("configure signup before publication: %v", err)
	}
	published, err := service.SetPublished(ctx, manager, event.ID, planning.Version, true, nil)
	if err != nil {
		t.Fatal(err)
	}
	public, err := service.GetPublic(ctx, event.PublicID)
	if err != nil {
		t.Fatal(err)
	}
	if public.Title != publicTitle || public.Description != nil || len(public.Sessions) != 1 || len(public.Shifts) != 1 || len(public.Shifts[0].Requirements) != 1 {
		t.Fatalf("public DTO = %#v", public)
	}
	publicFile, err := service.AttachFile(ctx, manager, event.ID, "public-guide.pdf", "application/pdf", "public", false, stringPointer("Visitor guide"), []byte("%PDF-1.7\npublic guide"), nil)
	if err != nil {
		t.Fatal(err)
	}
	internalFile, err := service.AttachFile(ctx, manager, event.ID, "internal-notes.txt", "text/plain", "internal", false, nil, []byte("supplier notes\n"), nil)
	if err != nil {
		t.Fatal(err)
	}
	bannerBytes := []byte{'\x89', 'P', 'N', 'G', '\r', '\n', '\x1a', '\n', 0, 0, 0, 0}
	banner, err := service.AttachFile(ctx, manager, event.ID, "event-banner.png", "image/png", "public", true, nil, bannerBytes, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !banner.IsBanner {
		t.Fatal("uploaded Event banner was not designated as the banner")
	}
	if _, err = service.AttachFile(ctx, manager, event.ID, "not-a-banner.pdf", "application/pdf", "public", true, nil, []byte("%PDF-1.7\n"), nil); err == nil {
		t.Fatal("non-image Event banner was accepted")
	}
	public, err = service.GetPublic(ctx, event.PublicID)
	if err != nil || !public.HasBanner || len(public.Files) != 1 || public.Files[0].ID != publicFile.ID || public.Files[0].FileID != uuid.Nil {
		t.Fatalf("public files = %#v, err=%v", public.Files, err)
	}
	openedBanner, bannerReader, err := service.OpenPublicBanner(ctx, event.PublicID)
	if err != nil {
		t.Fatal(err)
	}
	bannerContents, readBannerErr := io.ReadAll(bannerReader)
	closeBannerErr := bannerReader.Close()
	if readBannerErr != nil || closeBannerErr != nil || openedBanner.ContentType != "image/png" || !bytes.Equal(bannerContents, bannerBytes) {
		t.Fatalf("public banner opened=%#v contents=%q read=%v close=%v", openedBanner, bannerContents, readBannerErr, closeBannerErr)
	}
	if _, _, _, err = service.OpenPublicFile(ctx, event.PublicID, internalFile.ID); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("private public-file lookup error = %v", err)
	}
	_, opened, reader, err := service.OpenPublicFile(ctx, event.PublicID, publicFile.ID)
	if err != nil {
		t.Fatal(err)
	}
	contents, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil || opened.OriginalFilename != "public-guide.pdf" || !bytes.Contains(contents, []byte("public guide")) {
		t.Fatalf("public file opened=%#v contents=%q read=%v close=%v", opened, contents, readErr, closeErr)
	}

	email := "external.helper@example.test"
	first, err := service.SignupAnonymous(ctx, event.PublicID, "192.0.2.10", events.AssignmentInput{ShiftID: shift.ID, RequirementID: requirement.ID, FirstName: "External", LastName: "Helper", Email: &email}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.ManagementURL == nil || first.Assignment.PublicID != event.PublicID || first.Assignment.PersonID != nil || first.Assignment.Source != "public_signup" {
		t.Fatalf("anonymous signup = %#v", first)
	}
	token := strings.TrimPrefix(strings.SplitN(*first.ManagementURL, "#token=", 2)[1], " ")
	var storedDigest []byte
	if err = pool.QueryRow(ctx, `SELECT management_token_digest FROM event_shift_assignments WHERE id=$1`, first.Assignment.ID).Scan(&storedDigest); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(storedDigest, security.DigestToken(token)) || bytes.Contains(storedDigest, []byte(token)) {
		t.Fatal("management token was not stored exclusively as its digest")
	}
	if _, err = service.SignupAnonymous(ctx, event.PublicID, "192.0.2.11", events.AssignmentInput{ShiftID: shift.ID, RequirementID: requirement.ID, FirstName: "Duplicate", LastName: "Helper", Email: &email}, nil); !apperror.IsCode(err, "signup_unavailable") {
		t.Fatalf("duplicate error = %v", err)
	}
	updatedEmail := "event-only-contact@example.test"
	managed, err := service.UpdateManagedSignup(ctx, token, events.AssignmentUpdateInput{FirstName: "External", LastName: "Helper", Email: &updatedEmail, ExpectedVersion: first.Assignment.Version}, nil)
	if err != nil || managed.PublicID != event.PublicID || managed.Version != first.Assignment.Version+1 {
		t.Fatalf("managed update = %#v, err=%v", managed, err)
	}
	if _, err = service.UpdateManagedSignup(ctx, token, events.AssignmentUpdateInput{FirstName: "External", LastName: "Helper", Email: &updatedEmail, ExpectedVersion: first.Assignment.Version}, nil); !errors.Is(err, apperror.StaleWrite) {
		t.Fatalf("stale managed update error = %v", err)
	}
	if _, err = service.GetManagedSignup(ctx, token+"x"); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("invalid token error = %v", err)
	}
	moveShift, err := service.CreateShift(ctx, manager, event.ID, events.ShiftInput{Name: "Visitor support", StartsAt: start.Add(4 * time.Hour), EndsAt: start.Add(5 * time.Hour), IsPublic: true, Status: "open"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	moveReq, err := service.CreateRequirement(ctx, manager, event.ID, moveShift.ID, events.RequirementInput{Name: "Visitor helper", RequiredCount: 2, EligibilityMode: "anyone"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	managed, err = service.UpdateManagedSignup(ctx, token, events.AssignmentUpdateInput{ShiftID: &moveShift.ID, RequirementID: &moveReq.ID, ExpectedVersion: managed.Version}, nil)
	if err != nil || managed.ShiftID != moveShift.ID || managed.RequirementID != moveReq.ID || managed.PublicID != event.PublicID {
		t.Fatalf("managed move = %#v, err=%v", managed, err)
	}
	managed, err = service.UpdateManagedSignup(ctx, token, events.AssignmentUpdateInput{ShiftID: &shift.ID, RequirementID: &requirement.ID, ExpectedVersion: managed.Version}, nil)
	if err != nil || managed.ShiftID != shift.ID || managed.RequirementID != requirement.ID {
		t.Fatalf("managed move back = %#v, err=%v", managed, err)
	}

	matchPersonID := uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO people(id,first_name,last_name,email) VALUES($1,'Matching','Person',$2)`, matchPersonID, updatedEmail); err != nil {
		t.Fatal(err)
	}
	matches, err := service.FindAssignmentPersonMatches(ctx, manager, event.ID, managed.ID)
	if err != nil || len(matches) != 1 || matches[0].ID != matchPersonID {
		t.Fatalf("exact matches = %#v, err=%v", matches, err)
	}
	linked, err := service.LinkAssignmentPerson(ctx, manager, event.ID, managed.ID, matchPersonID, managed.Version, nil)
	if err != nil || linked.PersonID == nil || *linked.PersonID != matchPersonID || linked.Email == nil || *linked.Email != updatedEmail {
		t.Fatalf("linked assignment = %#v, err=%v", linked, err)
	}

	overlapShift, err := service.CreateShift(ctx, manager, event.ID, events.ShiftInput{Name: "Overlapping setup", StartsAt: start.Add(-90 * time.Minute), EndsAt: start.Add(-30 * time.Minute), IsPublic: true, Status: "open"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	overlapReq, err := service.CreateRequirement(ctx, manager, event.ID, overlapShift.ID, events.RequirementInput{Name: "Second helper", RequiredCount: 2, EligibilityMode: "anyone"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.SignupAnonymous(ctx, event.PublicID, "192.0.2.12", events.AssignmentInput{ShiftID: overlapShift.ID, RequirementID: overlapReq.ID, FirstName: "External", LastName: "Helper", Email: &updatedEmail}, nil); !apperror.IsCode(err, "signup_unavailable") {
		t.Fatalf("overlap error = %v", err)
	}
	staffOverride, err := service.CreateStaffAssignment(ctx, manager, event.ID, events.AssignmentInput{ShiftID: overlapShift.ID, RequirementID: overlapReq.ID, PersonID: &matchPersonID, OverrideConflict: true}, nil)
	if err != nil || staffOverride.ConflictOverriddenByAccountID == nil {
		t.Fatalf("staff conflict override = %#v, err=%v", staffOverride, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE resource_id=$1 AND action='event_assignment.conflict_overridden'`, 1, staffOverride.ID)

	restrictedRoleID := uuid.Must(uuid.NewV7())
	if _, err = pool.Exec(ctx, `INSERT INTO roles(id,name) VALUES($1,'Temporary event role'); INSERT INTO person_roles(person_id,role_id) VALUES($2,$1)`, restrictedRoleID, manager.PersonID); err != nil {
		t.Fatal(err)
	}
	restrictedShift, err := service.CreateShift(ctx, manager, event.ID, events.ShiftInput{Name: "Role-only booth", StartsAt: start.Add(7 * time.Hour), EndsAt: start.Add(8 * time.Hour), IsPublic: true, Status: "open"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	restrictedReq, err := service.CreateRequirement(ctx, manager, event.ID, restrictedShift.ID, events.RequirementInput{Name: "Specialist", RequiredCount: 2, EligibilityMode: "roles", EligibleRoleIDs: []uuid.UUID{restrictedRoleID}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.SignupAnonymous(ctx, event.PublicID, "192.0.2.13", events.AssignmentInput{ShiftID: restrictedShift.ID, RequirementID: restrictedReq.ID, FirstName: "Anonymous", LastName: "Specialist", Email: stringPointer("anonymous.specialist@example.test")}, nil); !apperror.IsCode(err, "signup_unavailable") {
		t.Fatalf("anonymous role-restricted error = %v", err)
	}
	if _, err = service.CreateStaffAssignment(ctx, manager, event.ID, events.AssignmentInput{ShiftID: restrictedShift.ID, RequirementID: restrictedReq.ID, FirstName: "External", LastName: "Specialist", Email: stringPointer("staff.external@example.test")}, nil); !apperror.IsCode(err, "signup_unavailable") {
		t.Fatalf("external role-restricted staff error = %v", err)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM roles WHERE id=$1`, restrictedRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err = service.SignupAuthenticated(ctx, manager, event.PublicID, "192.0.2.14", "self", events.AssignmentInput{ShiftID: restrictedShift.ID, RequirementID: restrictedReq.ID, FirstName: "Test", LastName: "Person", Email: stringPointer("event-manager@example.test")}, nil); !apperror.IsCode(err, "signup_unavailable") {
		t.Fatalf("deleted-role eligibility error = %v", err)
	}

	selfShift, err := service.CreateShift(ctx, manager, event.ID, events.ShiftInput{Name: "Teardown", StartsAt: start.Add(9 * time.Hour), EndsAt: start.Add(10 * time.Hour), IsPublic: true, Status: "open"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	selfReq, err := service.CreateRequirement(ctx, manager, event.ID, selfShift.ID, events.RequirementInput{Name: "Teardown helper", RequiredCount: 2, EligibilityMode: "anyone"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	selfContact := "event-specific@example.test"
	self, err := service.SignupAuthenticated(ctx, manager, event.PublicID, "192.0.2.15", "self", events.AssignmentInput{ShiftID: selfShift.ID, RequirementID: selfReq.ID, FirstName: "Event", LastName: "Volunteer", Email: &selfContact}, nil)
	if err != nil || self.Assignment.PersonID == nil || self.Assignment.Email == nil || *self.Assignment.Email != selfContact {
		t.Fatalf("authenticated self signup = %#v, err=%v", self, err)
	}

	capacityShift, err := service.CreateShift(ctx, manager, event.ID, events.ShiftInput{Name: "Final slot", StartsAt: start.Add(11 * time.Hour), EndsAt: start.Add(12 * time.Hour), IsPublic: true, Status: "open"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	capacityReq, err := service.CreateRequirement(ctx, manager, event.ID, capacityShift.ID, events.RequirementInput{Name: "One place", RequiredCount: 1, EligibilityMode: "anyone"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	errorsByAttempt := make(chan error, 2)
	for index := 0; index < 2; index++ {
		index := index
		wait.Add(1)
		go func() {
			defer wait.Done()
			contact := "capacity-" + string(rune('a'+index)) + "@example.test"
			_, signupErr := service.SignupAnonymous(ctx, event.PublicID, "192.0.2."+string(rune('2'+index)), events.AssignmentInput{ShiftID: capacityShift.ID, RequirementID: capacityReq.ID, FirstName: "Capacity", LastName: "Helper", Email: &contact}, nil)
			errorsByAttempt <- signupErr
		}()
	}
	wait.Wait()
	close(errorsByAttempt)
	successes, unavailable := 0, 0
	for signupErr := range errorsByAttempt {
		if signupErr == nil {
			successes++
		} else if apperror.IsCode(signupErr, "signup_unavailable") {
			unavailable++
		} else {
			t.Fatalf("concurrent signup error = %v", signupErr)
		}
	}
	if successes != 1 || unavailable != 1 {
		t.Fatalf("concurrent outcomes successes=%d unavailable=%d", successes, unavailable)
	}
	assertCount(t, pool, `SELECT count(*) FROM event_shift_assignments WHERE requirement_id=$1 AND status='active'`, 1, capacityReq.ID)

	cancellationShift, err := service.CreateShift(ctx, manager, event.ID, events.ShiftInput{Name: "Cleanup", StartsAt: start.Add(13 * time.Hour), EndsAt: start.Add(14 * time.Hour), IsPublic: true, Status: "open"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	cancellationReq, err := service.CreateRequirement(ctx, manager, event.ID, cancellationShift.ID, events.RequirementInput{Name: "Cleanup helper", RequiredCount: 1, EligibilityMode: "anyone"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	cancellable, err := service.SignupAnonymous(ctx, event.PublicID, "192.0.2.25", events.AssignmentInput{ShiftID: cancellationShift.ID, RequirementID: cancellationReq.ID, FirstName: "Cancel", LastName: "Helper", Email: stringPointer("cancel-helper@example.test")}, nil)
	if err != nil || cancellable.ManagementURL == nil {
		t.Fatalf("cancellable signup = %#v, err=%v", cancellable, err)
	}
	cancelToken := strings.SplitN(*cancellable.ManagementURL, "#token=", 2)[1]
	cancelled, err := service.CancelManagedSignup(ctx, cancelToken, cancellable.Assignment.Version, nil)
	if err != nil || cancelled.Status != "cancelled" || cancelled.PublicID != event.PublicID {
		t.Fatalf("managed cancellation = %#v, err=%v", cancelled, err)
	}
	if current, currentErr := service.GetManagedSignup(ctx, cancelToken); currentErr != nil || current.Status != "cancelled" {
		t.Fatalf("cancelled managed lookup = %#v, err=%v", current, currentErr)
	}
	if _, err = service.UpdateManagedSignup(ctx, cancelToken, events.AssignmentUpdateInput{FirstName: "Cannot", LastName: "Reactivate", Email: stringPointer("cancel-helper@example.test"), ExpectedVersion: cancelled.Version}, nil); !errors.Is(err, apperror.Conflict) {
		t.Fatalf("cancelled managed update error = %v", err)
	}

	if err = people.NewService(pool, nil).Delete(ctx, manager, matchPersonID, 1, nil); err != nil {
		t.Fatalf("delete linked Person: %v", err)
	}
	var linkedPerson *uuid.UUID
	var linkedName *string
	var linkedToken []byte
	if err = pool.QueryRow(ctx, `SELECT person_id,first_name_snapshot,management_token_digest FROM event_shift_assignments WHERE id=$1`, linked.ID).Scan(&linkedPerson, &linkedName, &linkedToken); err != nil {
		t.Fatal(err)
	}
	if linkedPerson != nil || linkedName != nil || linkedToken != nil {
		t.Fatal("Person deletion did not scrub and unlink the Event assignment")
	}
	if _, err = service.GetManagedSignup(ctx, token); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("scrubbed management token error = %v", err)
	}

	confirmed, err := service.Transition(ctx, manager, event.ID, published.Version, "confirmed", nil)
	if err != nil {
		t.Fatal(err)
	}
	completed, err := service.Transition(ctx, manager, event.ID, confirmed.Version, "completed", nil)
	if err != nil {
		t.Fatal(err)
	}
	public, err = service.GetPublic(ctx, event.PublicID)
	if err != nil || public.PublicSignupEnabled {
		t.Fatalf("completed public event = %#v, err=%v", public, err)
	}
	postEventDescription := "Final visitor guide"
	publicFile, err = service.UpdateFile(ctx, manager, event.ID, publicFile.ID, publicFile.Version, "public", nil, &postEventDescription, nil)
	if err != nil {
		t.Fatalf("post-event file update: %v", err)
	}
	if err = service.RemoveFile(ctx, manager, event.ID, internalFile.ID, internalFile.Version, nil); err != nil {
		t.Fatalf("post-event file removal: %v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM files WHERE id=$1`, 0, internalFile.FileID)
	if _, err = pool.Exec(ctx, `UPDATE events SET closed_at=now()-interval '200 days' WHERE id=$1`, event.ID); err != nil {
		t.Fatal(err)
	}
	erased, err := events.EraseExpiredSignupData(ctx, pool, time.Now().UTC().Add(-180*24*time.Hour))
	// The two assignments linked to matchPersonID were already erased by the
	// Person-deletion hook; cleanup erases the remaining self, capacity, and
	// cancelled external rows.
	if err != nil || erased != 3 {
		t.Fatalf("retention erased=%d err=%v", erased, err)
	}
	var retainedPerson *uuid.UUID
	var erasedEmail *string
	if err = pool.QueryRow(ctx, `SELECT person_id,email_snapshot FROM event_shift_assignments WHERE id=$1`, self.Assignment.ID).Scan(&retainedPerson, &erasedEmail); err != nil {
		t.Fatal(err)
	}
	if retainedPerson == nil || *retainedPerson != manager.PersonID || erasedEmail != nil {
		t.Fatalf("retention result person=%v email=%v", retainedPerson, erasedEmail)
	}
	var auditText string
	if err = pool.QueryRow(ctx, `SELECT COALESCE(string_agg(action || ' ' || metadata::text, ' '),'') FROM audit_events WHERE resource_type LIKE 'event%'`).Scan(&auditText); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{email, updatedEmail, selfContact, token} {
		if strings.Contains(auditText, secret) {
			t.Fatalf("audit data contains private value %q", secret)
		}
	}
	archived, err := service.Transition(ctx, manager, event.ID, completed.Version, "archived", nil)
	if err != nil || archived.IsPublic || !archived.PublicSignupEnabled {
		t.Fatalf("archived event = %#v, err=%v", archived, err)
	}
	if _, err = service.GetPublic(ctx, event.PublicID); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("archived public lookup error = %v", err)
	}
	if _, err = service.SetPublished(ctx, manager, event.ID, archived.Version, false, nil); !apperror.IsCode(err, "event_read_only") {
		t.Fatalf("archived publication error = %v", err)
	}
	if _, err = service.RotatePublicID(ctx, manager, event.ID, archived.Version, nil); !apperror.IsCode(err, "event_read_only") {
		t.Fatalf("archived public-ID rotation error = %v", err)
	}
	if _, err = service.UpdateFile(ctx, manager, event.ID, publicFile.ID, publicFile.Version, "public", nil, &postEventDescription, nil); !apperror.IsCode(err, "event_read_only") {
		t.Fatalf("archived file update error = %v", err)
	}
}

func stringPointer(value string) *string { return &value }
