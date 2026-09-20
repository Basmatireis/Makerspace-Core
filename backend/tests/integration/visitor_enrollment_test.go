package integration_test

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
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
		FirstName: "Visitor", LastName: "Administrator", ContactEmail: "visitor-admin@example.test",
		LoginEmail: "visitor-admin-login@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	var masterPersonID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id=$1`, masterAccountID).Scan(&masterPersonID); err != nil {
		t.Fatal(err)
	}
	master := authorization.Principal{
		AccountID: masterAccountID, PersonID: masterPersonID, Master: true,
		Assurance: authorization.AssuranceNormal, AuthenticatedAt: time.Now().UTC(),
	}

	roleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO roles (id,name,laborordnung_mode,profile_image_required) VALUES ($1,'Visitor','blocking',true)`, roleID); err != nil {
		t.Fatal(err)
	}
	insertPublishedLabRulesVersion(t, pool, masterAccountID, "2026-visitor")

	deviceService := manageddevices.NewService(pool)
	terminalType, err := deviceService.CreateType(ctx, master, "Visitor terminal", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	terminal, err := deviceService.Create(ctx, master, "Front desk", terminalType.ID, nil, nil)
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
	labRulesService := laborordnung.NewService(pool, fileService)
	notifier := newNotificationRecorder()
	service := visitor.NewService(pool, cfg, fileService, labRulesService, notifier)

	if _, err := service.GetConfiguration(ctx, authorization.Principal{}); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("permission-less configuration read error=%v", err)
	}
	configuration, err := service.UpdateConfiguration(ctx, master, visitor.ConfigurationInput{
		Enabled: true, InitialRoleID: &roleID, DeviceTypeIDs: []uuid.UUID{terminalType.ID},
		AllowedMethods: []string{"pin", "password", "pin"}, ExpectedVersion: 1,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if configuration.Version != 2 || len(configuration.AllowedMethods) != 2 || len(configuration.DeviceTypeIDs) != 1 {
		t.Fatalf("unexpected visitor configuration: %#v", configuration)
	}

	approvedContext := manageddevices.DeviceContext{
		ID: terminal.Device.ID, Name: terminal.Device.Name, DeviceTypeID: terminal.Device.DeviceTypeID,
		DeviceTypeName: terminal.Device.DeviceTypeName,
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
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_requests`, 0)

	email := "new-visitor@example.test"
	loginName := "Visitor.One"
	pin := "654321"
	result, err := service.Submit(ctx, enrollment, visitor.SubmissionInput{
		FirstName: "New", LastName: "Visitor", Email: &email,
		AuthMethods: []string{"pin"}, PINLoginName: &loginName, PIN: &pin,
		ProfileImage: visitorTestJPEG(t), ProfileImageFilename: "camera.jpg", RequestConfirmation: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.AccountStatus != "enabled" || result.Admission != "blocked" || result.LabRulesRequestID == nil {
		t.Fatalf("unexpected enrollment result: %#v", result)
	}
	assertCount(t, pool, `SELECT count(*) FROM people WHERE id=$1 AND profile_image_file_id IS NOT NULL AND profile_image_source='terminal_capture'`, 1, result.PersonID)
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1 AND person_id=$2 AND status='enabled' AND provisioning_source='visitor'`, 1, result.AccountID, result.PersonID)
	assertCount(t, pool, `SELECT count(*) FROM account_roles WHERE account_id=$1 AND role_id=$2`, 1, result.AccountID, roleID)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind='pin' AND identifier_display=$2 AND identifier_normalized='visitor.one'`, 1, result.AccountID, loginName)
	assertCount(t, pool, `SELECT count(*) FROM auth_identities WHERE account_id=$1 AND kind IN ('password','oidc')`, 0, result.AccountID)
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_requests WHERE person_id=$1 AND status='pending'`, 1, result.PersonID)

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
	if err != nil || authenticated.Principal.AccountID != result.AccountID || authenticated.Principal.Assurance != authorization.AssuranceLow {
		t.Fatalf("visitor PIN authentication=%#v err=%v", authenticated.Principal, err)
	}
	if _, err := labRulesService.Evaluate(ctx, result.PersonID); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_requests WHERE person_id=$1`, 1, result.PersonID)

	admissionPrincipal := authenticated.Principal
	admissionPrincipal.Device = &authorization.ManagedDevice{
		ID: terminal.Device.ID, Name: terminal.Device.Name, DeviceTypeID: terminal.Device.DeviceTypeID,
		DeviceTypeName: terminal.Device.DeviceTypeName,
	}
	firstAdmission, err := service.Admission(ctx, admissionPrincipal, nil)
	if err != nil || firstAdmission.Decision != "blocked" || firstAdmission.RequestID == nil || *firstAdmission.RequestID != *result.LabRulesRequestID {
		t.Fatalf("first admission=%#v err=%v", firstAdmission, err)
	}
	secondAdmission, err := service.Admission(ctx, admissionPrincipal, nil)
	if err != nil || secondAdmission.Decision != "blocked" || secondAdmission.RequestID == nil || *secondAdmission.RequestID != *result.LabRulesRequestID {
		t.Fatalf("second admission=%#v err=%v", secondAdmission, err)
	}
	assertCount(t, pool, `SELECT count(*) FROM laborordnung_requests WHERE person_id=$1 AND status='pending'`, 1, result.PersonID)

	if _, err := labRulesService.Confirm(ctx, master, *result.LabRulesRequestID, "physical-archive-visitor-1", nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	admitted, err := service.Admission(ctx, admissionPrincipal, nil)
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
		AuthMethods: []string{"password"}, ProfileImage: visitorTestJPEG(t),
		ProfileImageFilename: "password-visitor.jpg", RequestConfirmation: true,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if passwordResult.AccountStatus != "disabled" || passwordResult.InvitationDelivery == nil || *passwordResult.InvitationDelivery != "sent" {
		t.Fatalf("password-only visitor result=%#v", passwordResult)
	}
	assertCount(t, pool, `SELECT count(*) FROM password_credentials pc JOIN auth_identities i ON i.id=pc.auth_identity_id WHERE i.account_id=$1`, 0, passwordResult.AccountID)
	invitationCode := notifier.invitationCode(passwordEmail)
	if invitationCode == "" {
		t.Fatal("visitor invitation code was not delivered")
	}
	if err := authService.CompleteInvitation(ctx, passwordEmail, invitationCode, "Visitor password workshop 94", "visitor-invitation", nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, pool, `SELECT count(*) FROM accounts WHERE id=$1 AND status='enabled' AND administratively_disabled_at IS NULL`, 1, passwordResult.AccountID)
	passwordSession, err := authService.Login(ctx, passwordEmail, "Visitor password workshop 94", "visitor-password-login", nil)
	if err != nil {
		t.Fatal(err)
	}
	passwordAuthenticated, err := authService.Authenticate(ctx, passwordSession.Token)
	if err != nil || passwordAuthenticated.Principal.AccountID != passwordResult.AccountID || passwordAuthenticated.Principal.Assurance != authorization.AssuranceNormal {
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
		AuthMethods: []string{"pin"}, PINLoginName: &loginName, PIN: &pin,
		ProfileImage: visitorTestJPEG(t), ProfileImageFilename: "duplicate.jpg", RequestConfirmation: true,
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
