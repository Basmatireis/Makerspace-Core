package integration_test

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/attendance"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// methodVerifier accepts every credential, answers with the method it was asked to verify and records each check, so
// the tests can tell that a refused method never reached credential verification.
type methodVerifier struct {
	identity auth.VerifiedIdentity
	checked  *[]string
}

func (v methodVerifier) verified(method string) (auth.VerifiedIdentity, error) {
	*v.checked = append(*v.checked, method)
	identity := v.identity
	identity.Method = method
	return identity, nil
}

func (v methodVerifier) VerifyPasswordForAttendance(context.Context, string, string, string) (auth.VerifiedIdentity, error) {
	return v.verified("password")
}

func (v methodVerifier) VerifyPINForAttendance(context.Context, string, string, string) (auth.VerifiedIdentity, error) {
	return v.verified("pin")
}

func (v methodVerifier) VerifyEmailCodeForAttendance(context.Context, string, string, string) (auth.VerifiedIdentity, error) {
	return v.verified("email_code")
}

func (v methodVerifier) RequestCheckInEmailCode(context.Context, string, uuid.UUID, *uuid.UUID) error {
	*v.checked = append(*v.checked, "request_email_code")
	return nil
}

func (methodVerifier) ConsumeVerifiedTx(context.Context, pgx.Tx, auth.VerifiedIdentity) error {
	return nil
}

func setKioskMethods(t *testing.T, f checkInFixture, checkIn, checkOut []string, tap bool) {
	t.Helper()
	if _, err := f.pool.Exec(testContext(t), `
		UPDATE managed_devices SET check_in_methods=$2, check_out_methods=$3, allow_tap_checkout=$4 WHERE id=$1`,
		f.device.ID, checkIn, checkOut, tap); err != nil {
		t.Fatal(err)
	}
}

func TestKioskAcceptsOnlyItsConfiguredMethods(t *testing.T) {
	f := newCheckInFixture(t, "not_required")
	ctx := testContext(t)
	var checked []string
	service := attendance.NewService(f.pool, methodVerifier{
		identity: auth.VerifiedIdentity{
			AccountID: f.visitor.accountID, PersonID: f.visitor.personID, Assurance: authorization.AssuranceLow,
		},
		checked: &checked,
	}, f.labRules, nil)
	none := attendance.LabRulesChoice{}
	checkIn := map[string]func() (attendance.Visit, error){
		"password": func() (attendance.Visit, error) {
			return service.PasswordCheckIn(ctx, f.device, "kiosk-visitor@example.test", "secret", "t", none, nil)
		},
		"pin": func() (attendance.Visit, error) {
			return service.PINCheckIn(ctx, f.device, "kiosk.visitor", "123456", "t", none, nil)
		},
		"email_code": func() (attendance.Visit, error) {
			return service.EmailCodeCheckIn(ctx, f.device, "kiosk-visitor@example.test", "123456", "t", none, nil)
		},
	}
	checkOut := map[string]func() (attendance.Visit, error){
		"password": func() (attendance.Visit, error) {
			return service.PasswordCheckOut(ctx, f.device, "kiosk-visitor@example.test", "secret", "t", nil)
		},
		"pin": func() (attendance.Visit, error) {
			return service.PINCheckOut(ctx, f.device, "kiosk.visitor", "123456", "t", nil)
		},
		"email_code": func() (attendance.Visit, error) {
			return service.EmailCodeCheckOut(ctx, f.device, "kiosk-visitor@example.test", "123456", "t", nil)
		},
	}
	all := []string{"email_code", "pin", "password"}
	for _, configured := range [][]string{{"email_code"}, {"pin"}, {"password"}, {"email_code", "password"}, all} {
		for _, method := range all {
			allowed := slices.Contains(configured, method)
			// Check-in with the method under test; check-out takes every method meanwhile.
			setKioskMethods(t, f, configured, all, false)
			checked = nil
			_, err := checkIn[method]()
			if allowed && err != nil {
				t.Fatalf("check-in with %s on %v: %v", method, configured, err)
			}
			if !allowed {
				if !apperror.IsCode(err, "attendance_method_not_allowed") || len(checked) != 0 {
					t.Fatalf("check-in with %s on %v: err=%v, checked=%v", method, configured, err, checked)
				}
				if _, err = checkIn[configured[0]](); err != nil {
					t.Fatal(err)
				}
			}
			// Check-out with the method under test; check-in takes every method meanwhile.
			setKioskMethods(t, f, all, configured, false)
			checked = nil
			_, err = checkOut[method]()
			if allowed && err != nil {
				t.Fatalf("check-out with %s on %v: %v", method, configured, err)
			}
			if !allowed {
				if !apperror.IsCode(err, "attendance_method_not_allowed") || len(checked) != 0 {
					t.Fatalf("check-out with %s on %v: err=%v, checked=%v", method, configured, err, checked)
				}
				if _, err = checkOut[configured[0]](); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	assertCount(t, f.pool, `SELECT count(*) FROM visits WHERE person_id=$1 AND status='checked_in'`, 0, f.visitor.personID)

	// The emailed code is only sent by a kiosk that takes it for check-in or check-out.
	setKioskMethods(t, f, []string{"password"}, []string{"pin"}, false)
	checked = nil
	if err := service.RequestEmailCode(ctx, f.device, "kiosk-visitor@example.test", nil); !apperror.IsCode(
		err, "attendance_method_not_allowed",
	) || len(checked) != 0 {
		t.Fatalf("email code request without the method: err=%v, checked=%v", err, checked)
	}
	for _, sets := range [][2][]string{{{"email_code"}, {"pin"}}, {{"password"}, {"email_code"}}} {
		setKioskMethods(t, f, sets[0], sets[1], false)
		if err := service.RequestEmailCode(ctx, f.device, "kiosk-visitor@example.test", nil); err != nil {
			t.Fatalf("email code request on %v: %v", sets, err)
		}
	}

	// A kiosk that checks out only by a tap refuses every identified check-out.
	setKioskMethods(t, f, all, []string{}, true)
	if _, err := checkIn["pin"](); err != nil {
		t.Fatal(err)
	}
	for _, method := range all {
		if _, err := checkOut[method](); !apperror.IsCode(err, "attendance_method_not_allowed") {
			t.Fatalf("check-out with %s on a tap-only kiosk: %v", method, err)
		}
	}
}

func TestKioskEmailCodeFollowsTheConfiguredMethods(t *testing.T) {
	f := newCheckInFixture(t, "not_required")
	enableEmailCode(t, f.pool, f.visitor)
	authService, notifier := newEmailCodeAuth(t, f.pool)
	ctx := testContext(t)
	service := attendance.NewService(f.pool, authService, f.labRules, nil)
	email := "kiosk-visitor@example.test"

	// Email code refused: neither the code nor the check-in.
	setKioskMethods(t, f, []string{"password"}, []string{"password"}, false)
	if err := service.RequestEmailCode(ctx, f.device, email, nil); !apperror.IsCode(
		err, "attendance_method_not_allowed",
	) {
		t.Fatalf("request: %v", err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM auth_challenges WHERE kind='email_check_in'`, 0)

	// Email code allowed for check-in only: the real code checks in, but cannot check out.
	setKioskMethods(t, f, []string{"email_code"}, []string{"password"}, false)
	if err := service.RequestEmailCode(ctx, f.device, email, nil); err != nil {
		t.Fatal(err)
	}
	code := notifier.loginCode(t, email)
	visit, err := service.EmailCodeCheckIn(ctx, f.device, email, code, "kiosk-email", attendance.LabRulesChoice{}, nil)
	if err != nil || visit.CheckInMethod != "email_code" {
		t.Fatalf("check-in = %+v, %v", visit, err)
	}
	notifier.forgetLoginCode(email)
	if err = service.RequestEmailCode(ctx, f.device, email, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = service.EmailCodeCheckOut(ctx, f.device, email, notifier.loginCode(t, email), "kiosk-email", nil); !apperror.IsCode(
		err, "attendance_method_not_allowed",
	) {
		t.Fatalf("check-out with a refused emailed code: %v", err)
	}
	// The refused attempt did not use up the code: once the kiosk takes it, it checks out.
	setKioskMethods(t, f, []string{"email_code"}, []string{"email_code"}, false)
	if _, err = service.EmailCodeCheckOut(ctx, f.device, email, notifier.loginCode(t, email), "kiosk-email", nil); err != nil {
		t.Fatalf("check-out: %v", err)
	}
}

func TestDeviceSettingsKeepAWayToCheckOut(t *testing.T) {
	e := newCheckoutEnv(t, true)
	device := e.device.Device
	settings := func(checkIn, checkOut []manageddevices.KioskMethod, tap bool) manageddevices.DeviceSettings {
		return manageddevices.DeviceSettings{
			SessionPolicyID: device.SessionPolicyID, KioskEnabled: true,
			AllowedApplicationModes: []manageddevices.ApplicationMode{"visitor_terminal"},
			CheckInMethods:          checkIn, CheckOutMethods: checkOut, AllowTapCheckout: tap, KioskResetSeconds: 60,
		}
	}
	for _, bad := range []manageddevices.DeviceSettings{
		settings(nil, manageddevices.AllKioskMethods, true),
		settings(manageddevices.AllKioskMethods, nil, false),
		settings([]manageddevices.KioskMethod{"oidc"}, manageddevices.AllKioskMethods, false),
	} {
		if _, err := e.devices.UpdateConfigured(e.ctx, e.principal, device.ID, device.Name, device.DeviceTypeID, nil,
			bad, device.Version, nil); !apperror.IsCode(err, "validation_failed") {
			t.Fatalf("settings %+v: %v", bad, err)
		}
	}
	updated, err := e.devices.UpdateConfigured(e.ctx, e.principal, device.ID, device.Name, device.DeviceTypeID, nil,
		settings([]manageddevices.KioskMethod{"password", "email_code"}, nil, true), device.Version, nil)
	if err != nil || !slices.Equal(updated.CheckInMethods, []manageddevices.KioskMethod{"email_code", "password"}) ||
		len(updated.CheckOutMethods) != 0 {
		t.Fatalf("updated = %+v, %v", updated, err)
	}
	kiosk, err := e.attendance.KioskContext(e.ctx, e.deviceContext(e.device))
	if err != nil || len(kiosk.CheckInMethods) != 2 || len(kiosk.CheckOutMethods) != 0 || !kiosk.AllowTapCheckout {
		t.Fatalf("kiosk = %+v, %v", kiosk, err)
	}
	// The database refuses a kiosk without a way out as well.
	_, err = e.pool.Exec(e.ctx, `UPDATE managed_devices SET allow_tap_checkout=false WHERE id=$1`, device.ID)
	expectPostgresCode(t, err, "23514")
}

// TestKioskMethodsMigrationKeepsWhatTheAssuranceAccepted checks 00133: the assurance levels become the method sets
// they accepted, and Down turns the sets back into levels.
func TestKioskMethodsMigrationKeepsWhatTheAssuranceAccepted(t *testing.T) {
	pool := emptySchemaPool(t)
	ctx := testContext(t)
	const name = "00133_kiosk_methods_tap_surveys.sql"
	var before []string
	var migration string
	for _, path := range allMigrationFiles(t) {
		switch {
		case filepath.Base(path) < "00133_":
			before = append(before, path)
		case filepath.Base(path) == name:
			migration = path
		}
	}
	if migration == "" {
		t.Fatal(name + " is missing")
	}
	applyMigrationFiles(t, pool, before)
	deviceType := ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO device_types(id,name) VALUES($1,'Tablet')`, deviceType); err != nil {
		t.Fatal(err)
	}
	devices := map[string]uuid.UUID{}
	for i, levels := range [][2]string{{"low", "low"}, {"normal", "low"}, {"strong", "normal"}} {
		id := ids.New()
		devices[levels[0]+"/"+levels[1]] = id
		if _, err := pool.Exec(ctx, `INSERT INTO managed_devices(id,name,device_type_id,token_digest,check_in_assurance,
			check_out_assurance) VALUES($1,$2,$3,$4,$5,$6)`, id, "Tablet "+levels[0], deviceType,
			bytes.Repeat([]byte{byte(i + 1)}, 32), levels[0], levels[1]); err != nil {
			t.Fatal(err)
		}
	}
	content, err := os.ReadFile(migration)
	if err != nil {
		t.Fatal(err)
	}
	up, down, found := strings.Cut(string(content), "-- +goose Down")
	if !found {
		t.Fatal(name + " has no Down section")
	}
	if _, err = pool.Exec(ctx, up); err != nil {
		t.Fatal(err)
	}
	want := map[string][2]string{
		"low/low":       {"{email_code,pin,password}", "{email_code,pin,password}"},
		"normal/low":    {"{email_code,password}", "{email_code,pin,password}"},
		"strong/normal": {"{password}", "{email_code,password}"},
	}
	for key, id := range devices {
		var checkIn, checkOut string
		if err = pool.QueryRow(ctx, `SELECT check_in_methods::text, check_out_methods::text FROM managed_devices WHERE id=$1`,
			id).Scan(&checkIn, &checkOut); err != nil {
			t.Fatal(err)
		}
		if checkIn != want[key][0] || checkOut != want[key][1] {
			t.Fatalf("%s became %s / %s", key, checkIn, checkOut)
		}
	}
	if _, err = pool.Exec(ctx, down); err != nil {
		t.Fatal(err)
	}
	var levels string
	if err = pool.QueryRow(ctx, `SELECT check_in_assurance || '/' || check_out_assurance FROM managed_devices WHERE id=$1`,
		devices["normal/low"]).Scan(&levels); err != nil || levels != "normal/low" {
		t.Fatalf("down = %q, %v", levels, err)
	}
}
