package authorization

import (
	"context"
	"testing"
	"time"

	authorizationdb "github.com/Basmatireis/Makerspace-Core/backend/internal/authorization/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func grantRow(permission Permission, minimum Assurance, window *int32) authorizationdb.GetPrincipalRolePermissionsRow {
	id := ids.New()
	name, scope, assurance := string(permission), string(GrantEverywhere), string(minimum)
	return authorizationdb.GetPrincipalRolePermissionsRow{
		RoleID: ids.New(), GrantID: &id, PermissionID: &name, Scope: &scope,
		MinimumAssurance: &assurance, ReauthWithinMinutes: window,
	}
}

func masterRow() authorizationdb.GetPrincipalRolePermissionsRow {
	key := string(SystemKeyMaster)
	return authorizationdb.GetPrincipalRolePermissionsRow{RoleID: ids.New(), SystemKey: &key}
}

func int32Pointer(value int32) *int32 { return &value }

func load(t *testing.T, stub permissionsQuerierStub, principal Principal) Principal {
	t.Helper()
	loaded, err := LoadPermissions(context.Background(), stub, principal)
	if err != nil {
		t.Fatal(err)
	}
	return loaded
}

func TestMasterWithoutMultiFactorSessionGetsOnlyOtherRolePermissions(t *testing.T) {
	stub := permissionsQuerierStub{rows: []authorizationdb.GetPrincipalRolePermissionsRow{
		masterRow(), grantRow(OpenDaysRead, AssuranceLow, nil),
	}}
	for _, assurance := range []Assurance{AssuranceLow, AssuranceNormal, AssuranceStrong} {
		principal := load(t, stub, Principal{AccountID: ids.New(), Assurance: assurance, AuthenticatedAt: time.Now()})
		if principal.Master || !principal.HoldsMasterRole {
			t.Fatalf("%s: master=%v holds=%v", assurance, principal.Master, principal.HoldsMasterRole)
		}
		if !principal.Has(OpenDaysRead) || principal.Has(PeopleDelete) || principal.CanDelegate(PermissionGrant{
			PermissionID: PeopleDelete, Scope: GrantEverywhere, MinimumAssurance: AssuranceLow,
		}) {
			t.Fatalf("%s: master without strong_mfa received universal permissions", assurance)
		}
		if got := principal.PermissionIDs(); len(got) != 1 || got[0] != string(OpenDaysRead) {
			t.Fatalf("%s: permissions %v", assurance, got)
		}
	}
	principal := load(t, stub, Principal{
		AccountID: ids.New(), Assurance: AssuranceStrongMFA, AuthenticatedAt: time.Now(),
	})
	if !principal.Master || !principal.Has(PeopleDelete) || len(principal.PermissionIDs()) != len(Registry()) {
		t.Fatal("master with strong_mfa did not receive every registered permission")
	}
}

func TestMasterPolicyWithholdsPermissionsUntilFreshMultiFactorSignIn(t *testing.T) {
	stub := permissionsQuerierStub{
		rows: []authorizationdb.GetPrincipalRolePermissionsRow{masterRow()},
		policy: []authorizationdb.ListMasterReauthenticationPermissionsRow{
			{PermissionID: string(MailManage), WithinMinutes: 10},
		},
	}
	stale := load(t, stub, Principal{
		AccountID: ids.New(), Assurance: AssuranceStrongMFA, AuthenticatedAt: time.Now().Add(-11 * time.Minute),
	})
	if !stale.Master || !stale.Has(PeopleDelete) {
		t.Fatal("stale master lost unrestricted permissions")
	}
	if stale.Has(MailManage) {
		t.Fatal("stale master used a permission that requires a fresh sign-in")
	}
	requirement, denied := stale.ReauthenticationDenial()
	if !denied || requirement.Assurance != AssuranceStrongMFA || requirement.WithinMinutes != 10 {
		t.Fatalf("denial = %v %+v", denied, requirement)
	}
	for _, id := range stale.PermissionIDs() {
		if id == string(MailManage) {
			t.Fatal("withheld permission listed as effective")
		}
	}
	if pending := stale.PendingPermissions(); len(pending) != 1 || pending[0].Permission != MailManage {
		t.Fatalf("pending = %+v", pending)
	}
	fresh := load(t, stub, Principal{
		AccountID: ids.New(), Assurance: AssuranceStrongMFA, AuthenticatedAt: time.Now().Add(-time.Minute),
	})
	if !fresh.Has(MailManage) {
		t.Fatal("fresh master was denied a policy permission")
	}
	weakProof := load(t, stub, Principal{
		AccountID: ids.New(), Assurance: AssuranceStrongMFA, AuthenticatedAssurance: AssuranceNormal,
		AuthenticatedAt: time.Now(),
	})
	if weakProof.Has(MailManage) {
		t.Fatal("a recent password-only proof satisfied a strong_mfa fresh sign-in requirement")
	}
}

func TestGrantFreshSignInWindow(t *testing.T) {
	stub := permissionsQuerierStub{rows: []authorizationdb.GetPrincipalRolePermissionsRow{
		grantRow(RolesManage, AssuranceNormal, int32Pointer(15)),
		grantRow(AuditRead, AssuranceNormal, nil),
	}}
	stale := load(t, stub, Principal{
		AccountID: ids.New(), Assurance: AssuranceNormal, AuthenticatedAt: time.Now().Add(-16 * time.Minute),
	})
	if !stale.Has(AuditRead) {
		t.Fatal("grant without a window was withheld")
	}
	if _, denied := stale.ReauthenticationDenial(); denied {
		t.Fatal("an effective permission recorded a reauthentication denial")
	}
	if stale.Has(RolesManage) {
		t.Fatal("stale session used a grant that requires a fresh sign-in")
	}
	requirement, denied := stale.ReauthenticationDenial()
	if !denied || requirement.Assurance != AssuranceNormal || requirement.WithinMinutes != 15 {
		t.Fatalf("denial = %v %+v", denied, requirement)
	}
	// The denial tracker is shared by copies of the principal within one request.
	copied := stale
	if _, denied := copied.ReauthenticationDenial(); !denied {
		t.Fatal("copied principal lost the recorded denial")
	}
	fresh := load(t, stub, Principal{
		AccountID: ids.New(), Assurance: AssuranceNormal, AuthenticatedAt: time.Now().Add(-14 * time.Minute),
	})
	if !fresh.Has(RolesManage) {
		t.Fatal("fresh session was denied")
	}
	// An alternative grant without a window makes the permission effective.
	alternative := load(t, permissionsQuerierStub{rows: append(stub.rows, grantRow(RolesManage, AssuranceLow, nil))},
		Principal{AccountID: ids.New(), Assurance: AssuranceNormal, AuthenticatedAt: time.Now().Add(-time.Hour)})
	if !alternative.Has(RolesManage) || len(alternative.PendingPermissions()) != 0 {
		t.Fatal("an unrestricted alternative grant did not apply")
	}
	// A low-assurance session never qualifies for a normal grant, fresh or not, and is not asked to reauthenticate.
	low := load(t, stub, Principal{AccountID: ids.New(), Assurance: AssuranceLow, AuthenticatedAt: time.Now()})
	if low.Has(RolesManage) {
		t.Fatal("low session used a normal grant")
	}
	if _, denied := low.ReauthenticationDenial(); denied {
		t.Fatal("assurance shortfall was reported as a fresh sign-in requirement")
	}
}

func TestDelegationTreatsFreshSignInWindowAsPartOfTheEnvelope(t *testing.T) {
	ten, thirty, five := 10, 30, 5
	actor := load(t, permissionsQuerierStub{rows: []authorizationdb.GetPrincipalRolePermissionsRow{
		grantRow(RolesManage, AssuranceNormal, int32Pointer(10)),
		grantRow(AuditRead, AssuranceNormal, nil),
	}}, Principal{AccountID: ids.New(), Assurance: AssuranceNormal, AuthenticatedAt: time.Now()})
	grant := func(permission Permission, window *int) PermissionGrant {
		return PermissionGrant{
			PermissionID: permission, Scope: GrantEverywhere, MinimumAssurance: AssuranceNormal,
			ReauthWithinMinutes: window,
		}
	}
	cases := []struct {
		name  string
		grant PermissionGrant
		want  bool
	}{
		{"same window", grant(RolesManage, &ten), true},
		{"stricter window", grant(RolesManage, &five), true},
		{"looser window", grant(RolesManage, &thirty), false},
		{"dropped window", grant(RolesManage, nil), false},
		{"window added to unrestricted grant", grant(AuditRead, &thirty), true},
		{"unrestricted from unrestricted", grant(AuditRead, nil), true},
	}
	for _, test := range cases {
		if got := actor.CanDelegate(test.grant); got != test.want {
			t.Fatalf("%s: CanDelegate = %v, want %v", test.name, got, test.want)
		}
	}
	tooLong := 1441
	if actor.CanDelegate(grant(AuditRead, &tooLong)) {
		t.Fatal("out-of-range window accepted")
	}
}

func TestHasFreshAssuranceUsesTheProvenAssurance(t *testing.T) {
	now := time.Now()
	principal := Principal{Assurance: AssuranceStrong, AuthenticatedAssurance: AssuranceNormal, AuthenticatedAt: now}
	if !principal.HasFreshAssurance(AssuranceNormal, time.Minute, now) {
		t.Fatal("normal proof not accepted for normal requirement")
	}
	if principal.HasFreshAssurance(AssuranceStrong, time.Minute, now) {
		t.Fatal("normal proof accepted for strong requirement")
	}
}
