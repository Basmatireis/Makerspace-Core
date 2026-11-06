package integration_test

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/visitor"
	"github.com/google/uuid"
)

func TestControlledVisitorEnrollmentAndAdmission(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)

	masterAccountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Visitor", LastName: "Administrator", LoginEmail: "visitor-admin-login@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	var masterPersonID uuid.UUID
	if err := pool.QueryRow(
		ctx,
		`SELECT person_id FROM accounts WHERE id=$1`,
		masterAccountID,
	).Scan(&masterPersonID); err != nil {
		t.Fatal(err)
	}
	master := authorization.Principal{
		AccountID: masterAccountID, PersonID: masterPersonID, Master: true,
		Assurance: authorization.AssuranceNormal, AuthenticatedAt: time.Now().UTC(),
	}

	// Enrolled visitors hold the Visitor membership role; its behaviours decide Lab Rules and photo.
	var roleID uuid.UUID
	if err := pool.QueryRow(
		ctx,
		`UPDATE roles SET laborordnung_mode='blocking', profile_image_required=true WHERE system_key='visitor' RETURNING id`,
	).Scan(&roleID); err != nil {
		t.Fatal(err)
	}
	insertPublishedLabRulesVersion(t, pool, masterAccountID, "2026-visitor")

	deviceService := manageddevices.NewService(pool)
	kioskType, err := deviceService.CreateType(ctx, master, "Visitor terminal", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	kiosk, err := deviceService.Create(ctx, master, "Front desk", kioskType.ID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	otherType, err := deviceService.CreateType(ctx, master, "Unapproved terminal", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	otherDevice, err := deviceService.Create(ctx, master, "Back office", otherType.ID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}

	localStore, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fileService := files.NewService(pool, localStore)
	labRulesService := laborordnung.NewService(pool, inbox.NewEmitter(), fileService)
	notifier := newNotificationRecorder()
	service := visitor.NewService(pool, cfg, fileService, labRulesService, notifier)

	if _, err := service.GetConfiguration(ctx, authorization.Principal{}); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("permission-less configuration read error=%v", err)
	}
	configuration, err := service.UpdateConfiguration(ctx, master, visitor.ConfigurationInput{
		Enabled: true, DeviceTypeIDs: []uuid.UUID{kioskType.ID},
		AllowedMethods: []visitor.AuthMethod{"pin", "password", "pin"}, ExpectedVersion: 1,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if configuration.Version != 2 || len(configuration.AllowedMethods) != 2 || len(configuration.DeviceTypeIDs) != 1 {
		t.Fatalf("unexpected visitor configuration: %#v", configuration)
	}

	approvedContext := manageddevices.DeviceContext{
		ID: kiosk.Device.ID, Name: kiosk.Device.Name, DeviceTypeID: kiosk.Device.DeviceTypeID,
		DeviceTypeName: kiosk.Device.DeviceTypeName,
	}
	unapprovedContext := manageddevices.DeviceContext{
		ID: otherDevice.Device.ID, Name: otherDevice.Device.Name, DeviceTypeID: otherDevice.Device.DeviceTypeID,
		DeviceTypeName: otherDevice.Device.DeviceTypeName,
	}
	if _, err := service.Begin(ctx, unapprovedContext); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unapproved device begin error=%v", err)
	}

	issue, err := service.Begin(ctx, approvedContext)
	if err != nil {
		t.Fatal(err)
	}
	enrollment, err := service.AuthenticateContext(ctx, issue.ContextToken)
	if err != nil {
		t.Fatal(err)
	}
	if err := visitor.ValidateCSRF(enrollment, issue.CSRFToken, issue.CSRFToken); err != nil {
		t.Fatal(err)
	}
	if err := visitor.ValidateCSRF(enrollment, issue.CSRFToken, "wrong-token"); !apperror.IsCode(err, "csrf_invalid") {
		t.Fatalf("invalid enrollment CSRF error=%v", err)
	}
	state, err := service.State(ctx, enrollment)
	if err != nil || state.CurrentLabRules == nil || state.CurrentLabRules.HumanRevision != "2026-visitor" {
		t.Fatalf("visitor state=%#v err=%v", state, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM people`, 1)
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_confirmations`, 0)

	email := "new-visitor@example.test"
	loginName := "Visitor.One"
	pin := "654321"
	result, err := service.Submit(ctx, enrollment, visitor.SubmissionInput{
		FirstName: "New", LastName: "Visitor", Email: &email,
		AuthMethods: []visitor.AuthMethod{"pin"}, PINLoginName: &loginName, PIN: &pin,
		ProfileImage: visitorTestJPEG(t), ProfileImageFilename: "camera.jpg", LabRulesAccepted: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.AccountStatus != "enabled" || result.Admission != "admitted" || result.Attendance != "checked_in" {
		t.Fatalf("unexpected enrollment result: %#v", result)
	}
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM people WHERE id=$1 AND profile_image_file_id IS NOT NULL AND profile_image_source='terminal_capture'`,
		1,
		result.PersonID,
	)
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM accounts WHERE id=$1 AND person_id=$2 AND status='enabled' AND provisioning_source='visitor'`,
		1,
		result.AccountID,
		result.PersonID,
	)
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM person_roles WHERE person_id=$1 AND role_id=$2`,
		1,
		result.PersonID,
		roleID,
	)
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='pin' AND identifier_display=$2 AND identifier_normalized='visitor.one'`,
		1,
		result.AccountID,
		loginName,
	)
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='oidc'`,
		0,
		result.AccountID,
	)
	// The visitor's email is the account's login email even for a PIN-only enrollment.
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='password' AND identifier_normalized=$2`,
		1,
		result.AccountID,
		email,
	)
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM laborordnung_confirmations WHERE person_id=$1 AND method='enrollment' AND confirmed_by_account_id IS NULL`,
		1,
		result.PersonID,
	)

	if _, err := service.AuthenticateContext(ctx, issue.ContextToken); !apperror.IsCode(err, "unauthenticated") {
		t.Fatalf("consumed enrollment context error=%v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM people`, 2)

	authService, err := auth.NewService(pool, cfg, notifier)
	if err != nil {
		t.Fatal(err)
	}
	session, err := authService.LoginWithPIN(ctx, "VISITOR.ONE", pin, "visitor-terminal", nil)
	if err != nil {
		t.Fatal(err)
	}
	authenticated, err := authService.Authenticate(ctx, session.Token)
	if err != nil || authenticated.Principal.AccountID != result.AccountID ||
		authenticated.Principal.Assurance != authorization.AssuranceLow {
		t.Fatalf("visitor PIN authentication=%#v err=%v", authenticated.Principal, err)
	}
	if _, err := labRulesService.Evaluate(ctx, result.PersonID); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_confirmations WHERE person_id=$1`, 1, result.PersonID)

	admissionPrincipal := authenticated.Principal
	admissionPrincipal.Device = &authorization.ManagedDevice{
		ID: kiosk.Device.ID, Name: kiosk.Device.Name, DeviceTypeID: kiosk.Device.DeviceTypeID,
		DeviceTypeName: kiosk.Device.DeviceTypeName,
	}
	admitted, err := service.Admission(ctx, admissionPrincipal)
	if err != nil || admitted.Decision != "admitted" || admitted.Status.ActionRequired {
		t.Fatalf("confirmed admission=%#v err=%v", admitted, err)
	}

	passwordIssue, err := service.Begin(ctx, approvedContext)
	if err != nil {
		t.Fatal(err)
	}
	passwordContext, err := service.AuthenticateContext(ctx, passwordIssue.ContextToken)
	if err != nil {
		t.Fatal(err)
	}
	passwordEmail := "password-visitor@example.test"
	passwordResult, err := service.Submit(ctx, passwordContext, visitor.SubmissionInput{
		FirstName: "Password", LastName: "Visitor", Email: &passwordEmail,
		AuthMethods: []visitor.AuthMethod{"password"}, ProfileImage: visitorTestJPEG(t),
		ProfileImageFilename: "password-visitor.jpg", LabRulesAccepted: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if passwordResult.AccountStatus != "enabled" || passwordResult.InvitationDelivery == nil ||
		*passwordResult.InvitationDelivery != "sent" {
		t.Fatalf("password-only visitor result=%#v", passwordResult)
	}
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM password_credentials pc JOIN auth_identities i ON i.id=pc.auth_identity_id WHERE i.account_id=$1`,
		0,
		passwordResult.AccountID,
	)
	invitationCode := notifier.invitationCode(passwordEmail)
	if invitationCode == "" {
		t.Fatal("visitor invitation code was not delivered")
	}
	if err := authService.CompleteInvitation(
		ctx,
		passwordEmail,
		invitationCode,
		"Visitor password workshop 94",
		"visitor-invitation",
		nil,
	); err != nil {
		t.Fatal(err)
	}
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM accounts WHERE id=$1 AND status='enabled' AND administratively_disabled_at IS NULL`,
		1,
		passwordResult.AccountID,
	)
	passwordSession, err := loginSession(authService.Login(
		ctx,
		passwordEmail,
		"Visitor password workshop 94",
		"visitor-password-login",
		nil,
	))
	if err != nil {
		t.Fatal(err)
	}
	passwordAuthenticated, err := authService.Authenticate(ctx, passwordSession.Token)
	if err != nil || passwordAuthenticated.Principal.AccountID != passwordResult.AccountID ||
		passwordAuthenticated.Principal.Assurance != authorization.AssuranceNormal {
		t.Fatalf("visitor password authentication=%#v err=%v", passwordAuthenticated.Principal, err)
	}

	duplicateIssue, err := service.Begin(ctx, approvedContext)
	if err != nil {
		t.Fatal(err)
	}
	duplicateContext, err := service.AuthenticateContext(ctx, duplicateIssue.ContextToken)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Submit(ctx, duplicateContext, visitor.SubmissionInput{
		FirstName: "Duplicate", LastName: "Visitor", Email: &email,
		AuthMethods: []visitor.AuthMethod{"pin"}, PINLoginName: &loginName, PIN: &pin,
		ProfileImage: visitorTestJPEG(t), ProfileImageFilename: "duplicate.jpg", LabRulesAccepted: true,
	}, nil)
	if !apperror.IsCode(err, "authentication_identifier_exists") {
		t.Fatalf("duplicate identifier error=%v", err)
	}
	assertCount(t, pool, `SELECT count(*) FROM people`, 3)
	assertCount(t, pool, `SELECT count(*) FROM accounts`, 3)
	assertCount(t, pool, `SELECT count(*) FROM files WHERE original_filename='duplicate.jpg'`, 0)
	if _, err := service.AuthenticateContext(ctx, duplicateIssue.ContextToken); err != nil {
		t.Fatalf("failed submission should not consume its context: %v", err)
	}
}

func visitorTestJPEG(t *testing.T) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 32, 24))
	for y := 0; y < picture.Bounds().Dy(); y++ {
		for x := 0; x < picture.Bounds().Dx(); x++ {
			picture.SetRGBA(x, y, color.RGBA{R: uint8(x * 7), G: uint8(y * 9), B: 120, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, picture, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

func TestVisitorEnrollmentPinsPresentedLabRules(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	actor := seedAccount(t, pool, "pinned-rules-admin", true)
	master := authorization.Principal{AccountID: actor.accountID, PersonID: actor.personID, Master: true}
	local, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fileService := files.NewService(pool, local)
	labRules := laborordnung.NewService(pool, inbox.NewEmitter(), fileService)
	service := visitor.NewService(pool, integrationConfig(t), fileService, labRules, nil)
	publish := func(revision string) uuid.UUID {
		stored, err := fileService.StoreSystemBytes(ctx, revision+".pdf", "application/pdf", []byte(revision), nil)
		if err != nil {
			t.Fatal(err)
		}
		id := ids.New()
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO laborordnung_versions(id,human_revision,pdf_file_id,pdf_sha256) VALUES($1,$2,$3,$4)`,
			id,
			revision,
			stored.ID,
			stored.SHA256[:],
		); err != nil {
			t.Fatal(err)
		}
		if _, err := labRules.Publish(ctx, master, id, time.Now().Add(-time.Second), nil); err != nil {
			t.Fatal(err)
		}
		return id
	}
	original := publish("original")
	if _, err := pool.Exec(ctx, `UPDATE roles SET laborordnung_mode='blocking' WHERE system_key='visitor'`); err != nil {
		t.Fatal(err)
	}
	devices := manageddevices.NewService(pool)
	deviceType, err := devices.CreateType(ctx, master, "Pinned terminal", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	device, err := devices.Create(ctx, master, "Pinned terminal", deviceType.ID, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateConfiguration(
		ctx,
		master,
		visitor.ConfigurationInput{
			Enabled:         true,
			DeviceTypeIDs:   []uuid.UUID{deviceType.ID},
			AllowedMethods:  []visitor.AuthMethod{"pin"},
			ExpectedVersion: 1,
		},
		nil,
	); err != nil {
		t.Fatal(err)
	}
	issue, err := service.Begin(ctx, manageddevices.DeviceContext{ID: device.Device.ID, DeviceTypeID: deviceType.ID})
	if err != nil {
		t.Fatal(err)
	}
	enrollment, err := service.AuthenticateContext(ctx, issue.ContextToken)
	if err != nil {
		t.Fatal(err)
	}
	assertCount(
		t,
		pool,
		`SELECT count(*) FROM visitor_enrollment_contexts WHERE id=$1 AND lab_rules_version_id=$2`,
		1,
		enrollment.ID,
		original,
	)
	newer := publish("newer")
	state, err := service.State(ctx, enrollment)
	if err != nil || state.CurrentLabRules == nil || state.CurrentLabRules.ID != original {
		t.Fatalf("pinned state: %#v %v", state, err)
	}
	_, reader, err := service.OpenLabRules(ctx, enrollment)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || string(data) != "original" {
		t.Fatalf("PDF switched version: %q %v", data, err)
	}
	email, login, pin := "pinned@example.test", "pinned.visitor", "654321"
	result, err := service.Submit(
		ctx,
		enrollment,
		visitor.SubmissionInput{
			FirstName:        "Pinned",
			LastName:         "Visitor",
			Email:            &email,
			AuthMethods:      []visitor.AuthMethod{"pin"},
			PINLoginName:     &login,
			PIN:              &pin,
			ProfileImage:     visitorTestJPEG(t),
			LabRulesAccepted: true,
		},
		nil,
	)
	// The visitor accepted the pinned version, which is no longer in effect: nothing is created and the kiosk starts
	// over with the new version.
	if !apperror.IsCode(err, "lab_rules_changed") {
		t.Fatalf("submission after a newer version took effect: %#v %v", result, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE first_name='Pinned'`, 0)
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_confirmations`, 0)
	if _, err := service.AuthenticateContext(ctx, issue.ContextToken); err != nil {
		t.Fatalf("a refused submission must not consume the context: %v", err)
	}
	if current, err := labRules.CurrentVersion(ctx); err != nil || current.ID != newer {
		t.Fatalf("current version: %#v %v", current, err)
	}
}

func TestVisitorEnrollmentChecksTheVisitorIn(t *testing.T) {
	for _, mode := range []string{"blocking", "warning", "not_required"} {
		t.Run(mode, func(t *testing.T) {
			pool := migratedPool(t)
			ctx := testContext(t)
			actor := seedAccount(t, pool, "enroll-checkin-admin", true)
			master := authorization.Principal{AccountID: actor.accountID, PersonID: actor.personID, Master: true}
			local, err := storage.NewLocal(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			fileService := files.NewService(pool, local)
			labRules := laborordnung.NewService(pool, inbox.NewEmitter(), fileService)
			attendanceService := attendance.NewService(pool, nil, labRules, nil)
			service := visitor.NewService(pool, integrationConfig(t), fileService, labRules, nil)
			service.SetAttendance(attendanceService)
			stored, err := fileService.StoreSystemBytes(ctx, "rules.pdf", "application/pdf", []byte("rules"), nil)
			if err != nil {
				t.Fatal(err)
			}
			versionID := ids.New()
			if _, err = pool.Exec(
				ctx,
				`INSERT INTO laborordnung_versions(id,human_revision,pdf_file_id,pdf_sha256) VALUES($1,'2026.1',$2,$3)`,
				versionID, stored.ID, stored.SHA256[:],
			); err != nil {
				t.Fatal(err)
			}
			if _, err = labRules.Publish(ctx, master, versionID, time.Now().Add(-time.Second), nil); err != nil {
				t.Fatal(err)
			}
			if _, err = pool.Exec(
				ctx, `UPDATE roles SET laborordnung_mode=$1 WHERE system_key='visitor'`, mode,
			); err != nil {
				t.Fatal(err)
			}
			devices := manageddevices.NewService(pool)
			deviceType, err := devices.CreateType(ctx, master, "Enrollment terminal", nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			device, err := devices.Create(ctx, master, "Enrollment terminal", deviceType.ID, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = service.UpdateConfiguration(ctx, master, visitor.ConfigurationInput{
				Enabled: true, DeviceTypeIDs: []uuid.UUID{deviceType.ID},
				AllowedMethods: []visitor.AuthMethod{"pin"}, ExpectedVersion: 1,
			}, nil); err != nil {
				t.Fatal(err)
			}
			deviceContext := manageddevices.DeviceContext{ID: device.Device.ID, DeviceTypeID: deviceType.ID}
			issue, err := service.Begin(ctx, deviceContext)
			if err != nil {
				t.Fatal(err)
			}
			enrollment, err := service.AuthenticateContext(ctx, issue.ContextToken)
			if err != nil {
				t.Fatal(err)
			}
			email, login, pin := "arriving@example.test", "arriving.visitor", "654321"
			if mode != "not_required" {
				_, err = service.Submit(ctx, enrollment, visitor.SubmissionInput{
					FirstName: "Arriving", LastName: "Visitor", Email: &email,
					AuthMethods: []visitor.AuthMethod{"pin"}, PINLoginName: &login, PIN: &pin,
					ProfileImage: visitorTestJPEG(t),
				}, nil)
				if !apperror.IsCode(err, "validation_failed") {
					t.Fatalf("enrollment without accepting the Lab Rules error=%v, want validation_failed", err)
				}
				assertCount(t, pool, `SELECT count(*) FROM visits`, 0)
			}
			result, err := service.Submit(ctx, enrollment, visitor.SubmissionInput{
				FirstName: "Arriving", LastName: "Visitor", Email: &email,
				AuthMethods: []visitor.AuthMethod{"pin"}, PINLoginName: &login, PIN: &pin,
				ProfileImage: visitorTestJPEG(t), LabRulesAccepted: true,
			}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if result.Attendance != visitor.AttendanceCheckedIn || result.Admission != visitor.AdmissionAdmitted {
				t.Fatalf("result=%#v, want an admitted check-in", result)
			}
			assertCount(t, pool, `
				SELECT count(*) FROM visits
				WHERE person_id=$1 AND status='checked_in' AND check_in_method='enrollment'
				  AND check_in_assurance='low' AND admission_decision='admitted' AND check_in_device_id=$2
				  AND checked_in_by_account_id=$3`,
				1, result.PersonID, device.Device.ID, result.AccountID)
			assertCount(t, pool, `SELECT count(*) FROM audit_events WHERE action='visit.checked_in'`, 1)
			confirmations := 1
			if mode == "not_required" {
				confirmations = 0
			}
			assertCount(t, pool, `
				SELECT count(*) FROM laborordnung_confirmations
				WHERE person_id=$1 AND version_id=$2 AND method='enrollment'`, confirmations, result.PersonID, versionID)
			assertCount(t, pool, `
				SELECT count(*) FROM audit_events WHERE action='laborordnung.confirmation.created' AND actor_account_id=$1`,
				confirmations, result.AccountID)
		})
	}
}
