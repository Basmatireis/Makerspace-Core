package machinelogbook

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMachineLogbookOperationsRequireTheirPermissions(t *testing.T) {
	s := NewService(nil)
	ctx := t.Context()
	p := authorization.Principal{}
	id := uuid.Must(uuid.NewV7())
	now := time.Now().UTC()
	jobInput := JobInput{MachineID: id, StartsAt: now, EndsAt: now.Add(time.Hour), Customer: PartyReference{Kind: "person", ID: id}, OperatorPersonID: id, Outcome: "successful"}

	tests := []struct {
		name string
		call func() error
	}{
		{"machines.read", func() error { _, err := s.ListMachineTypes(ctx, p); return err }},
		{"machines.manage", func() error { _, err := s.CreateMachineType(ctx, p, "Printer", nil); return err }},
		{"machine_jobs.read", func() error { _, err := s.GetJob(ctx, p, id); return err }},
		{"machine_jobs.create", func() error { _, err := s.CreateManualJob(ctx, p, jobInput, nil); return err }},
		{"machine_jobs.edit", func() error { _, err := s.UpdateJobFacts(ctx, p, id, 1, jobInput, nil); return err }},
		{"machine_jobs.review", func() error { _, err := s.ReviewQueue(ctx, p); return err }},
		{"machine_jobs.override_price", func() error { _, err := s.OverrideJobPrice(ctx, p, id, 1, "1", "test", nil); return err }},
		{"inventory.read", func() error { _, _, _, err := s.ListMaterials(ctx, p, "", "", "", 1, 25); return err }},
		{"inventory.manage", func() error { _, err := s.CreateMaterial(ctx, p, "PLA", "pla", nil, "g", nil, nil); return err }},
		{"organizations.read", func() error { _, _, err := s.ListOrganizations(ctx, p, "", nil, 1, 25); return err }},
		{"organizations.manage", func() error { _, err := s.CreateOrganization(ctx, p, "Institute", "institute", nil); return err }},
		{"pricing.read", func() error { _, err := s.ListPricingGroups(ctx, p); return err }},
		{"pricing.manage", func() error { _, err := s.CreatePricingGroup(ctx, p, "Standard", nil, false, nil); return err }},
		{"statistics.read", func() error { _, err := s.Statistics(ctx, p, now.Add(-time.Hour), now); return err }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.call(); !apperror.IsCode(err, "permission_denied") {
				t.Fatalf("expected permission_denied, got %v", err)
			}
		})
	}
}

func TestPricingHelpersAreExactAndMetadataComparisonIsSemantic(t *testing.T) {
	startsAt := time.Unix(0, 0).UTC()
	endsAt := startsAt.Add(90*time.Minute + 500*time.Millisecond)
	if got := runtimeHours(startsAt, endsAt).String(); got != "1.5001388888888889" {
		t.Fatalf("runtime hours = %s", got)
	}
	if !metadataEqual([]byte(`{"b":2,"a":1}`), []byte("{\n  \"a\": 1, \"b\": 2\n}")) {
		t.Fatal("equivalent JSON metadata did not compare equal")
	}
	if metadataEqual([]byte(`{"a":1}`), []byte(`{"a":1.0}`)) {
		t.Fatal("numerically distinct JSON payload spellings were treated as identical")
	}
}

func integrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(t.Context(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if err = pool.Ping(t.Context()); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestMachineLogbookPostgresVerticalSlice(t *testing.T) {
	pool := integrationPool(t)
	ctx := t.Context()
	s := NewService(pool)
	personID := uuid.Must(uuid.NewV7())
	accountID := uuid.Must(uuid.NewV7())
	requestID := uuid.Must(uuid.NewV7())
	suffix := strings.ReplaceAll(personID.String(), "-", "")[:12]
	p := authorization.Principal{AccountID: accountID, PersonID: personID, Master: true}

	if _, err := pool.Exec(ctx, `INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Test', 'Operator', $2)`, personID, "machine-logbook-"+suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, accountID, personID); err != nil {
		t.Fatal(err)
	}

	var machineID, machineTypeID, materialID, pricingGroupID uuid.UUID
	organizationIDs := make([]uuid.UUID, 0, 2)
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM audit_events WHERE request_id = $1`, requestID)
		if materialID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, `DELETE FROM inventory_transactions WHERE material_id = $1`, materialID)
		}
		if machineID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, `DELETE FROM machine_jobs WHERE machine_id = $1`, machineID)
		}
		for _, id := range organizationIDs {
			_, _ = pool.Exec(cleanupCtx, `DELETE FROM organizations WHERE id = $1`, id)
		}
		if pricingGroupID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, `DELETE FROM pricing_groups WHERE id = $1`, pricingGroupID)
		}
		if machineID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, `DELETE FROM machines WHERE id = $1`, machineID)
		}
		if materialID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, `DELETE FROM materials WHERE id = $1`, materialID)
		}
		if machineTypeID != uuid.Nil {
			_, _ = pool.Exec(cleanupCtx, `DELETE FROM machine_types WHERE id = $1`, machineTypeID)
		}
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM accounts WHERE id = $1`, accountID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM people WHERE id = $1`, personID)
	})

	machineType, err := s.CreateMachineType(ctx, p, "Test printer "+suffix, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	machineTypeID = machineType.ID
	externalIdentifier := "collector-" + suffix
	machine, err := s.CreateMachine(ctx, p, machineType.ID, "Test machine "+suffix, "active", &externalIdentifier, true, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	machineID = machine.ID
	threshold := "100"
	material, err := s.CreateMaterial(ctx, p, "Test PLA "+suffix, "pla", nil, "g", &threshold, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	materialID = material.ID

	firstPurchase, err := s.AddPurchase(ctx, p, material.ID, material.InventoryVersion, "1000", "18", time.Now().UTC(), nil, nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	secondPurchase, err := s.AddPurchase(ctx, p, material.ID, firstPurchase.Material.InventoryVersion, "1000", "22", time.Now().UTC(), nil, nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if secondPurchase.Material.Quantity != "2000" || secondPurchase.Material.InventoryValue != "40" || secondPurchase.Material.AverageUnitCost != "0.02" {
		t.Fatalf("unexpected weighted balance: %+v", secondPurchase.Material)
	}

	group, err := s.CreatePricingGroup(ctx, p, "Test pricing "+suffix, nil, false, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	pricingGroupID = group.ID
	runtimeRule, err := s.CreatePricingRule(ctx, p, group.ID, "machine_runtime", &machineType.ID, nil, nil, "0.5", &requestID)
	if err != nil {
		t.Fatal(err)
	}
	category, unit := "pla", "g"
	materialRule, err := s.CreatePricingRule(ctx, p, group.ID, "material", nil, &category, &unit, "0.025", &requestID)
	if err != nil {
		t.Fatal(err)
	}
	_ = runtimeRule

	organization, err := s.CreateOrganization(ctx, p, "Test Institute "+suffix, "institute", &requestID)
	if err != nil {
		t.Fatal(err)
	}
	organizationIDs = append(organizationIDs, organization.ID)
	assignment, err := s.SetPartyPricingGroup(ctx, p, PartyReference{Kind: "organization", ID: organization.ID}, &group.ID, 0, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if assignment.PricingGroupAssignmentVersion != 1 {
		t.Fatalf("assignment version = %d", assignment.PricingGroupAssignmentVersion)
	}

	startsAt := time.Date(2026, time.September, 15, 8, 12, 0, 0, time.UTC)
	automatic := AutomaticJobInput{MachineID: machine.ID, StartsAt: startsAt, EndsAt: startsAt.Add(3*time.Hour + 14*time.Minute), ExternalID: "job-" + suffix, ExternalMetadata: []byte(`{"b":2,"a":1}`), Usages: []UsageInput{{MaterialID: material.ID, Quantity: "183"}}}
	pending, created, err := s.IngestAutomaticJob(ctx, p, automatic, &requestID)
	if err != nil || !created {
		t.Fatalf("automatic ingest created=%v err=%v", created, err)
	}
	beforeReview, err := s.GetMaterial(ctx, p, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if beforeReview.Quantity != "2000" {
		t.Fatalf("pending job changed inventory to %s", beforeReview.Quantity)
	}
	automatic.ExternalMetadata = []byte(`{"a":1,"b":2}`)
	repeated, created, err := s.IngestAutomaticJob(ctx, p, automatic, &requestID)
	if err != nil || created || repeated.ID != pending.ID {
		t.Fatalf("idempotent ingest created=%v id=%s err=%v", created, repeated.ID, err)
	}
	conflicting := automatic
	conflicting.Usages = []UsageInput{{MaterialID: material.ID, Quantity: "184"}}
	if _, _, err = s.IngestAutomaticJob(ctx, p, conflicting, &requestID); !apperror.IsCode(err, "external_job_mismatch") {
		t.Fatalf("expected external_job_mismatch, got %v", err)
	}

	confirmed, err := s.ConfirmJob(ctx, p, pending.ID, pending.Version, PartyReference{Kind: "organization", ID: organization.ID}, personID, "successful", nil, nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if confirmed.PricingStatus != "complete" || confirmed.CalculatedPrice == nil || *confirmed.CalculatedPrice != "6.19" {
		t.Fatalf("unexpected confirmed price: %+v", confirmed)
	}
	if confirmed.PricingSnapshot == nil || confirmed.PricingSnapshot.Revision != 1 || len(confirmed.PricingSnapshot.Rules) != 2 {
		t.Fatalf("unexpected pricing snapshot: %+v", confirmed.PricingSnapshot)
	}
	for _, rule := range confirmed.PricingSnapshot.Rules {
		if rule.SourceRuleID == nil {
			t.Fatalf("complete snapshot rule lacks source ID: %+v", rule)
		}
	}
	afterReview, err := s.GetMaterial(ctx, p, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterReview.Quantity != "1817" || afterReview.InventoryValue != "36.34" {
		t.Fatalf("review did not atomically consume stock: %+v", afterReview)
	}

	correctedJob, err := s.ReplaceJobUsages(ctx, p, confirmed.ID, confirmed.Version, []UsageInput{{MaterialID: material.ID, Quantity: "180"}}, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if correctedJob.CalculatedPrice == nil || *correctedJob.CalculatedPrice != "6.12" {
		t.Fatalf("usage correction price = %v", correctedJob.CalculatedPrice)
	}

	failedJob, err := s.CreateManualJob(ctx, p, JobInput{MachineID: machine.ID, StartsAt: startsAt.Add(24 * time.Hour), EndsAt: startsAt.Add(25 * time.Hour), Customer: PartyReference{Kind: "person", ID: personID}, OperatorPersonID: personID, Outcome: "failed", PricingGroupID: &group.ID, Usages: []UsageInput{{MaterialID: material.ID, Quantity: "17"}}}, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if failedJob.CalculatedPrice == nil || *failedJob.CalculatedPrice != "0.93" {
		t.Fatalf("half-up rounded price = %v", failedJob.CalculatedPrice)
	}
	afterFailure, err := s.GetMaterial(ctx, p, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterFailure.Quantity != "1803" {
		t.Fatalf("failed job consumption was not retained: %s", afterFailure.Quantity)
	}

	materialRule, err = s.UpdatePricingRule(ctx, p, materialRule.ID, materialRule.Version, "material", nil, &category, &unit, "0.03", true, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	_ = materialRule
	overridden, err := s.OverrideJobPrice(ctx, p, correctedJob.ID, correctedJob.Version, "7", "approved exception", &requestID)
	if err != nil {
		t.Fatal(err)
	}
	organization2, err := s.CreateOrganization(ctx, p, "Test Partner "+suffix, "company", &requestID)
	if err != nil {
		t.Fatal(err)
	}
	organizationIDs = append(organizationIDs, organization2.ID)
	if _, err = s.SetPartyPricingGroup(ctx, p, PartyReference{Kind: "organization", ID: organization2.ID}, &group.ID, 0, &requestID); err != nil {
		t.Fatal(err)
	}
	repriced, err := s.UpdateJobFacts(ctx, p, overridden.ID, overridden.Version, JobInput{MachineID: machine.ID, StartsAt: startsAt, EndsAt: startsAt.Add(3*time.Hour + 14*time.Minute), Customer: PartyReference{Kind: "organization", ID: organization2.ID}, OperatorPersonID: personID, Outcome: "successful"}, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if repriced.PricingSnapshot == nil || repriced.PricingSnapshot.Revision != 2 || repriced.PricingSnapshot.Reason != "customer_changed" {
		t.Fatalf("unexpected repricing snapshot: %+v", repriced.PricingSnapshot)
	}
	if repriced.CalculatedPrice == nil || *repriced.CalculatedPrice != "7.02" || repriced.FinalPrice == nil || *repriced.FinalPrice != "7" || repriced.EffectivePrice == nil || *repriced.EffectivePrice != "7" {
		t.Fatalf("reprice did not preserve override: %+v", repriced)
	}
	var revisions int
	var snapshotAmounts []string
	if err = pool.QueryRow(ctx, `SELECT count(*), array_agg(calculated_amount::text ORDER BY revision) FROM machine_job_pricing_snapshots WHERE machine_job_id = $1`, repriced.ID).Scan(&revisions, &snapshotAmounts); err != nil {
		t.Fatal(err)
	}
	if revisions != 2 || len(snapshotAmounts) != 2 || snapshotAmounts[0] != "6.19" || snapshotAmounts[1] != "7.02" {
		t.Fatalf("immutable snapshot revisions = %d %v", revisions, snapshotAmounts)
	}

	billingReference := "invoice-" + suffix
	billed, err := s.UpdateJobBilling(ctx, p, repriced.ID, repriced.Version, "billed", &billingReference, nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.UpdateJobFacts(ctx, p, billed.ID, billed.Version, JobInput{MachineID: machine.ID, StartsAt: startsAt, EndsAt: startsAt.Add(3*time.Hour + 14*time.Minute), Customer: PartyReference{Kind: "organization", ID: organization2.ID}, OperatorPersonID: personID, Outcome: "successful"}, &requestID); !apperror.IsCode(err, "job_billed") {
		t.Fatalf("expected billed edit rejection, got %v", err)
	}

	current, err := s.GetMaterial(ctx, p, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	type mutationResult struct{ err error }
	results := make(chan mutationResult, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, mutationErr := s.RecordConsumption(context.Background(), p, material.ID, current.InventoryVersion, "1", time.Now().UTC(), false, nil, nil, &requestID)
			results <- mutationResult{err: mutationErr}
		}()
	}
	wg.Wait()
	close(results)
	errorsSeen := make([]error, 0, 2)
	for result := range results {
		errorsSeen = append(errorsSeen, result.err)
	}
	successes, staleWrites := 0, 0
	for _, mutationErr := range errorsSeen {
		if mutationErr == nil {
			successes++
		} else if apperror.IsCode(mutationErr, "stale_write") {
			staleWrites++
		} else {
			t.Fatalf("unexpected concurrent mutation error: %v", mutationErr)
		}
	}
	if successes != 1 || staleWrites != 1 {
		t.Fatalf("concurrent mutations successes=%d stale=%d", successes, staleWrites)
	}

	current, err = s.GetMaterial(ctx, p, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	corrected, err := s.CorrectStock(ctx, p, material.ID, current.InventoryVersion, "1810", nil, time.Now().UTC(), "inventory_count", nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	reason := "disposed"
	disposed, err := s.RecordConsumption(ctx, p, material.ID, corrected.Material.InventoryVersion, "10", time.Now().UTC(), true, &reason, nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	empty, err := s.MarkEmpty(ctx, p, material.ID, disposed.Material.InventoryVersion, time.Now().UTC(), nil, &requestID)
	if err != nil {
		t.Fatal(err)
	}
	if empty.Material.Quantity != "0" || empty.Material.InventoryValue != "0" {
		t.Fatalf("mark empty balance: %+v", empty.Material)
	}
	transactions, total, err := s.ListMaterialTransactions(ctx, p, material.ID, 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if total != 10 || len(transactions) != 10 {
		t.Fatalf("transaction history total=%d len=%d", total, len(transactions))
	}
	if transactions[0].AdjustmentReason == nil || *transactions[0].AdjustmentReason != "mark_empty" {
		t.Fatalf("latest transaction is not mark-empty: %+v", transactions[0])
	}

	filtered, total, err := s.ListJobs(ctx, p, JobFilters{MachineID: &machine.ID, CustomerID: &organization2.ID, OperatorID: &personID, MaterialID: &material.ID, Outcome: stringPointer("successful"), BillingStatus: stringPointer("billed"), Source: stringPointer("automatic"), ReviewState: stringPointer("confirmed"), From: timePointer(startsAt.Add(-time.Minute)), To: timePointer(startsAt.Add(24 * time.Hour)), Page: 1, PageSize: 25})
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(filtered) != 1 || filtered[0].ID != billed.ID {
		t.Fatalf("combined job filters returned total=%d jobs=%+v", total, filtered)
	}
	statistics, err := s.Statistics(ctx, p, startsAt.Add(-time.Hour), startsAt.Add(48*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(statistics.MaterialUsageByCategory) == 0 || len(statistics.MachineRuntimeHours) == 0 || len(statistics.MachineJobCounts) == 0 || len(statistics.MachineFailureRates) == 0 {
		t.Fatalf("statistics omitted expected series: %+v", statistics)
	}

	if _, err = pool.Exec(ctx, `DELETE FROM people WHERE id = $1`, personID); err != nil {
		t.Fatalf("person hard deletion was blocked: %v", err)
	}
	deletedPartyJob, err := s.GetJob(ctx, p, failedJob.ID)
	if err != nil {
		t.Fatal(err)
	}
	if deletedPartyJob.Customer != nil || deletedPartyJob.Operator != nil {
		t.Fatalf("deleted person references were retained: customer=%+v operator=%+v", deletedPartyJob.Customer, deletedPartyJob.Operator)
	}
	organizationJob, err := s.GetJob(ctx, p, billed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if organizationJob.Customer == nil || organizationJob.Operator != nil {
		t.Fatalf("organization customer should remain while deleted operator is nulled: customer=%+v operator=%+v", organizationJob.Customer, organizationJob.Operator)
	}
}

func timePointer(value time.Time) *time.Time { return &value }
