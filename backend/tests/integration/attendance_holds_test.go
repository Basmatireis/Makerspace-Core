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

type holdFixture struct {
	pool       *pgxpool.Pool
	labRules   *laborordnung.Service
	attendance *attendance.Service
	master     authorization.Principal
	visitor    seededAccount
	device     manageddevices.DeviceContext
}

func newHoldFixture(t *testing.T, mode string) holdFixture {
	t.Helper()
	pool := migratedPool(t)
	ctx := testContext(t)
	masterAccountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Hold", LastName: "Supervisor", LoginEmail: "hold-master@example.test", Password: bootstrapPassword,
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
	visitor := seedAccount(t, pool, "hold-visitor", false)
	roleID := ids.New()
	if _, err = pool.Exec(
		ctx,
		`INSERT INTO roles (id,name,laborordnung_mode) VALUES ($1,'Hold role',$2)`,
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
	insertPublishedLabRulesVersion(t, pool, masterAccountID, "2026.2")

	deviceTypeID, deviceID := ids.New(), ids.New()
	if _, err = pool.Exec(ctx, `INSERT INTO device_types(id,name) VALUES($1,'Hold terminal')`, deviceTypeID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO managed_devices(id,name,device_type_id,token_digest,terminal_enabled,session_policy_id,allowed_app_modes)
		VALUES($1,'Entrance tablet',$2,$3,true,(SELECT id FROM session_policies WHERE is_default),ARRAY['visitor_terminal'])`,
		deviceID, deviceTypeID, bytes.Repeat([]byte{7}, 32)); err != nil {
		t.Fatal(err)
	}
	labRules := laborordnung.NewService(pool, nil)
	verifier := fixedIdentityVerifier{identity: auth.VerifiedIdentity{
		AccountID: visitor.accountID,
		PersonID:  visitor.personID,
		Method:    "pin",
		Assurance: authorization.AssuranceLow,
	}}
	service := attendance.NewService(pool, verifier, labRules, nil, time.UTC)
	labRules.SetConfirmationListener(service)
	return holdFixture{
		pool:       pool,
		labRules:   labRules,
		attendance: service,
		master: authorization.Principal{
			AccountID:       masterAccountID,
			PersonID:        masterPersonID,
			Master:          true,
			Assurance:       authorization.AssuranceNormal,
			AuthenticatedAt: time.Now().UTC(),
		},
		visitor: visitor,
		device:  manageddevices.DeviceContext{ID: deviceID},
	}
}

func TestBlockingLabRulesHoldTerminalCheckInUntilConfirmed(t *testing.T) {
	f := newHoldFixture(t, "blocking")
	ctx := testContext(t)

	result, err := f.attendance.PINCheckIn(ctx, f.device, "hold.visitor", "123456", "hold-test", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Visit != nil || result.Hold == nil {
		t.Fatalf("blocking check-in result=%#v, want a hold", result)
	}
	hold := *result.Hold
	if hold.LaborordnungRequestID == nil || hold.RequiredRevision == nil || *hold.RequiredRevision != "2026.2" ||
		hold.PreviousRevision != nil {
		t.Fatalf("hold does not describe the missing signature: %#v", hold)
	}
	if !hold.ExpiresAt.After(hold.RequestedAt) || hold.ExpiresAt.Sub(hold.RequestedAt) > 24*time.Hour {
		t.Fatalf("hold expiry %s is not the end of the local day after %s", hold.ExpiresAt, hold.RequestedAt)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM visits WHERE person_id=$1`, 0, f.visitor.personID)

	present, waiting, err := f.attendance.PublicPresence(ctx, f.device)
	if err != nil {
		t.Fatal(err)
	}
	if len(present) != 0 || len(waiting) != 1 || waiting[0].DisplayName != "Test P." {
		t.Fatalf("public presence=%#v waiting=%#v", present, waiting)
	}

	again, err := f.attendance.PINCheckIn(ctx, f.device, "hold.visitor", "123456", "hold-test", nil)
	if err != nil || again.Hold == nil || again.Hold.ID != hold.ID || !again.Hold.RequestedAt.Equal(hold.RequestedAt) {
		t.Fatalf("repeated attempt=%#v err=%v, want the same hold", again, err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM attendance_holds WHERE person_id=$1`, 1, f.visitor.personID)

	if _, err = f.labRules.Confirm(ctx, f.master, *hold.LaborordnungRequestID, "folder-3", nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM attendance_holds`, 0)
	assertCount(t, f.pool, `
		SELECT count(*) FROM visits
		WHERE person_id=$1 AND status='checked_in' AND admission_decision='admitted'
		  AND check_in_method='pin' AND check_in_device_id IS NOT NULL AND laborordnung_version_id IS NOT NULL`,
		1, f.visitor.personID)
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action='visit.hold_released'`, 1)
}

func TestWarningLabRulesStillAdmitWithWarning(t *testing.T) {
	f := newHoldFixture(t, "warning")
	result, err := f.attendance.PINCheckIn(testContext(t), f.device, "hold.visitor", "123456", "hold-test", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Hold != nil || result.Visit == nil || result.Visit.AdmissionDecision != attendance.AdmissionWarning {
		t.Fatalf("warning check-in result=%#v, want a visit with a warning", result)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM attendance_holds`, 0)
}

func TestExpiredHoldIsNotReleasedByLaterConfirmation(t *testing.T) {
	f := newHoldFixture(t, "blocking")
	ctx := testContext(t)
	result, err := f.attendance.PINCheckIn(ctx, f.device, "hold.visitor", "123456", "hold-test", nil)
	if err != nil || result.Hold == nil {
		t.Fatalf("hold=%#v err=%v", result, err)
	}
	if _, err = f.pool.Exec(
		ctx,
		`UPDATE attendance_holds SET requested_at=now()-interval '2 days', expires_at=now()-interval '1 day'`,
	); err != nil {
		t.Fatal(err)
	}
	holds, err := f.attendance.ListHolds(ctx, f.master)
	if err != nil || len(holds) != 0 {
		t.Fatalf("expired holds listed=%#v err=%v", holds, err)
	}
	if _, err = f.labRules.Confirm(ctx, f.master, *result.Hold.LaborordnungRequestID, "folder-3", nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM visits WHERE person_id=$1`, 0, f.visitor.personID)
}

func TestSupervisedCheckInIsHeldAndCanBeCancelled(t *testing.T) {
	f := newHoldFixture(t, "blocking")
	ctx := testContext(t)
	result, err := f.attendance.SupervisedCheckIn(ctx, f.master, f.visitor.personID, nil)
	if err != nil || result.Hold == nil || result.Hold.CheckInMethod != "supervisor" {
		t.Fatalf("supervised blocking check-in=%#v err=%v", result, err)
	}
	holds, err := f.attendance.ListHolds(ctx, f.master)
	if err != nil || len(holds) != 1 || holds[0].ID != result.Hold.ID {
		t.Fatalf("holds=%#v err=%v", holds, err)
	}
	if err = f.attendance.CancelHold(ctx, f.master, result.Hold.ID, nil); err != nil {
		t.Fatal(err)
	}
	if err = f.attendance.CancelHold(ctx, f.master, result.Hold.ID, nil); !apperror.IsCode(err, "not_found") {
		t.Fatalf("second cancel error=%v, want not_found", err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action='attendance_hold.cancelled'`, 1)
	assertCount(t, f.pool, `SELECT count(*) FROM visits`, 0)
}

func TestAttendanceHoldsRequireAttendancePermissions(t *testing.T) {
	f := newHoldFixture(t, "blocking")
	ctx := testContext(t)
	result, err := f.attendance.SupervisedCheckIn(ctx, f.master, f.visitor.personID, nil)
	if err != nil || result.Hold == nil {
		t.Fatalf("hold=%#v err=%v", result, err)
	}
	nobody := authorization.Principal{AccountID: f.visitor.accountID, PersonID: f.visitor.personID}
	if _, err = f.attendance.ListHolds(ctx, nobody); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("list without attendance.read error=%v", err)
	}
	if err = f.attendance.CancelHold(ctx, nobody, result.Hold.ID, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("cancel without attendance.assist error=%v", err)
	}
	if _, err = f.attendance.SupervisedCheckIn(ctx, nobody, f.visitor.personID, nil); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("supervised check-in without attendance.assist error=%v", err)
	}
	if _, err = f.labRules.Confirm(ctx, nobody, *result.Hold.LaborordnungRequestID, "folder-3", nil, nil, nil); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("confirmation without laborordnung.confirm error=%v", err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM attendance_holds`, 1)
	assertCount(t, f.pool, `SELECT count(*) FROM visits`, 0)
}
