package integration_test

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// fixedIdentityVerifier stands in for PIN/password verification so the tests exercise admission, not credentials.
type fixedIdentityVerifier struct{ identity auth.VerifiedIdentity }

func (v fixedIdentityVerifier) VerifyPasswordForAttendance(
	context.Context,
	string,
	string,
	string,
) (auth.VerifiedIdentity, error) {
	return v.identity, nil
}

func (v fixedIdentityVerifier) VerifyPINForAttendance(
	context.Context,
	string,
	string,
	string,
) (auth.VerifiedIdentity, error) {
	return v.identity, nil
}

// rejectingVerifier refuses every credential, like a wrong PIN.
type rejectingVerifier struct{}

func (rejectingVerifier) VerifyPasswordForAttendance(
	context.Context,
	string,
	string,
	string,
) (auth.VerifiedIdentity, error) {
	return auth.VerifiedIdentity{}, apperror.Unauthenticated
}

func (rejectingVerifier) VerifyPINForAttendance(
	context.Context,
	string,
	string,
	string,
) (auth.VerifiedIdentity, error) {
	return auth.VerifiedIdentity{}, apperror.Unauthenticated
}

type checkInFixture struct {
	pool       *pgxpool.Pool
	labRules   *laborordnung.Service
	attendance *attendance.Service
	master     authorization.Principal
	visitor    seededAccount
	device     manageddevices.DeviceContext
	versionID  uuid.UUID
}

func newCheckInFixture(t *testing.T, mode string) checkInFixture {
	t.Helper()
	pool := migratedPool(t)
	ctx := testContext(t)
	masterAccountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Kiosk", LastName: "Supervisor", LoginEmail: "kiosk-master@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	var masterPersonID uuid.UUID
	if err = pool.QueryRow(
		ctx,
		`SELECT person_id FROM accounts WHERE id=$1`,
		masterAccountID,
	).Scan(&masterPersonID); err != nil {
		t.Fatal(err)
	}
	visitor := seedAccount(t, pool, "kiosk-visitor", false)
	roleID := ids.New()
	if _, err = pool.Exec(
		ctx,
		`INSERT INTO roles (id,name,laborordnung_mode) VALUES ($1,'Kiosk role',$2)`,
		roleID,
		mode,
	); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(
		ctx,
		`INSERT INTO person_roles (person_id,role_id) VALUES ($1,$2)`,
		visitor.personID,
		roleID,
	); err != nil {
		t.Fatal(err)
	}
	versionID := insertPublishedLabRulesVersion(t, pool, masterAccountID, "2026.2")

	deviceTypeID, deviceID := ids.New(), ids.New()
	if _, err = pool.Exec(ctx, `INSERT INTO device_types(id,name) VALUES($1,'Kiosk terminal')`, deviceTypeID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO managed_devices(id,name,device_type_id,token_digest,terminal_enabled,session_policy_id,allowed_app_modes)
		VALUES($1,'Entrance tablet',$2,$3,true,(SELECT id FROM session_policies WHERE is_default),ARRAY['visitor_terminal'])`,
		deviceID, deviceTypeID, bytes.Repeat([]byte{7}, 32)); err != nil {
		t.Fatal(err)
	}
	labRules := laborordnung.NewService(pool, notifyrules.NewSystemEvents(nil), nil)
	verifier := fixedIdentityVerifier{identity: auth.VerifiedIdentity{
		AccountID: visitor.accountID,
		PersonID:  visitor.personID,
		Method:    "pin",
		Assurance: authorization.AssuranceLow,
	}}
	return checkInFixture{
		pool:       pool,
		labRules:   labRules,
		attendance: attendance.NewService(pool, verifier, labRules, nil),
		master: authorization.Principal{
			AccountID:       masterAccountID,
			PersonID:        masterPersonID,
			Master:          true,
			Assurance:       authorization.AssuranceNormal,
			AuthenticatedAt: time.Now().UTC(),
		},
		visitor:   visitor,
		device:    manageddevices.DeviceContext{ID: deviceID},
		versionID: versionID,
	}
}

func (f checkInFixture) pinCheckIn(t *testing.T, choice attendance.LabRulesChoice) (attendance.Visit, error) {
	t.Helper()
	return f.attendance.PINCheckIn(testContext(t), f.device, "kiosk.visitor", "123456", "kiosk-test", choice, nil)
}

func TestBlockingLabRulesRefuseKioskCheckInWithoutConfirmation(t *testing.T) {
	f := newCheckInFixture(t, "blocking")
	if _, err := f.pinCheckIn(t, attendance.LabRulesChoice{}); !apperror.IsCode(err, "lab_rules_confirmation_required") {
		t.Fatalf("check-in without confirmation error=%v, want lab_rules_confirmation_required", err)
	}
	// Deferring is only for roles that merely warn.
	if _, err := f.pinCheckIn(t, attendance.LabRulesChoice{Defer: true}); !apperror.IsCode(
		err,
		"lab_rules_confirmation_required",
	) {
		t.Fatalf("deferred blocking check-in error=%v, want lab_rules_confirmation_required", err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM visits`, 0)
	assertCount(t, f.pool, `SELECT count(*) FROM laborordnung_confirmations`, 0)
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action IN ('visit.checked_in','laborordnung.confirmation.created')`, 0)
}

func TestKioskConfirmationRecordsConfirmationAndAdmits(t *testing.T) {
	f := newCheckInFixture(t, "blocking")
	outdated := ids.New()
	if _, err := f.pinCheckIn(t, attendance.LabRulesChoice{ConfirmVersionID: &outdated}); !apperror.IsCode(
		err,
		"lab_rules_version_outdated",
	) {
		t.Fatalf("confirming another version error=%v, want lab_rules_version_outdated", err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM laborordnung_confirmations`, 0)

	visit, err := f.pinCheckIn(t, attendance.LabRulesChoice{ConfirmVersionID: &f.versionID})
	if err != nil {
		t.Fatal(err)
	}
	if visit.AdmissionDecision != attendance.AdmissionAdmitted || visit.CheckInMethod != "pin" {
		t.Fatalf("visit=%#v, want an admitted PIN check-in", visit)
	}
	assertCount(t, f.pool, `
		SELECT count(*) FROM laborordnung_confirmations
		WHERE person_id=$1 AND version_id=$2 AND method='kiosk' AND confirmed_by_account_id IS NULL
		  AND physical_document_reference IS NULL`, 1, f.visitor.personID, f.versionID)
	assertCount(t, f.pool, `
		SELECT count(*) FROM audit_events
		WHERE action='laborordnung.confirmation.created' AND actor_account_id=$1`, 1, f.visitor.accountID)
	status, err := f.labRules.Evaluate(testContext(t), f.visitor.personID)
	if err != nil || status.State != laborordnung.StateCurrent || status.ActionRequired || status.LatestConfirmedAt == nil {
		t.Fatalf("status after kiosk confirmation=%#v err=%v", status, err)
	}
}

func TestKioskConfirmationIsNotWrittenWhenCheckInFails(t *testing.T) {
	f := newCheckInFixture(t, "blocking")
	if _, err := f.attendance.SupervisedCheckIn(testContext(t), f.master, f.visitor.personID, nil); !apperror.IsCode(
		err,
		"lab_rules_confirmation_required",
	) {
		t.Fatalf("supervised blocking check-in error=%v", err)
	}
	if _, err := f.pinCheckIn(t, attendance.LabRulesChoice{ConfirmVersionID: &f.versionID}); err != nil {
		t.Fatal(err)
	}
	// Already checked in: the second attempt fails as a whole.
	if _, err := f.pool.Exec(testContext(t), `DELETE FROM laborordnung_confirmations`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pinCheckIn(t, attendance.LabRulesChoice{ConfirmVersionID: &f.versionID}); !apperror.IsCode(
		err,
		"already_checked_in",
	) {
		t.Fatalf("second check-in error=%v, want already_checked_in", err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM laborordnung_confirmations`, 0)
}

func TestKioskConfirmationNeedsVerifiedCredentials(t *testing.T) {
	f := newCheckInFixture(t, "blocking")
	service := attendance.NewService(f.pool, rejectingVerifier{}, f.labRules, nil)
	_, err := service.PINCheckIn(
		testContext(t), f.device, "kiosk.visitor", "000000", "kiosk-test",
		attendance.LabRulesChoice{ConfirmVersionID: &f.versionID}, nil,
	)
	if !apperror.IsCode(err, "unauthenticated") {
		t.Fatalf("check-in with a wrong PIN error=%v, want unauthenticated", err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM laborordnung_confirmations`, 0)
	assertCount(t, f.pool, `SELECT count(*) FROM visits`, 0)
}

func TestWarningLabRulesAtKioskSuggestConfirmationOrDefer(t *testing.T) {
	f := newCheckInFixture(t, "warning")
	if _, err := f.pinCheckIn(t, attendance.LabRulesChoice{}); !apperror.IsCode(err, "lab_rules_confirmation_suggested") {
		t.Fatalf("warning check-in without a choice error=%v, want lab_rules_confirmation_suggested", err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM visits`, 0)
	visit, err := f.pinCheckIn(t, attendance.LabRulesChoice{Defer: true})
	if err != nil {
		t.Fatal(err)
	}
	if visit.AdmissionDecision != attendance.AdmissionWarning {
		t.Fatalf("deferred warning check-in=%#v, want a warning admission", visit)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM laborordnung_confirmations`, 0)
}

func TestSupervisedCheckInAdmitsWarningRolesWithWarning(t *testing.T) {
	f := newCheckInFixture(t, "warning")
	visit, err := f.attendance.SupervisedCheckIn(testContext(t), f.master, f.visitor.personID, nil)
	if err != nil || visit.AdmissionDecision != attendance.AdmissionWarning || visit.CheckInMethod != "supervisor" {
		t.Fatalf("supervised warning check-in=%#v err=%v", visit, err)
	}
	nobody := authorization.Principal{AccountID: f.visitor.accountID, PersonID: f.visitor.personID}
	if _, err = f.attendance.SupervisedCheckIn(testContext(t), nobody, f.visitor.personID, nil); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("supervised check-in without attendance.assist error=%v", err)
	}
}

func TestTerminalServesOnlyTheCurrentLabRulesVersion(t *testing.T) {
	f := newCheckInFixture(t, "blocking")
	ctx := testContext(t)
	current, err := f.labRules.CurrentVersion(ctx)
	if err != nil || current.ID != f.versionID {
		t.Fatalf("current=%#v err=%v", current, err)
	}
	if _, err = f.pool.Exec(ctx, `UPDATE laborordnung_versions SET effective_at=now()+interval '1 day' WHERE id=$1`, f.versionID); err == nil {
		t.Fatal("a published version must stay immutable")
	}
	if _, err = f.pool.Exec(ctx, `UPDATE laborordnung_versions SET announced_at=now() WHERE id=$1`, f.versionID); err != nil {
		t.Fatalf("announcing a published version: %v", err)
	}
}
