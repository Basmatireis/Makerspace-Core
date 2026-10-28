package integration_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacycatalog"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func retentionEngine(t *testing.T, pool *pgxpool.Pool, audit, signup time.Duration) *privacy.Service {
	t.Helper()
	catalog, err := privacycatalog.Catalog()
	if err != nil {
		t.Fatal(err)
	}
	service := privacy.NewService(pool, catalog)
	privacycatalog.RegisterBuiltinHandlers(service, nil, privacy.LegacyPeriods{AuditRetention: &audit, EventSignupRetention: &signup})
	return service
}

func countRows(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// The legacy run of the engine deletes exactly what the former admin cleanup deleted; a dry run reports the
// same counts without changing anything; a category hold skips its category.
func TestLegacyRetentionRunMatchesTheFormerCleanup(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	account := seedAccount(t, pool, "retention-legacy", true)
	// Three audit events: two old, one recent.
	for _, age := range []string{"400 days", "370 days", "10 days"} {
		if _, err := pool.Exec(ctx, `INSERT INTO audit_events (id, actor_type, actor_account_id, action, resource_type, occurred_at, changed_fields, metadata, source)
			VALUES ($1, 'user', $2, 'test.event', 'test', now() - $3::interval, '{}', '{}', 'http')`, ids.New(), account.accountID, age); err != nil {
			t.Fatal(err)
		}
	}
	// Two password reset tokens: one expired, one still valid.
	other := seedAccount(t, pool, "retention-other", false)
	for index, token := range []struct {
		account   uuid.UUID
		createdAt string
		expiresAt string
	}{
		{account.accountID, "-2 hours", "-1 hour"},
		{other.accountID, "-1 minute", "+1 hour"},
	} {
		digest := make([]byte, 32)
		digest[0] = byte(index + 1)
		if _, err := pool.Exec(ctx, `INSERT INTO password_reset_tokens (id, account_id, token_digest, created_at, expires_at)
			VALUES ($1, $2, $3, now() + $4::interval, now() + $5::interval)`,
			ids.New(), token.account, digest, token.createdAt, token.expiresAt); err != nil {
			t.Fatal(err)
		}
	}
	engine := retentionEngine(t, pool, 365*24*time.Hour, 180*24*time.Hour)

	dry, err := engine.RunLegacyCleanup(ctx, privacy.ModeDryRun, nil)
	if err != nil {
		t.Fatal(err)
	}
	affected := map[privacy.CategoryID]int64{}
	for _, item := range dry.Items {
		affected[item.Category] = item.Affected
		// The timelapse handler needs the run recordings service, which this fixture leaves out.
		if item.Status != privacy.ItemApplied && item.Category != privacycatalog.RunTimelapses {
			t.Fatalf("dry run item %+v", item)
		}
	}
	if affected["audit.events"] != 2 || affected["auth.sessions"] < 1 {
		t.Fatalf("dry run counts = %+v", affected)
	}
	if countRows(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'test.event'`) != 3 ||
		countRows(t, pool, `SELECT count(*) FROM password_reset_tokens`) != 2 {
		t.Fatal("dry run changed data")
	}

	// A hold on the audit category keeps the events.
	manager := seedAccount(t, pool, "retention-manager", true)
	principal := authorization.Principal{AccountID: manager.accountID, PersonID: manager.personID, Master: true}
	category := privacycatalog.AuditEvents
	hold, err := engine.CreateHold(ctx, principal, &category, nil, "legal inquiry", nil)
	if err != nil {
		t.Fatal(err)
	}
	run, err := engine.RunLegacyCleanup(ctx, privacy.ModeExecute, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range run.Items {
		switch item.Category {
		case "audit.events":
			if item.Status != privacy.ItemSkippedHold {
				t.Fatalf("held category ran: %+v", item)
			}
		case "auth.sessions":
			if item.Status != privacy.ItemApplied || item.Affected < 1 {
				t.Fatalf("sessions item = %+v", item)
			}
		}
	}
	if countRows(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'test.event'`) != 3 || countRows(t, pool, `SELECT count(*) FROM password_reset_tokens`) != 1 {
		t.Fatal("execute changed the wrong rows")
	}
	if _, err := engine.ReleaseHold(ctx, principal, hold.ID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.RunLegacyCleanup(ctx, privacy.ModeExecute, []privacy.CategoryID{"audit.events"}); err != nil {
		t.Fatal(err)
	}
	if countRows(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'test.event'`) != 1 {
		t.Fatal("audit retention did not delete the old events")
	}
	// Runs are recorded with counts and audited.
	if countRows(t, pool, `SELECT count(*) FROM privacy_retention_runs WHERE trigger = 'cli'`) != 3 ||
		countRows(t, pool, `SELECT count(*) FROM audit_events WHERE action LIKE 'privacy.retention_run_%'`) != 3 {
		t.Fatal("runs were not recorded")
	}
	// An opt-out is honoured: with AUDIT_RETENTION=0 nothing is planned for audit events.
	optOut := retentionEngine(t, pool, 0, 0)
	run, err = optOut.RunLegacyCleanup(ctx, privacy.ModeDryRun, []privacy.CategoryID{"audit.events", "events.external_signups"})
	if err != nil || run.ID != uuid.Nil {
		t.Fatalf("opt-out planned a run: %+v err=%v", run, err)
	}
}

// Policies go draft → approved → active with four-eyes activation, exactly one active version per category,
// and the scheduled run obeys the automatic-runs switch.
func TestRetentionPoliciesLifecycleAndScheduledRuns(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	engine := retentionEngine(t, pool, 365*24*time.Hour, 180*24*time.Hour)
	author := seedAccount(t, pool, "policy-author", true)
	reviewer := seedAccount(t, pool, "policy-reviewer", true)
	authorP := authorization.Principal{AccountID: author.accountID, PersonID: author.personID, Master: true}
	reviewerP := authorization.Principal{AccountID: reviewer.accountID, PersonID: reviewer.personID, Master: true}

	policies, err := engine.ListPolicies(ctx, authorP)
	if err != nil {
		t.Fatal(err)
	}
	seeded := map[privacy.CategoryID]privacy.Policy{}
	for _, policy := range policies {
		if policy.Status != privacy.PolicyDraft || policy.SourceTemplate == nil {
			t.Fatalf("seeded policy %+v", policy)
		}
		seeded[policy.Category] = policy
	}
	if seeded["audit.events"].PeriodDays != 365 || seeded["events.external_signups"].PeriodDays != 180 || seeded["attendance.visits"].PeriodDays != 90 {
		t.Fatalf("seeded periods = %+v", seeded)
	}

	// Approval needs purpose, legal basis and reason.
	draft := seeded["audit.events"]
	if _, err := engine.TransitionPolicy(ctx, authorP, draft.ID, privacy.PolicyApproved, nil); !apperror.IsCode(err, "policy_incomplete") {
		t.Fatalf("incomplete approval = %v", err)
	}
	draft, err = engine.UpdatePolicy(ctx, authorP, draft.ID, privacy.PolicyInput{
		Trigger: privacy.TriggerCreatedAt, PeriodDays: 30, Action: privacy.ActionDelete,
		Purpose: "Operational traceability", LegalBasis: "Art. 6(1)(f) GDPR", Reason: "Thirty days cover every incident review",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	approved, err := engine.TransitionPolicy(ctx, authorP, draft.ID, privacy.PolicyApproved, nil)
	if err != nil || approved.Status != privacy.PolicyApproved {
		t.Fatalf("approve = %+v err=%v", approved, err)
	}
	nonMaster := authorization.Principal{AccountID: author.accountID, PersonID: author.personID}
	if _, err := engine.TransitionPolicy(ctx, nonMaster, draft.ID, privacy.PolicyActive, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("activation without permission = %v", err)
	}
	active, err := engine.TransitionPolicy(ctx, reviewerP, draft.ID, privacy.PolicyActive, nil)
	if err != nil || active.Status != privacy.PolicyActive {
		t.Fatalf("activate = %+v err=%v", active, err)
	}
	if _, err := engine.UpdatePolicy(ctx, authorP, draft.ID, privacy.PolicyInput{Trigger: privacy.TriggerCreatedAt, Action: privacy.ActionDelete}, nil); !apperror.IsCode(err, "policy_not_draft") {
		t.Fatalf("editing an active policy = %v", err)
	}
	// A new version replaces the active one on activation.
	second, err := engine.CreatePolicy(ctx, authorP, privacy.PolicyInput{
		Category: "audit.events", Trigger: privacy.TriggerCreatedAt, PeriodDays: 60, Action: privacy.ActionDelete,
		Purpose: "p", LegalBasis: "l", Reason: "r",
	}, nil)
	if err != nil || second.Version != 2 {
		t.Fatalf("second version = %+v err=%v", second, err)
	}
	if _, err := engine.TransitionPolicy(ctx, authorP, second.ID, privacy.PolicyApproved, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.TransitionPolicy(ctx, reviewerP, second.ID, privacy.PolicyActive, nil); err != nil {
		t.Fatal(err)
	}
	if countRows(t, pool, `SELECT count(*) FROM privacy_policy_versions WHERE category_id = 'audit.events' AND status = 'active'`) != 1 ||
		countRows(t, pool, `SELECT count(*) FROM privacy_policy_versions WHERE id = $1 AND status = 'retired'`, draft.ID) != 1 {
		t.Fatal("activation did not retire the previous version")
	}

	// Scheduled runs: with automatic runs off, only legacy automatic categories run; the active audit policy waits.
	if _, err := pool.Exec(ctx, `INSERT INTO audit_events (id, actor_type, actor_account_id, action, resource_type, occurred_at, changed_fields, metadata, source)
		VALUES ($1, 'user', $2, 'test.old', 'test', now() - interval '100 days', '{}', '{}', 'http')`, ids.New(), author.accountID); err != nil {
		t.Fatal(err)
	}
	run, err := engine.RunScheduled(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range run.Items {
		if item.Category == "audit.events" {
			t.Fatalf("scheduled run touched a policy category while automatic runs are off: %+v", item)
		}
	}
	if countRows(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'test.old'`) != 1 {
		t.Fatal("audit event deleted while automatic runs are off")
	}
	settings, err := engine.GetSettings(ctx, authorP)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := engine.UpdateSettings(ctx, authorP, privacy.SettingsInput{
		AutomaticRunsEnabled: true, RunIntervalMinutes: 60, ExpectedVersion: settings.Version,
	}, nil); err != nil {
		t.Fatal(err)
	}
	run, err = engine.RunScheduled(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var auditItem *privacy.RunItem
	for index := range run.Items {
		if run.Items[index].Category == "audit.events" {
			auditItem = &run.Items[index]
		}
	}
	if auditItem == nil || auditItem.PolicyID == nil || auditItem.Affected < 1 || run.Trigger != privacy.TriggerScheduled {
		t.Fatalf("scheduled policy run = %+v", run)
	}
	if countRows(t, pool, `SELECT count(*) FROM audit_events WHERE action = 'test.old'`) != 0 {
		t.Fatal("active policy did not delete the old event")
	}
	// A manual dry run with an explicit category list reports only that category.
	manual, err := engine.StartRun(ctx, authorP, privacy.ModeDryRun, []privacy.CategoryID{"audit.events"}, nil)
	if err != nil || len(manual.Items) != 1 || manual.Items[0].Category != "audit.events" || manual.Mode != privacy.ModeDryRun {
		t.Fatalf("manual dry run = %+v err=%v", manual, err)
	}
	if _, err := engine.StartRun(ctx, nonMaster, privacy.ModeExecute, nil, nil); !errors.Is(err, apperror.PermissionDenied) {
		t.Fatalf("run without permission = %v", err)
	}
}
