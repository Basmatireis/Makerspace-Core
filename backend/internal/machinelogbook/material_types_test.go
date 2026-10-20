package machinelogbook

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

func strPtr(value string) *string { return &value }

func TestMaterialTypeLifecycleAuditAndGuards(t *testing.T) {
	pool := integrationPool(t)
	ctx := t.Context()
	s := NewService(pool)
	account, person, request := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	suffix := strings.ReplaceAll(person.String(), "-", "")[:12]
	p := authorization.Principal{AccountID: account, PersonID: person, Master: true}
	if _, err := pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Type', 'Tester', $2)`, person, "types-"+suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, account, person); err != nil {
		t.Fatal(err)
	}
	var typeIDs []uuid.UUID
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = pool.Exec(cleanup, `DELETE FROM audit_events WHERE request_id = $1`, request)
		_, _ = pool.Exec(cleanup, `DELETE FROM materials WHERE material_type_id = ANY($1)`, typeIDs)
		_, _ = pool.Exec(cleanup, `DELETE FROM material_types WHERE id = ANY($1)`, typeIDs)
		_, _ = pool.Exec(cleanup, `DELETE FROM accounts WHERE id = $1`, account)
		_, _ = pool.Exec(cleanup, `DELETE FROM people WHERE id = $1`, person)
	})

	created, err := s.CreateMaterialType(
		ctx,
		p,
		"  PETG-CF "+suffix+"  ",
		"g",
		[]string{"fdm_printing", "other"},
		&request,
	)
	if err != nil {
		t.Fatal(err)
	}
	typeIDs = append(typeIDs, created.ID)
	if created.Name != "PETG-CF "+suffix || created.Unit != "g" || !created.Active || created.Version != 1 ||
		created.MaterialCount != 0 {
		t.Fatalf("created type: %+v", created)
	}
	// Names are unique ignoring case; units come from a fixed set.
	if _, err = s.CreateMaterialType(ctx, p, strings.ToLower(created.Name), "g", []string{"fdm_printing", "other"}, &request); !apperror.IsCode(
		err,
		"material_type_exists",
	) {
		t.Fatalf("duplicate name: %v", err)
	}
	if _, err = s.CreateMaterialType(ctx, p, "Bad unit "+suffix, "kg", []string{"other"}, &request); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("invalid unit: %v", err)
	}
	if _, err = s.CreateMaterialType(ctx, p, "   ", "g", []string{"fdm_printing", "other"}, &request); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("blank name: %v", err)
	}

	// A material takes the unit of its type; a different unit is refused.
	wrong := "ml"
	if _, err = s.CreateMaterial(ctx, p, MaterialInput{Name: "Wrong unit " + suffix, MaterialTypeID: created.ID, Unit: &wrong}, &request); !apperror.IsCode(
		err,
		"material_unit_mismatch",
	) {
		t.Fatalf("unit mismatch: %v", err)
	}
	right := "g"
	material, err := s.CreateMaterial(
		ctx,
		p,
		MaterialInput{
			Name:           "Carbon grey " + suffix,
			MaterialTypeID: created.ID,
			Unit:           &right,
			ColorName:      strPtr(" Carbon grey "),
			ColorHex:       strPtr("#3A3A3C"),
		},
		&request,
	)
	if err != nil {
		t.Fatal(err)
	}
	if material.Unit != "g" || material.MaterialTypeID != created.ID || material.MaterialTypeName != created.Name ||
		material.ColorName == nil ||
		*material.ColorName != "Carbon grey" ||
		material.ColorHex == nil ||
		*material.ColorHex != "#3A3A3C" {
		t.Fatalf("material: %+v", material)
	}
	for _, hex := range []string{"#3a3a3c", "3A3A3C", "#3A3A3", "#GGGGGG", "#3A3A3C0"} {
		if _, err = s.CreateMaterial(ctx, p, MaterialInput{Name: "Bad hex " + suffix, MaterialTypeID: created.ID, ColorHex: strPtr(hex)}, &request); !apperror.IsCode(
			err,
			"validation_failed",
		) {
			t.Fatalf("colour code %q: %v", hex, err)
		}
	}
	// Moving the material to a type with another unit is refused by the stock rule once stock exists.
	other, err := s.CreateMaterialType(ctx, p, "Resin "+suffix, "ml", []string{"fdm_printing", "other"}, &request)
	if err != nil {
		t.Fatal(err)
	}
	typeIDs = append(typeIDs, other.ID)
	purchase, err := s.AddPurchase(
		ctx,
		p,
		material.ID,
		material.InventoryVersion,
		"100",
		"5",
		time.Now().UTC(),
		nil,
		nil,
		&request,
	)
	if err != nil {
		t.Fatal(err)
	}
	material = purchase.Material
	if _, err = s.UpdateMaterial(ctx, p, material.ID, MaterialInput{Name: material.Name, MaterialTypeID: other.ID, Active: true, ExpectedVersion: material.Version}, &request); !apperror.IsCode(
		err,
		"material_unit_in_use",
	) {
		t.Fatalf("type change with stock: %v", err)
	}

	// A referenced type cannot be deleted nor change its unit; deactivating works,
	// existing materials keep working and new ones are refused.
	current, err := s.GetMaterialType(ctx, p, created.ID)
	if err != nil || current.MaterialCount != 1 {
		t.Fatalf("type with material: %+v %v", current, err)
	}
	if err = s.DeleteMaterialType(ctx, p, created.ID, current.Version, &request); !apperror.IsCode(
		err,
		"material_type_in_use",
	) {
		t.Fatalf("delete referenced type: %v", err)
	}
	if _, err = s.UpdateMaterialType(ctx, p, created.ID, current.Version, created.Name, "ml", nil, true, &request); !apperror.IsCode(
		err,
		"material_type_unit_in_use",
	) {
		t.Fatalf("unit change of referenced type: %v", err)
	}
	if _, err = s.UpdateMaterialType(ctx, p, created.ID, current.Version+5, created.Name, "g", nil, true, &request); !apperror.IsCode(
		err,
		"stale_write",
	) &&
		!apperror.IsCode(err, "version_conflict") {
		t.Fatalf("stale update: %v", err)
	}
	deactivated, err := s.UpdateMaterialType(
		ctx,
		p,
		created.ID,
		current.Version,
		"PETG carbon "+suffix,
		"g",
		nil,
		false,
		&request,
	)
	if err != nil || deactivated.Active || deactivated.Version != current.Version+1 {
		t.Fatalf("deactivate: %+v %v", deactivated, err)
	}
	if _, err = s.CreateMaterial(ctx, p, MaterialInput{Name: "Second " + suffix, MaterialTypeID: created.ID}, &request); !apperror.IsCode(
		err,
		"material_type_inactive",
	) {
		t.Fatalf("material on inactive type: %v", err)
	}
	if _, err = s.UpdateMaterial(ctx, p, material.ID, MaterialInput{Name: material.Name, MaterialTypeID: created.ID, ColorName: material.ColorName, ColorHex: material.ColorHex, Active: true, ExpectedVersion: material.Version}, &request); err != nil {
		t.Fatalf("existing material on inactive type: %v", err)
	}

	// An unused type is deleted for good with one audit event, a stale version is refused.
	if err = s.DeleteMaterialType(ctx, p, other.ID, other.Version+1, &request); !apperror.IsCode(err, "stale_write") &&
		!apperror.IsCode(err, "version_conflict") {
		t.Fatalf("stale delete: %v", err)
	}
	if err = s.DeleteMaterialType(ctx, p, other.ID, other.Version, &request); err != nil {
		t.Fatal(err)
	}
	if _, err = s.GetMaterialType(ctx, p, other.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("deleted type: %v", err)
	}
	var created1, updated1, deleted1 int
	if err = pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE action = 'material_type.created'), count(*) FILTER (WHERE action = 'material_type.updated'), count(*) FILTER (WHERE action = 'material_type.deleted' AND resource_id = $2)
		FROM audit_events WHERE request_id = $1`, request, other.ID).Scan(&created1, &updated1, &deleted1); err != nil {
		t.Fatal(err)
	}
	if created1 != 2 || updated1 != 1 || deleted1 != 1 {
		t.Fatalf("audit events created=%d updated=%d deleted=%d", created1, updated1, deleted1)
	}

	// Without a permission nothing is read or written.
	nobody := authorization.Principal{AccountID: uuid.Must(uuid.NewV7())}
	if _, err = s.ListMaterialTypes(ctx, nobody); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("list without permission: %v", err)
	}
	if _, err = s.CreateMaterialType(ctx, nobody, "Nope "+suffix, "g", []string{"fdm_printing", "other"}, nil); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("create without permission: %v", err)
	}
}

// Prices attach to the material type: a type without a rule leaves the price
// incomplete, an explicit rate of 0 makes its material free, and snapshots keep
// their rates when the rule, the type name or the material's colour change.
func TestPricingPerMaterialTypeIncompleteZeroAndSnapshotStability(t *testing.T) {
	pool := integrationPool(t)
	var extraMaterials, extraTypes []uuid.UUID
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		for _, id := range extraMaterials {
			_, _ = pool.Exec(cleanup, `DELETE FROM machine_run_usages WHERE material_id = $1`, id)
			_, _ = pool.Exec(cleanup, `DELETE FROM inventory_transactions WHERE material_id = $1`, id)
			_, _ = pool.Exec(cleanup, `DELETE FROM materials WHERE id = $1`, id)
		}
		_, _ = pool.Exec(cleanup, `DELETE FROM material_types WHERE id = ANY($1)`, extraTypes)
	})
	f := newJobFixture(t)
	ctx := t.Context()
	suffix := strings.ReplaceAll(f.person.String(), "-", "")[:12]
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}

	// A second type with a stocked material but no rule in the fixture's group.
	tpuType, err := f.s.CreateMaterialType(
		ctx,
		f.p,
		"Jobs TPU "+suffix,
		"g",
		[]string{"fdm_printing", "other"},
		&f.request,
	)
	must(err)
	extraTypes = append(extraTypes, tpuType.ID)
	tpu, err := f.s.CreateMaterial(
		ctx,
		f.p,
		MaterialInput{Name: "Jobs TPU " + suffix, MaterialTypeID: tpuType.ID, ColorName: strPtr("Natural")},
		&f.request,
	)
	must(err)
	extraMaterials = append(extraMaterials, tpu.ID)
	_, err = f.s.AddPurchase(ctx, f.p, tpu.ID, tpu.InventoryVersion, "500", "20", f.now, nil, nil, &f.request)
	must(err)

	input := f.input(-3*time.Hour, time.Hour, "successful")
	input.Usages = []UsageInput{{MaterialID: f.material.ID, Quantity: "100"}, {MaterialID: tpu.ID, Quantity: "50"}}
	job := f.create(t, input)
	if job.PricingStatus != "incomplete" || job.CalculatedPrice != nil {
		t.Fatalf(
			"a type without rule must leave pricing incomplete: %s %s",
			job.PricingStatus,
			price(job.CalculatedPrice),
		)
	}
	missing := 0
	for _, rule := range job.PricingSnapshot.Rules {
		if rule.Kind == "material" && rule.Missing && rule.Label == tpu.Name && rule.Selector == tpuType.Name {
			missing++
		}
	}
	if missing != 1 {
		t.Fatalf("snapshot rules: %+v", job.PricingSnapshot.Rules)
	}
	var linked int
	must(
		pool.QueryRow(ctx, `SELECT count(*) FROM machine_job_pricing_snapshot_rules WHERE snapshot_id = $1 AND kind = 'material' AND material_type_id IN ($2, $3)`, job.PricingSnapshot.ID, f.materialType.ID, tpuType.ID).
			Scan(&linked),
	)
	if linked != 2 {
		t.Fatalf("snapshot rules linked to material types = %d", linked)
	}

	// An explicit rate of 0 is a price: TPU becomes free, PLA stays at 0.1 per gram.
	zeroRule, err := f.s.CreatePricingRule(ctx, f.p, f.group.ID, "material", nil, &tpuType.ID, nil, "0", &f.request)
	must(err)
	if zeroRule.MaterialTypeID == nil || *zeroRule.MaterialTypeID != tpuType.ID || zeroRule.MaterialUnit == nil ||
		*zeroRule.MaterialUnit != "g" ||
		zeroRule.MaterialTypeName == nil ||
		*zeroRule.MaterialTypeName != tpuType.Name {
		t.Fatalf("rule: %+v", zeroRule)
	}
	if _, err = f.s.CreatePricingRule(ctx, f.p, f.group.ID, "material", nil, &tpuType.ID, nil, "0.2", &f.request); !apperror.IsCode(
		err,
		"already_exists",
	) &&
		!apperror.IsCode(err, "conflict") {
		t.Fatalf("second active rule for one type: %v", err)
	}
	repriced := f.edit(t, job, func(u *JobUpdate) { u.PricingGroupID = &f.group.ID })
	if repriced.PricingStatus != "complete" || price(repriced.CalculatedPrice) != "20" {
		t.Fatalf("with a zero rate: %s %s", repriced.PricingStatus, price(repriced.CalculatedPrice))
	}

	// Snapshots keep their rates: rule edits, renamed types and recoloured materials change nothing.
	_, err = f.s.UpdatePricingRule(
		ctx,
		f.p,
		zeroRule.ID,
		zeroRule.Version,
		"material",
		nil,
		&tpuType.ID,
		nil,
		"5",
		true,
		&f.request,
	)
	must(err)
	renamed, err := f.s.UpdateMaterialType(
		ctx,
		f.p,
		tpuType.ID,
		tpuType.Version,
		"Renamed TPU "+suffix,
		"g",
		nil,
		true,
		&f.request,
	)
	must(err)
	_, err = f.s.UpdateMaterial(
		ctx,
		f.p,
		tpu.ID,
		MaterialInput{
			Name:            tpu.Name,
			MaterialTypeID:  renamed.ID,
			ColorName:       strPtr("Blue"),
			ColorHex:        strPtr("#0000FF"),
			Active:          true,
			ExpectedVersion: tpu.Version,
		},
		&f.request,
	)
	must(err)
	run := repriced.Runs[0]
	result, err := f.s.ReplaceRunUsages(
		ctx,
		f.p,
		run.ID,
		run.Version,
		[]UsageInput{{MaterialID: f.material.ID, Quantity: "100"}, {MaterialID: tpu.ID, Quantity: "80"}},
		&f.request,
	)
	must(err)
	if result.Job.PricingStatus != "complete" || price(result.Job.CalculatedPrice) != "20" ||
		result.Job.PricingSnapshot.Revision != repriced.PricingSnapshot.Revision {
		t.Fatalf(
			"snapshot rate must stay 0 for TPU: %s %s revision %d",
			result.Job.PricingStatus,
			price(result.Job.CalculatedPrice),
			result.Job.PricingSnapshot.Revision,
		)
	}
	// A new snapshot picks up the current rule.
	fresh := f.edit(t, *result.Job, func(u *JobUpdate) { u.PricingGroupID = &f.group.ID })
	if price(fresh.CalculatedPrice) != "420" {
		t.Fatalf("new snapshot with TPU at 5 per gram: %s", price(fresh.CalculatedPrice))
	}

	// The rule's type must exist and be active when chosen, material rules need no machine type.
	if _, err = f.s.CreatePricingRule(ctx, f.p, f.group.ID, "material", nil, nil, nil, "1", &f.request); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("material rule without type: %v", err)
	}
	unknown := uuid.Must(uuid.NewV7())
	if _, err = f.s.CreatePricingRule(ctx, f.p, f.group.ID, "material", nil, &unknown, nil, "1", &f.request); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("rule for unknown type: %v", err)
	}
}
