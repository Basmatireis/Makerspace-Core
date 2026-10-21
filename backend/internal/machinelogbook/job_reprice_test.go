package machinelogbook

import (
	"context"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// setRuntimeRate changes the rate of the group's runtime rule for the given machine type.
func (f *jobFixture) setRuntimeRate(t *testing.T, typeID uuid.UUID, rate string) {
	t.Helper()
	var id uuid.UUID
	var version int64
	if err := f.pool.QueryRow(
		t.Context(),
		`SELECT id, version FROM pricing_rules WHERE pricing_group_id = $1 AND kind = 'machine_runtime' AND machine_type_id = $2`,
		f.group.ID,
		typeID,
	).Scan(&id, &version); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.UpdatePricingRule(
		t.Context(), f.p, id, version, "machine_runtime", &typeID, nil, nil, rate, true, &f.request,
	); err != nil {
		t.Fatal(err)
	}
}

func (f *jobFixture) reprice(t *testing.T, job MachineJob) MachineJob {
	t.Helper()
	repriced, err := f.s.RepriceMachineJob(t.Context(), f.p, job.ID, job.Version, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	return repriced
}

func TestRepriceMachineJobUsesTheCurrentRates(t *testing.T) {
	f := newJobFixture(t)
	job := f.create(t, f.input(-3*time.Hour, time.Hour, "successful"))
	if price(job.CalculatedPrice) != "10" || job.PricingSnapshot.Revision != 1 {
		t.Fatalf("created: %s revision %d", price(job.CalculatedPrice), job.PricingSnapshot.Revision)
	}
	f.setRuntimeRate(t, f.machine.MachineType.ID, "30")
	// Changing a rate alone leaves the job on its snapshot.
	unchanged, err := f.s.GetJob(t.Context(), f.p, job.ID)
	if err != nil || price(unchanged.CalculatedPrice) != "10" {
		t.Fatalf("before reprice: %v %s", err, price(unchanged.CalculatedPrice))
	}
	repriced := f.reprice(t, job)
	if price(repriced.CalculatedPrice) != "30" || repriced.PricingSnapshot.Revision != 2 ||
		repriced.PricingSnapshot.Reason != SnapshotManualReprice || repriced.Version <= job.Version {
		t.Fatalf(
			"repriced: price %s revision %d reason %s version %d->%d",
			price(repriced.CalculatedPrice),
			repriced.PricingSnapshot.Revision,
			repriced.PricingSnapshot.Reason,
			job.Version,
			repriced.Version,
		)
	}
	var audits int
	if err = f.pool.QueryRow(
		t.Context(),
		`SELECT count(*) FROM audit_events WHERE action = 'machine_job.repriced' AND resource_type = 'machine_job' AND resource_id = $1`,
		job.ID,
	).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("audit rows: %d %v", audits, err)
	}
	if _, err = f.s.RepriceMachineJob(t.Context(), f.p, job.ID, job.Version, &f.request); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale reprice: %v", err)
	}
	if _, err = f.s.RepriceMachineJob(t.Context(), f.p, job.ID, 0, &f.request); err == nil {
		t.Fatal("version 0 accepted")
	}
	if _, err = f.s.RepriceMachineJob(t.Context(), f.p, uuid.New(), 1, &f.request); !apperror.IsCode(err, "not_found") {
		t.Fatalf("missing job: %v", err)
	}
}

func TestRepriceCompletesAnIncompleteJobAndKeepsTheAdjustment(t *testing.T) {
	f := newJobFixture(t)
	input := f.input(-2*time.Hour, time.Hour, "successful")
	input.MachineID = f.bareMachine.ID
	job := f.create(t, input)
	if job.PricingStatus != "incomplete" {
		t.Fatalf("status = %s", job.PricingStatus)
	}
	job = f.adjust(t, job, "discount_percent", "50")
	typeID := f.bareMachine.MachineType.ID
	if _, err := f.s.CreatePricingRule(
		t.Context(), f.p, f.group.ID, "machine_runtime", &typeID, nil, nil, "40", &f.request,
	); err != nil {
		t.Fatal(err)
	}
	repriced := f.reprice(t, job)
	if repriced.PricingStatus != "complete" || price(repriced.CalculatedPrice) != "40" ||
		price(repriced.EffectivePrice) != "20" {
		t.Fatalf(
			"repriced: %s calculated=%s effective=%s",
			repriced.PricingStatus,
			price(repriced.CalculatedPrice),
			price(repriced.EffectivePrice),
		)
	}
}

func TestRepriceFallsBackWhenTheSnapshotGroupIsInactive(t *testing.T) {
	f := newJobFixture(t)
	ctx := t.Context()
	suffix := f.person.String()[:8]
	fallback, err := f.s.CreatePricingGroup(ctx, f.p, "Reprice fallback "+suffix, nil, false, &f.request)
	if err != nil {
		t.Fatal(err)
	}
	typeID := f.machine.MachineType.ID
	if _, err = f.s.CreatePricingRule(
		ctx, f.p, fallback.ID, "machine_runtime", &typeID, nil, nil, "20", &f.request,
	); err != nil {
		t.Fatal(err)
	}
	organization, err := f.s.CreateOrganization(
		ctx, f.p, "Reprice org "+suffix, OrganizationCompany, OrganizationDetailsInput{}, &f.request,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.pool.Exec(
		ctx,
		`INSERT INTO organization_pricing_group_assignments (organization_id, pricing_group_id, assigned_by_account_id) VALUES ($1, $2, $3)`,
		organization.ID,
		fallback.ID,
		f.p.AccountID,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_runs WHERE machine_id = $1`, f.machine.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM machine_jobs WHERE customer_organization_id = $1`, organization.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM organization_pricing_group_assignments WHERE organization_id = $1`, organization.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM organizations WHERE id = $1`, organization.ID)
		_, _ = f.pool.Exec(cleanup, `DELETE FROM pricing_groups WHERE id = $1`, fallback.ID)
	})
	input := f.input(-3*time.Hour, time.Hour, "successful")
	input.Customer = PartyReference{Kind: PartyOrganization, ID: organization.ID}
	job := f.create(t, input)
	if price(job.CalculatedPrice) != "10" {
		t.Fatalf("created: %s", price(job.CalculatedPrice))
	}
	// An active snapshot group is kept even though the organization maps to another group.
	f.setRuntimeRate(t, typeID, "12")
	kept := f.reprice(t, job)
	if price(kept.CalculatedPrice) != "12" || kept.PricingSnapshot.PricingGroupName != f.group.Name {
		t.Fatalf("kept group: %s %s", price(kept.CalculatedPrice), kept.PricingSnapshot.PricingGroupName)
	}
	if _, err = f.s.UpdatePricingGroup(
		ctx, f.p, f.group.ID, f.group.Version, f.group.Name, nil, false, false, &f.request,
	); err != nil {
		t.Fatal(err)
	}
	repriced := f.reprice(t, kept)
	if price(repriced.CalculatedPrice) != "20" || repriced.PricingSnapshot.PricingGroupName != fallback.Name ||
		repriced.PricingSnapshot.Revision != 3 {
		t.Fatalf(
			"fallback: %s %s revision %d",
			price(repriced.CalculatedPrice),
			repriced.PricingSnapshot.PricingGroupName,
			repriced.PricingSnapshot.Revision,
		)
	}
}

func TestRepriceRequiresTheJobEditPermission(t *testing.T) {
	f := newJobFixture(t)
	job := f.create(t, f.input(-3*time.Hour, time.Hour, "successful"))
	reader := restrictedPrincipal(t, f.pool, authorization.MachineJobsRead)
	if _, err := f.s.RepriceMachineJob(t.Context(), reader, job.ID, job.Version, &f.request); !apperror.IsCode(
		err,
		"permission_denied",
	) {
		t.Fatalf("reader: %v", err)
	}
	editor := restrictedPrincipal(t, f.pool, authorization.MachineJobsRead, authorization.MachineJobsEdit)
	if _, err := f.s.RepriceMachineJob(t.Context(), editor, job.ID, job.Version, &f.request); err != nil {
		t.Fatalf("editor: %v", err)
	}
}
