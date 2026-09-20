package authorization

import (
	"context"
	"testing"

	authorizationdb "github.com/Basmatireis/Makerspace-Core/backend/internal/authorization/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/google/uuid"
)

type permissionsQuerierStub struct {
	rows []authorizationdb.GetPrincipalRolePermissionsRow
}

func (s permissionsQuerierStub) GetPrincipalRolePermissions(context.Context, uuid.UUID) ([]authorizationdb.GetPrincipalRolePermissionsRow, error) {
	return s.rows, nil
}

func TestMasterOnlyGrantsKnownPermissions(t *testing.T) {
	principal := Principal{Master: true}
	if !principal.Has(PeopleDelete) {
		t.Fatal("master did not receive registered permission")
	}
	if principal.Has(Permission("typo.permission")) {
		t.Fatal("master received unknown permission")
	}
}

func TestRegistryMatchesGeneratedOpenAPIEnumAndDescriptions(t *testing.T) {
	spec, err := openapi.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	schema := spec.Components.Schemas["PermissionId"]
	if schema == nil || schema.Value == nil {
		t.Fatal("PermissionId schema missing")
	}
	want := make(map[string]struct{}, len(schema.Value.Enum))
	for _, value := range schema.Value.Enum {
		text, ok := value.(string)
		if !ok {
			t.Fatalf("non-string permission enum: %T", value)
		}
		want[text] = struct{}{}
	}
	for _, definition := range Definitions() {
		if definition.Description == "" {
			t.Fatalf("missing description for %s", definition.ID)
		}
		if _, ok := want[string(definition.ID)]; !ok {
			t.Fatalf("registry-only permission %s", definition.ID)
		}
		delete(want, string(definition.ID))
	}
	if len(want) != 0 {
		t.Fatalf("OpenAPI permissions missing from registry: %v", want)
	}
}

func TestSelfScope(t *testing.T) {
	personID := uuid.Must(uuid.NewV7())
	principal := Principal{PersonID: personID, permissions: map[Permission]struct{}{PeopleReadSelf: {}}}
	if !principal.CanReadPerson(personID) || principal.CanReadPerson(uuid.Must(uuid.NewV7())) {
		t.Fatal("self scope was not enforced")
	}
}

func TestPersonScopeMatrix(t *testing.T) {
	ownPersonID := uuid.Must(uuid.NewV7())
	otherPersonID := uuid.Must(uuid.NewV7())

	tests := []struct {
		name           string
		permissions    []Permission
		canReadOwn     bool
		canReadOther   bool
		canUpdateOwn   bool
		canUpdateOther bool
	}{
		{name: "none"},
		{name: "read self", permissions: []Permission{PeopleReadSelf}, canReadOwn: true},
		{name: "read all", permissions: []Permission{PeopleReadAll}, canReadOwn: true, canReadOther: true},
		{name: "read self and all", permissions: []Permission{PeopleReadSelf, PeopleReadAll}, canReadOwn: true, canReadOther: true},
		{name: "update self", permissions: []Permission{PeopleUpdateSelf}, canUpdateOwn: true},
		{name: "update all", permissions: []Permission{PeopleUpdateAll}, canUpdateOwn: true, canUpdateOther: true},
		{name: "update self and all", permissions: []Permission{PeopleUpdateSelf, PeopleUpdateAll}, canUpdateOwn: true, canUpdateOther: true},
		{
			name:        "independent read and update scopes",
			permissions: []Permission{PeopleReadSelf, PeopleUpdateAll},
			canReadOwn:  true, canUpdateOwn: true, canUpdateOther: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			permissions := make(map[Permission]struct{}, len(test.permissions))
			for _, permission := range test.permissions {
				permissions[permission] = struct{}{}
			}
			principal := Principal{PersonID: ownPersonID, permissions: permissions}
			if got := principal.CanReadPerson(ownPersonID); got != test.canReadOwn {
				t.Fatalf("CanReadPerson(own) = %v, want %v", got, test.canReadOwn)
			}
			if got := principal.CanReadPerson(otherPersonID); got != test.canReadOther {
				t.Fatalf("CanReadPerson(other) = %v, want %v", got, test.canReadOther)
			}
			if got := principal.CanUpdatePerson(ownPersonID); got != test.canUpdateOwn {
				t.Fatalf("CanUpdatePerson(own) = %v, want %v", got, test.canUpdateOwn)
			}
			if got := principal.CanUpdatePerson(otherPersonID); got != test.canUpdateOther {
				t.Fatalf("CanUpdatePerson(other) = %v, want %v", got, test.canUpdateOther)
			}
		})
	}
}

func TestLoadPermissionsRebuildsPrivilegeStateAndIgnoresDrift(t *testing.T) {
	knownPermission := string(PeopleReadSelf)
	unknownPermission := "future.permission"
	global, low := string(GrantEverywhere), string(AssuranceLow)
	knownGrant, unknownGrant := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	principal, err := LoadPermissions(context.Background(), permissionsQuerierStub{rows: []authorizationdb.GetPrincipalRolePermissionsRow{
		{RoleID: uuid.Must(uuid.NewV7()), GrantID: &knownGrant, PermissionID: &knownPermission, Scope: &global, MinimumAssurance: &low},
		{RoleID: uuid.Must(uuid.NewV7()), GrantID: &unknownGrant, PermissionID: &unknownPermission, Scope: &global, MinimumAssurance: &low},
	}}, Principal{AccountID: uuid.Must(uuid.NewV7()), Master: true, permissions: map[Permission]struct{}{PeopleDelete: {}}})
	if err != nil {
		t.Fatal(err)
	}
	if principal.Master {
		t.Fatal("stale master status survived a fresh database permission load")
	}
	if !principal.Has(PeopleReadSelf) {
		t.Fatal("known stored permission was not loaded")
	}
	if principal.Has(PeopleDelete) {
		t.Fatal("stale direct permission survived a fresh database permission load")
	}
	if principal.Has(Permission(unknownPermission)) {
		t.Fatal("unknown stored permission was granted")
	}
	if got := principal.PermissionIDs(); len(got) != 1 || got[0] != knownPermission {
		t.Fatalf("unexpected effective permissions: %v", got)
	}
}

func TestLoadPermissionsDerivesMasterFromRoleEveryTime(t *testing.T) {
	systemKey := "master"
	principal, err := LoadPermissions(context.Background(), permissionsQuerierStub{rows: []authorizationdb.GetPrincipalRolePermissionsRow{
		{RoleID: uuid.Must(uuid.NewV7()), SystemKey: &systemKey},
	}}, Principal{AccountID: uuid.Must(uuid.NewV7())})
	if err != nil {
		t.Fatal(err)
	}
	if !principal.Master || !principal.Has(AuditRead) {
		t.Fatal("master role did not derive all registered permissions")
	}
}

func TestDeviceScopedPermissionMatrix(t *testing.T) {
	typeID := uuid.Must(uuid.NewV7())
	otherTypeID := uuid.Must(uuid.NewV7())
	device := &ManagedDevice{ID: uuid.Must(uuid.NewV7()), DeviceTypeID: typeID}
	tests := []struct {
		name   string
		device *ManagedDevice
		grant  PermissionGrant
		want   bool
	}{
		{"global without device", nil, PermissionGrant{PermissionID: PeopleReadAll, Scope: GrantEverywhere, MinimumAssurance: AssuranceLow}, true},
		{"any managed without device", nil, PermissionGrant{PermissionID: PeopleReadAll, Scope: GrantAnyManagedDevice, MinimumAssurance: AssuranceLow}, false},
		{"any managed with device", device, PermissionGrant{PermissionID: PeopleReadAll, Scope: GrantAnyManagedDevice, MinimumAssurance: AssuranceLow}, true},
		{"matching selected type", device, PermissionGrant{PermissionID: PeopleReadAll, Scope: GrantSelectedDeviceTypes, DeviceTypeIDs: []uuid.UUID{typeID}, MinimumAssurance: AssuranceLow}, true},
		{"nonmatching selected type", device, PermissionGrant{PermissionID: PeopleReadAll, Scope: GrantSelectedDeviceTypes, DeviceTypeIDs: []uuid.UUID{otherTypeID}, MinimumAssurance: AssuranceLow}, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			p := Principal{Device: test.device, Assurance: AssuranceNormal, grants: map[Permission][]PermissionGrant{PeopleReadAll: {test.grant}}}
			if got := p.grantEffective(test.grant); got != test.want {
				t.Fatalf("effective=%v want %v", got, test.want)
			}
		})
	}
}

func TestEffectivePermissionsUsesLiveGrantSemantics(t *testing.T) {
	typeA := uuid.Must(uuid.NewV7())
	typeB := uuid.Must(uuid.NewV7())
	grants := []PermissionGrant{
		{PermissionID: PeopleReadSelf, Scope: GrantEverywhere, MinimumAssurance: AssuranceLow},
		{PermissionID: PeopleReadAll, Scope: GrantSelectedDeviceTypes, DeviceTypeIDs: []uuid.UUID{typeA}, MinimumAssurance: AssuranceNormal},
		{PermissionID: PeopleReadAll, Scope: GrantAnyManagedDevice, MinimumAssurance: AssuranceStrong},
		{PermissionID: Permission("future.permission"), Scope: GrantEverywhere, MinimumAssurance: AssuranceLow},
	}

	tests := []struct {
		name       string
		evaluation EvaluationContext
		want       []Permission
	}{
		{name: "unmanaged normal", evaluation: EvaluationContext{Assurance: AssuranceNormal}, want: []Permission{PeopleReadSelf}},
		{name: "matching type", evaluation: EvaluationContext{Assurance: AssuranceNormal, DeviceTypeID: &typeA}, want: []Permission{PeopleReadAll, PeopleReadSelf}},
		{name: "other type below strong", evaluation: EvaluationContext{Assurance: AssuranceNormal, DeviceTypeID: &typeB}, want: []Permission{PeopleReadSelf}},
		{name: "other type strong alternative", evaluation: EvaluationContext{Assurance: AssuranceStrong, DeviceTypeID: &typeB}, want: []Permission{PeopleReadAll, PeopleReadSelf}},
		{name: "invalid assurance fails closed", evaluation: EvaluationContext{Assurance: Assurance("invalid"), DeviceTypeID: &typeA}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := EffectivePermissions(grants, test.evaluation)
			if len(got) != len(test.want) {
				t.Fatalf("permissions = %v, want %v", got, test.want)
			}
			for index := range got {
				if got[index] != test.want[index] {
					t.Fatalf("permissions = %v, want %v", got, test.want)
				}
			}
		})
	}
}

func TestLoadPermissionsUnionsSelectedTypesAndUsesBroadestGrant(t *testing.T) {
	typeA := uuid.Must(uuid.NewV7())
	typeB := uuid.Must(uuid.NewV7())
	permission := string(PeopleReadAll)
	selected := string(GrantSelectedDeviceTypes)
	anyDevice := string(GrantAnyManagedDevice)
	minimum := string(AssuranceLow)
	grantA, grantB := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	rows := []authorizationdb.GetPrincipalRolePermissionsRow{
		{RoleID: uuid.Must(uuid.NewV7()), GrantID: &grantA, PermissionID: &permission, Scope: &selected, MinimumAssurance: &minimum, DeviceTypeID: &typeA},
		{RoleID: uuid.Must(uuid.NewV7()), GrantID: &grantB, PermissionID: &permission, Scope: &selected, MinimumAssurance: &minimum, DeviceTypeID: &typeB},
	}
	principal, err := LoadPermissions(context.Background(), permissionsQuerierStub{rows: rows}, Principal{
		AccountID: uuid.Must(uuid.NewV7()),
		Device:    &ManagedDevice{ID: uuid.Must(uuid.NewV7()), DeviceTypeID: typeB},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !principal.Has(PeopleReadAll) {
		t.Fatal("union of selected device types did not include the matching type")
	}
	if got := principal.DelegablePermissionGrants(); len(got) != 2 {
		t.Fatalf("delegation envelope = %#v", got)
	}

	rows = append(rows, authorizationdb.GetPrincipalRolePermissionsRow{
		RoleID: uuid.Must(uuid.NewV7()), GrantID: func() *uuid.UUID { id := uuid.Must(uuid.NewV7()); return &id }(), PermissionID: &permission, Scope: &anyDevice, MinimumAssurance: &minimum,
	})
	principal, err = LoadPermissions(context.Background(), permissionsQuerierStub{rows: rows}, Principal{AccountID: uuid.Must(uuid.NewV7())})
	if err != nil {
		t.Fatal(err)
	}
	if principal.Has(PeopleReadAll) {
		t.Fatal("any-device grant became effective without a device")
	}
	if got := principal.DelegablePermissionGrants(); len(got) != 3 {
		t.Fatalf("broadest delegation envelope = %#v", got)
	}
}

func TestScopeAwareDelegationLattice(t *testing.T) {
	typeA := uuid.Must(uuid.NewV7())
	typeB := uuid.Must(uuid.NewV7())
	selected := PermissionGrant{PermissionID: PeopleReadAll, Scope: GrantSelectedDeviceTypes, DeviceTypeIDs: []uuid.UUID{typeA, typeB}, MinimumAssurance: AssuranceNormal}
	principal := Principal{grants: map[Permission][]PermissionGrant{PeopleReadAll: {selected}}}
	if !principal.CanDelegate(PermissionGrant{PermissionID: PeopleReadAll, Scope: GrantSelectedDeviceTypes, DeviceTypeIDs: []uuid.UUID{typeA}, MinimumAssurance: AssuranceNormal}) {
		t.Fatal("selected-type subset was not delegable")
	}
	if principal.CanDelegate(PermissionGrant{PermissionID: PeopleReadAll, Scope: GrantAnyManagedDevice, MinimumAssurance: AssuranceNormal}) || principal.CanDelegate(PermissionGrant{PermissionID: PeopleReadAll, Scope: GrantEverywhere, MinimumAssurance: AssuranceNormal}) {
		t.Fatal("selected-type grant delegated a broader scope")
	}
	if principal.CanDelegate(PermissionGrant{PermissionID: PeopleReadAll, Scope: GrantSelectedDeviceTypes, DeviceTypeIDs: []uuid.UUID{uuid.Must(uuid.NewV7())}, MinimumAssurance: AssuranceNormal}) {
		t.Fatal("selected-type grant delegated an uncovered type")
	}

	principal.grants[PeopleReadAll] = []PermissionGrant{{PermissionID: PeopleReadAll, Scope: GrantAnyManagedDevice, MinimumAssurance: AssuranceLow}}
	if !principal.CanDelegate(selected) || principal.CanDelegate(PermissionGrant{PermissionID: PeopleReadAll, Scope: GrantEverywhere, MinimumAssurance: AssuranceNormal}) {
		t.Fatal("any-device delegation lattice is incorrect")
	}
	principal.grants[PeopleReadAll] = []PermissionGrant{{PermissionID: PeopleReadAll, Scope: GrantEverywhere, MinimumAssurance: AssuranceLow}}
	if !principal.CanDelegate(PermissionGrant{PermissionID: PeopleReadAll, Scope: GrantEverywhere, MinimumAssurance: AssuranceNormal}) {
		t.Fatal("global grant could not delegate globally")
	}
	if !(Principal{Master: true}).CanDelegate(PermissionGrant{PermissionID: PeopleDelete, Scope: GrantEverywhere, MinimumAssurance: AssuranceLow}) {
		t.Fatal("master did not preserve global delegation bypass")
	}
}
