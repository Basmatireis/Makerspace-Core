package configtransfer

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	configtransferdb "github.com/Basmatireis/Makerspace-Core/backend/internal/configtransfer/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests"
	"github.com/jackc/pgx/v5"
)

// Privacy: the controller named in the privacy notice, one retention decision per data category and the record of
// processing activities. Holds, runs, data-subject requests and the switch for automatic runs stay on each instance.
//
// A retention decision travels as its content only. The import never approves or activates: a decision that differs
// from the target's draft updates that draft, and one that differs from an approved or active version is added as a
// new draft next to it, so every instance approves and activates its policies itself (four eyes, audit trail).
// Decisions missing from the file are kept.

const (
	privacySettingsItem = "Privacy settings"
	policyDraftReason   = "Added as a draft; approve and activate it on this instance."
	policyKeptReason    = "The approved or active version stays in force; the file's decision was added as a new draft."
	policyMissingReason = "Retention decisions are never removed by an import."
)

var categoryIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`)

type privacyEntry struct {
	Settings             privacySettingsEntry      `json:"settings"`
	RetentionPolicies    []retentionPolicyEntry    `json:"retentionPolicies"`
	ProcessingActivities []processingActivityEntry `json:"processingActivities"`
}

type privacySettingsEntry struct {
	ControllerName        string `json:"controllerName"`
	ControllerAddress     string `json:"controllerAddress"`
	DataProtectionContact string `json:"dataProtectionContact"`
}

type retentionPolicyEntry struct {
	Category   string `json:"category"`
	Trigger    string `json:"trigger"`
	PeriodDays int32  `json:"periodDays"`
	Action     string `json:"action"`
	Purpose    string `json:"purpose"`
	LegalBasis string `json:"legalBasis"`
	Reason     string `json:"reason"`
}

type processingActivityEntry struct {
	Name          string   `json:"name"`
	Purpose       string   `json:"purpose"`
	LegalBasis    string   `json:"legalBasis"`
	Categories    []string `json:"categories"`
	Recipients    string   `json:"recipients"`
	RetentionNote string   `json:"retentionNote"`
}

func privacySection() section {
	definition := define(
		SectionPrivacy,
		permissions(authorization.PrivacyRead, authorization.PrivacyPoliciesManage),
		permissions(authorization.PrivacySettingsManage),
		exportPrivacy,
		validatePrivacy,
		applyPrivacy,
	)
	// The seeded drafts exist only after the first read of the policies; both sides of a transfer need them.
	definition.prepare = func(ctx context.Context, services Services) error {
		if services.Privacy == nil {
			return nil
		}
		return services.Privacy.EnsurePolicyDrafts(ctx)
	}
	return definition
}

func exportPrivacy(ctx context.Context, q *configtransferdb.Queries) (privacyEntry, error) {
	settings, err := q.GetPrivacySettingsForTransfer(ctx)
	if err != nil {
		return privacyEntry{}, err
	}
	policyRows, err := q.ListTransferablePolicies(ctx)
	if err != nil {
		return privacyEntry{}, err
	}
	activityRows, err := q.ListProcessingActivitiesForTransfer(ctx)
	if err != nil {
		return privacyEntry{}, err
	}
	entry := privacyEntry{
		Settings: privacySettingsEntry{
			ControllerName:        settings.ControllerName,
			ControllerAddress:     settings.ControllerAddress,
			DataProtectionContact: settings.DataProtectionContact,
		},
		RetentionPolicies:    make([]retentionPolicyEntry, 0),
		ProcessingActivities: make([]processingActivityEntry, 0, len(activityRows)),
	}
	for _, row := range transferablePolicies(policyRows) {
		entry.RetentionPolicies = append(entry.RetentionPolicies, policyEntryFrom(row))
	}
	for _, row := range activityRows {
		entry.ProcessingActivities = append(entry.ProcessingActivities, processingActivityEntry{
			Name: row.Name, Purpose: row.Purpose, LegalBasis: row.LegalBasis,
			Categories: append([]string{}, row.CategoryIds...), Recipients: row.Recipients, RetentionNote: row.RetentionNote,
		})
	}
	return entry, nil
}

func policyEntryFrom(row configtransferdb.ListTransferablePoliciesRow) retentionPolicyEntry {
	return retentionPolicyEntry{
		Category: row.CategoryID, Trigger: row.Trigger, PeriodDays: row.PeriodDays, Action: row.Action,
		Purpose: row.Purpose, LegalBasis: row.LegalBasis, Reason: row.Reason,
	}
}

// transferablePolicies picks the decision of each category: the active version, else the approved one, else the
// newest draft. Rows arrive ordered by category and version.
func transferablePolicies(rows []configtransferdb.ListTransferablePoliciesRow) []configtransferdb.ListTransferablePoliciesRow {
	rank := map[string]int{privacy.PolicyActive: 3, privacy.PolicyApproved: 2, privacy.PolicyDraft: 1}
	chosen := make([]configtransferdb.ListTransferablePoliciesRow, 0)
	for _, row := range rows {
		last := len(chosen) - 1
		if last >= 0 && chosen[last].CategoryID == row.CategoryID {
			if rank[row.Status] >= rank[chosen[last].Status] {
				chosen[last] = row
			}
			continue
		}
		chosen = append(chosen, row)
	}
	return chosen
}

func validatePrivacy(entry *privacyEntry) error {
	entry.Settings.ControllerName = strings.TrimSpace(entry.Settings.ControllerName)
	entry.Settings.ControllerAddress = strings.TrimSpace(entry.Settings.ControllerAddress)
	entry.Settings.DataProtectionContact = strings.TrimSpace(entry.Settings.DataProtectionContact)
	if len(entry.RetentionPolicies) > maxEntriesPerSection {
		return fmt.Errorf("too many retention policy entries")
	}
	seen := map[string]bool{}
	for i := range entry.RetentionPolicies {
		policy := &entry.RetentionPolicies[i]
		policy.Category = strings.TrimSpace(policy.Category)
		if !categoryIDPattern.MatchString(policy.Category) {
			return fmt.Errorf("retention policy category %q is invalid", policy.Category)
		}
		if seen[policy.Category] {
			return fmt.Errorf("retention policy for %q appears twice", policy.Category)
		}
		seen[policy.Category] = true
		policy.Purpose, policy.LegalBasis = strings.TrimSpace(policy.Purpose), strings.TrimSpace(policy.LegalBasis)
		policy.Reason = strings.TrimSpace(policy.Reason)
	}
	names := make([]*string, len(entry.ProcessingActivities))
	for i := range entry.ProcessingActivities {
		activity := &entry.ProcessingActivities[i]
		names[i] = &activity.Name
		activity.Purpose, activity.LegalBasis = strings.TrimSpace(activity.Purpose), strings.TrimSpace(activity.LegalBasis)
		activity.Recipients, activity.RetentionNote = strings.TrimSpace(activity.Recipients), strings.TrimSpace(activity.RetentionNote)
		if activity.Categories == nil {
			activity.Categories = []string{}
		}
		for j := range activity.Categories {
			activity.Categories[j] = strings.TrimSpace(activity.Categories[j])
		}
	}
	return checkNames("processing activity", names, 200)
}

func applyPrivacy(r *run, entry *privacyEntry) (func() error, error) {
	if err := applyPrivacySettings(r, entry.Settings); err != nil {
		return nil, err
	}
	keepPolicies, err := applyRetentionPolicies(r, entry.RetentionPolicies)
	if err != nil {
		return nil, err
	}
	deleteActivities, err := applyProcessingActivities(r, entry.ProcessingActivities)
	if err != nil {
		return nil, err
	}
	return func() error {
		keepPolicies()
		return deleteActivities()
	}, nil
}

func applyPrivacySettings(r *run, desired privacySettingsEntry) error {
	if r.mode == ModeInsert {
		r.skip(privacySettingsItem, reasonSingleton)
		return nil
	}
	current, err := r.q.GetPrivacySettingsForTransfer(r.ctx)
	if err != nil {
		return err
	}
	if current.ControllerName == desired.ControllerName && current.ControllerAddress == desired.ControllerAddress &&
		current.DataProtectionContact == desired.DataProtectionContact {
		r.skip(privacySettingsItem, reasonUnchanged)
		return nil
	}
	_, err = r.attempt(privacySettingsItem, ActionUpdate, "", func(tx pgx.Tx) error {
		_, err := r.svc.Privacy.UpdateSettingsTx(r.ctx, tx, r.p, privacy.SettingsInput{
			ControllerName:        desired.ControllerName,
			ControllerAddress:     desired.ControllerAddress,
			DataProtectionContact: desired.DataProtectionContact,
			AutomaticRunsEnabled:  current.AutomaticRunsEnabled,
			RunIntervalMinutes:    current.RunIntervalMinutes,
			ExpectedVersion:       current.Version,
		}, r.requestID)
		return err
	})
	return err
}

func samePolicy(row configtransferdb.ListTransferablePoliciesRow, entry retentionPolicyEntry) bool {
	return row.Trigger == entry.Trigger && row.PeriodDays == entry.PeriodDays && row.Action == entry.Action &&
		strings.TrimSpace(row.Purpose) == entry.Purpose && strings.TrimSpace(row.LegalBasis) == entry.LegalBasis &&
		strings.TrimSpace(row.Reason) == entry.Reason
}

func applyRetentionPolicies(r *run, entries []retentionPolicyEntry) (func(), error) {
	rows, err := r.q.ListTransferablePolicies(r.ctx)
	if err != nil {
		return nil, err
	}
	versions := map[string][]configtransferdb.ListTransferablePoliciesRow{}
	for _, row := range rows {
		versions[row.CategoryID] = append(versions[row.CategoryID], row)
	}
	inFile := map[string]bool{}
	for _, entry := range entries {
		inFile[entry.Category] = true
		input := privacy.PolicyInput{
			Category: privacy.CategoryID(entry.Category), Trigger: privacy.Trigger(entry.Trigger),
			PeriodDays: entry.PeriodDays, Action: privacy.Action(entry.Action),
			Purpose: entry.Purpose, LegalBasis: entry.LegalBasis, Reason: entry.Reason,
		}
		existing := versions[entry.Category]
		var draft *configtransferdb.ListTransferablePoliciesRow
		unchanged := false
		for i := range existing {
			if samePolicy(existing[i], entry) {
				unchanged = true
			}
			if existing[i].Status == privacy.PolicyDraft && (draft == nil || existing[i].Version > draft.Version) {
				draft = &existing[i]
			}
		}
		switch {
		case unchanged:
			r.skip(entry.Category, reasonUnchanged)
		case len(existing) > 0 && r.mode == ModeInsert:
			r.skip(entry.Category, reasonExists)
		case draft != nil:
			_, err = r.attempt(entry.Category, ActionUpdate, "", func(tx pgx.Tx) error {
				_, err := r.svc.Privacy.UpdatePolicyTx(r.ctx, tx, r.p, draft.ID, input, r.requestID)
				return err
			})
		default:
			reason := policyDraftReason
			if len(existing) > 0 {
				reason = policyKeptReason
			}
			_, err = r.attempt(entry.Category, ActionCreate, reason, func(tx pgx.Tx) error {
				_, err := r.svc.Privacy.CreatePolicyTx(r.ctx, tx, r.p, input, r.requestID)
				return err
			})
		}
		if err != nil {
			return nil, err
		}
	}
	return func() {
		for _, row := range transferablePolicies(rows) {
			if !inFile[row.CategoryID] {
				r.keep(row.CategoryID, policyMissingReason)
			}
		}
	}, nil
}

func applyProcessingActivities(r *run, entries []processingActivityEntry) (func() error, error) {
	rows, err := r.q.ListProcessingActivitiesForTransfer(r.ctx)
	if err != nil {
		return nil, err
	}
	existing := map[string]configtransferdb.ListProcessingActivitiesForTransferRow{}
	for _, row := range rows {
		existing[nameKey(row.Name)] = row
	}
	inFile := map[string]bool{}
	for _, entry := range entries {
		inFile[nameKey(entry.Name)] = true
		categories := make([]privacy.CategoryID, 0, len(entry.Categories))
		for _, id := range entry.Categories {
			categories = append(categories, privacy.CategoryID(id))
		}
		input := subjectrequests.ActivityInput{
			Name: entry.Name, Purpose: entry.Purpose, LegalBasis: entry.LegalBasis, CategoryIDs: categories,
			Recipients: entry.Recipients, RetentionNote: entry.RetentionNote,
		}
		current, found := existing[nameKey(entry.Name)]
		switch {
		case !found:
			_, err = r.attempt(entry.Name, ActionCreate, "", func(tx pgx.Tx) error {
				_, err := r.svc.SubjectRequests.CreateActivityTx(r.ctx, tx, r.p, input, r.requestID)
				return err
			})
		case r.mode == ModeInsert:
			r.skip(entry.Name, reasonExists)
		case current.Name == entry.Name && current.Purpose == entry.Purpose && current.LegalBasis == entry.LegalBasis &&
			slices.Equal(current.CategoryIds, entry.Categories) && current.Recipients == entry.Recipients &&
			current.RetentionNote == entry.RetentionNote:
			r.skip(entry.Name, reasonUnchanged)
		default:
			_, err = r.attempt(entry.Name, ActionUpdate, "", func(tx pgx.Tx) error {
				_, err := r.svc.SubjectRequests.UpdateActivityTx(r.ctx, tx, r.p, current.ID, input, current.Version, r.requestID)
				return err
			})
		}
		if err != nil {
			return nil, err
		}
	}
	return func() error {
		for _, row := range rows {
			if inFile[nameKey(row.Name)] {
				continue
			}
			if _, err := r.attempt(row.Name, ActionDelete, "", func(tx pgx.Tx) error {
				return r.svc.SubjectRequests.DeleteActivityTx(r.ctx, tx, r.p, row.ID, row.Version, r.requestID)
			}); err != nil {
				return err
			}
		}
		return nil
	}, nil
}
