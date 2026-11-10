// Package staginganonymizer turns a copy of the production database into data a staging installation may
// hold: people get stable fake names and example.invalid addresses, credentials, tokens, personal free
// text, personal files and the audit log are removed, and secrets encrypted with production's keys are
// cleared. Treatments lists how every table and text column is handled; a test compares it with the
// migrated schema.
package staginganonymizer

import (
	"context"
	"fmt"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	db "github.com/Basmatireis/Makerspace-Core/backend/internal/staginganonymizer/db"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Result tells the operator how to get into the anonymized installation: every credential is gone, so
// one of these accounts receives a password through `admin reset-password`.
type Result struct {
	MasterLoginEmails []string
	DeletedFiles      int
}

type Service struct{ pool *pgxpool.Pool }

func NewService(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// ASCII only: the fake names also form the login emails.
var (
	fakeFirstNames = []string{
		"Alex", "Anna", "Ben", "Clara", "David", "Elena", "Felix", "Greta", "Hannah", "Ivan", "Jana", "Jonas",
		"Julia", "Kai", "Laura", "Leon", "Lena", "Lukas", "Maja", "Marie", "Max", "Mia", "Nico", "Nina", "Noah",
		"Olivia", "Paul", "Pia", "Rafael", "Sara", "Simon", "Sophie", "Tara", "Tim", "Valentina", "Yusuf",
	}
	fakeLastNames = []string{
		"Bauer", "Berger", "Brunner", "Eder", "Fischer", "Fuchs", "Gruber", "Haas", "Hofer", "Huber", "Koller",
		"Lang", "Lehner", "Maier", "Moser", "Pichler", "Reiter", "Schmid", "Schwarz", "Steiner", "Wagner",
		"Weber", "Wimmer", "Winkler", "Wolf", "Zimmermann",
	}
)

// Anonymize rewrites the whole database in one transaction; on any error nothing changes. baseURL becomes
// the link base of outgoing mail. The connection needs to own the tables (or be a superuser), because the
// immutability triggers of booked records are switched off while their free text is rewritten.
func (s *Service) Anonymize(ctx context.Context, baseURL string) (Result, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)

	personalFiles, err := q.ListPersonalFileIDs(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("list personal files: %w", err)
	}
	steps := []struct {
		name string
		run  func(context.Context) error
	}{
		{"disable payment guards", q.DisableFinancialGuards},
		{"disable order item guards", q.DisableOrderItemGuards},
		{"disable order adjustment guards", q.DisableOrderAdjustmentGuards},
		{"disable customer snapshot guards", q.DisableCustomerSnapshotGuards},
		{"disable invoice detail guards", q.DisableInvoiceDetailGuards},
		{"disable invoice event guards", q.DisableInvoiceEventGuards},
		{"disable cash movement guards", q.DisableCashMovementGuards},
		{"disable cash count guards", q.DisableCashCountGuards},
		{"disable inventory transaction guards", q.DisableInventoryTransactionGuards},

		{"delete sessions", q.DeleteSessions},
		{"delete password credentials", q.DeletePasswordCredentials},
		{"delete PIN credentials", q.DeletePINCredentials},
		{"delete password reset tokens", q.DeletePasswordResetTokens},
		{"delete auth challenges", q.DeleteAuthChallenges},
		{"delete auth rate limits", q.DeleteAuthRateLimits},
		{"delete PIN throttles", q.DeletePINLoginThrottles},
		{"delete pending logins", q.DeletePendingLogins},
		{"delete second factor throttles", q.DeleteSecondFactorThrottles},
		{"delete WebAuthn challenges", q.DeleteWebAuthnChallenges},
		{"delete passkeys", q.DeleteWebAuthnCredentials},
		{"delete TOTP credentials", q.DeleteTOTPCredentials},
		{"delete recovery codes", q.DeleteRecoveryCodes},
		{"delete OIDC flows", q.DeleteOIDCFlows},
		{"delete PIN and OIDC identities", q.DeleteNonPasswordIdentities},
		{"delete SCIM users", q.DeleteSCIMUsers},
		{"delete SCIM tokens", q.DeleteSCIMConnectorTokens},
		{"delete SCIM connectors", q.DeleteSCIMConnectors},
		{"delete OIDC providers", q.DeleteOIDCProviders},
		{"delete calendar feeds", q.DeleteCalendarFeeds},
		{"delete visitor enrollment contexts", q.DeleteVisitorEnrollmentContexts},
		{"delete account presence", q.DeleteAccountPresence},
		{"delete connector enrollments", q.DeletePrinterConnectorEnrollments},
		{"delete connector credentials", q.DeletePrinterConnectorCredentials},
		{"delete signage pairing requests", q.DeleteSignagePairingRequests},
		{"replace device tokens", q.ReplaceManagedDeviceTokens},
		{"disable signage web embeds", q.DisableSignageWebEmbeds},
		{"clear printer secrets", q.ClearPrinterConnectorSecrets},

		{"delete audit events", q.DeleteAuditEvents},
		{"delete notification pending actions", q.DeleteNotificationPendingActions},
		{"delete notification recipients", q.DeleteNotificationFiringRecipients},
		{"delete notification mail outbox", q.DeleteNotificationMailOutbox},
		{"delete kiosk rule notices", q.DeleteKioskRuleNotices},
		{"delete signage rule notices", q.DeleteSignageRuleNotices},
		{"delete inbox notifications", q.DeleteInboxNotifications},
		{"delete notification firings", q.DeleteNotificationFirings},
		{"delete notification rule runs", q.DeleteNotificationRuleRuns},
		{"delete notification throttle", q.DeleteNotificationThrottle},
		{"delete survey invitations", q.DeleteSurveyInvitations},
		{"delete survey offers", q.DeleteSurveyOffers},
		{"delete survey share links", q.DeleteSurveyShareLinks},
		{"clear survey text answers", q.ClearSurveyTextAnswers},
		{"delete subject request steps", q.DeletePrivacySubjectRequestSteps},
		{"delete subject requests", q.DeletePrivacySubjectRequests},
		{"neutralize retention holds", q.NeutralizePrivacyRetentionHolds},
		{"clear data protection contact", q.ClearPrivacyContact},
		{"delete printer live statuses", q.DeletePrinterLiveStatuses},
		{"delete connector activity", q.DeletePrinterConnectorActivity},
		{"delete discovery candidates", q.DeletePrinterDiscoveryCandidates},
		{"delete discovery requests", q.DeletePrinterDiscoveryRequests},
		{"clear printer event payloads", q.ClearPrinterEventPayloads},
		{"clear printer error contexts", q.ClearPrinterErrorContexts},
		{"delete pending blob deletions", q.DeleteFileBlobDeletions},

		{"anonymize people", func(ctx context.Context) error {
			return q.AnonymizePeople(ctx, db.AnonymizePeopleParams{FirstNames: fakeFirstNames, LastNames: fakeLastNames})
		}},
		{"align login emails", q.AlignPasswordIdentitiesWithPeople},
		{"anonymize event sign-ups", q.AnonymizeEventSignups},
		{"clear event internal descriptions", q.ClearEventTexts},
		{"neutralize event tasks", q.NeutralizeEventTasks},
		{"clear training notes", q.ClearTrainingRecordNotes},
		{"neutralize lab rules confirmations", q.NeutralizeLabRulesConfirmations},
		{"clear open day notes", q.ClearOpenDayNotes},
		{"clear excusal reasons", q.ClearStaffingExcusalReasons},
		{"clear visit corrections", q.ClearVisitCorrectionReasons},
		{"anonymize machine jobs", q.AnonymizeMachineJobs},
		{"anonymize run file names", q.AnonymizeMachineRunFileNames},
		{"clear inventory texts", q.ClearInventoryTransactionTexts},
		{"clear spool texts", q.ClearSpoolTexts},
		{"clear material notes", q.ClearMaterialNotes},
		{"clear print artifact metadata", q.ClearPrintArtifactMetadata},
		{"anonymize organization contacts", q.AnonymizeOrganizationContacts},
		{"anonymize customer snapshots", q.AnonymizeCustomerSnapshots},
		{"anonymize order items", q.AnonymizeOrderItems},
		{"clear order adjustment reasons", q.ClearOrderAdjustmentReasons},
		{"anonymize payments", q.AnonymizePayments},
		{"clear cash movement notes", q.ClearCashMovementNotes},
		{"clear cash count notes", q.ClearCashCountNotes},
		{"anonymize invoice requests", q.AnonymizeInvoiceRequestDetails},
		{"neutralize invoice request events", q.NeutralizeInvoiceRequestEvents},
		{"point mail at Mailpit", func(ctx context.Context) error { return q.PointMailAtMailpit(ctx, baseURL) }},
		{"redirect wiRef delivery", q.RedirectWiRefDelivery},
		{"delete event files", q.DeleteEventFiles},
		{"delete personal files", func(ctx context.Context) error {
			if len(personalFiles) == 0 {
				return nil
			}
			return q.DeleteFiles(ctx, personalFiles)
		}},
		{"neutralize file names", q.NeutralizeFileNames},

		{"enable payment guards", q.EnableFinancialGuards},
		{"enable order item guards", q.EnableOrderItemGuards},
		{"enable order adjustment guards", q.EnableOrderAdjustmentGuards},
		{"enable customer snapshot guards", q.EnableCustomerSnapshotGuards},
		{"enable invoice detail guards", q.EnableInvoiceDetailGuards},
		{"enable invoice event guards", q.EnableInvoiceEventGuards},
		{"enable cash movement guards", q.EnableCashMovementGuards},
		{"enable cash count guards", q.EnableCashCountGuards},
		{"enable inventory transaction guards", q.EnableInventoryTransactionGuards},
	}
	for _, step := range steps {
		if err := step.run(ctx); err != nil {
			return Result{}, fmt.Errorf("%s: %w", step.name, err)
		}
	}

	// A master who signed in only through OIDC or a PIN has no password identity left; give every master
	// one so `admin reset-password` can open the installation.
	withoutPassword, err := q.ListMasterAccountsWithoutPasswordIdentity(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("list masters without password identity: %w", err)
	}
	for _, master := range withoutPassword {
		if master.Email == nil {
			continue
		}
		if err := q.CreatePasswordIdentity(
			ctx,
			db.CreatePasswordIdentityParams{ID: ids.New(), AccountID: master.ID, Email: *master.Email},
		); err != nil {
			return Result{}, fmt.Errorf("create password identity for master %s: %w", master.ID, err)
		}
	}
	emails, err := q.ListMasterLoginEmails(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("list master login emails: %w", err)
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			Action:       "system.anonymized_for_staging",
			ResourceType: "installation",
			Source:       audit.SourceAdminCLI,
		},
	); err != nil {
		return Result{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, err
	}
	return Result{MasterLoginEmails: emails, DeletedFiles: len(personalFiles)}, nil
}
