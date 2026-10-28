package privacy

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	privacydb "github.com/Basmatireis/Makerspace-Core/backend/internal/privacy/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// PolicyCoverage says whether a category has a retention decision in force.
type PolicyCoverage string

const (
	// PolicyCoverageActive: an active policy governs the category.
	PolicyCoverageActive PolicyCoverage = "active"
	// PolicyCoveragePending: a draft or approved version exists but none is active, so the previous behaviour applies.
	PolicyCoveragePending PolicyCoverage = "pending"
	// PolicyCoverageNone: no policy at all; the data is kept until someone decides.
	PolicyCoverageNone PolicyCoverage = "none"
)

// Coverage is what the registry knows about a category beyond its declaration:
// the decision of record, an open hold and the most recent run that touched it.
type Coverage struct {
	PolicyStatus PolicyCoverage
	// Policy is the active version, else the approved one, else the newest draft; nil without any.
	Policy *Policy
	// Hold is the open category hold, if any.
	Hold *Hold
	// LastRun is the most recent run item of the category, if any.
	LastRun *RunItemSummary
}

// RunItemSummary is one category's part of a run, with the run's frame.
type RunItemSummary struct {
	RunID     uuid.UUID
	Mode      string
	Trigger   string
	StartedAt time.Time
	Action    Action
	Affected  int64
	Status    string
}

// RunSummary is the frame of a run with the rows it changed (or would change).
type RunSummary struct {
	ID         uuid.UUID
	Mode       string
	Trigger    string
	StartedAt  time.Time
	FinishedAt *time.Time
	Status     string
	Affected   int64
}

type coverageSet struct {
	categories        map[CategoryID]Coverage
	openCategoryHolds int
	openPersonHolds   int
	lastRun           *RunSummary
}

// Coverage returns the coverage of every category (privacy.read).
func (s *Service) Coverage(ctx context.Context, p authorization.Principal) (map[CategoryID]Coverage, error) {
	if !p.Has(authorization.PrivacyRead) {
		return nil, apperror.PermissionDenied
	}
	set, err := s.coverage(ctx)
	if err != nil {
		return nil, err
	}
	return set.categories, nil
}

func (s *Service) coverage(ctx context.Context) (coverageSet, error) {
	if err := s.EnsurePolicyDrafts(ctx); err != nil {
		return coverageSet{}, err
	}
	q := privacydb.New(s.pool)
	set := coverageSet{categories: map[CategoryID]Coverage{}}
	policies, err := q.ListPolicies(ctx)
	if err != nil {
		return coverageSet{}, err
	}
	rank := map[string]int{PolicyActive: 3, PolicyApproved: 2, PolicyDraft: 1}
	for _, row := range policies {
		if row.Status == PolicyRetired {
			continue
		}
		id := CategoryID(row.CategoryID)
		current := set.categories[id]
		// Rows arrive by category and descending version, so the first row of a rank is its newest version.
		if current.Policy == nil || rank[row.Status] > rank[current.Policy.Status] {
			policy := policyFrom(row)
			current.Policy = &policy
		}
		set.categories[id] = current
	}
	for id, current := range set.categories {
		switch {
		case current.Policy == nil:
			current.PolicyStatus = PolicyCoverageNone
		case current.Policy.Status == PolicyActive:
			current.PolicyStatus = PolicyCoverageActive
		default:
			current.PolicyStatus = PolicyCoveragePending
		}
		set.categories[id] = current
	}
	holds, err := q.ListOpenHolds(ctx)
	if err != nil {
		return coverageSet{}, err
	}
	for _, row := range holds {
		hold := holdFrom(row)
		if hold.Category == nil {
			set.openPersonHolds++
			continue
		}
		set.openCategoryHolds++
		current := set.categories[*hold.Category]
		if current.Hold == nil || hold.CreatedAt.Before(current.Hold.CreatedAt) {
			current.Hold = &hold
		}
		set.categories[*hold.Category] = current
	}
	items, err := q.LastRunItemPerCategory(ctx)
	if err != nil {
		return coverageSet{}, err
	}
	for _, row := range items {
		id := CategoryID(row.CategoryID)
		current := set.categories[id]
		current.LastRun = &RunItemSummary{
			RunID: row.RunID, Mode: row.Mode, Trigger: row.Trigger, StartedAt: row.StartedAt,
			Action: Action(row.Action), Affected: row.AffectedCount, Status: row.Status,
		}
		set.categories[id] = current
	}
	for id, current := range set.categories {
		if current.PolicyStatus == "" {
			current.PolicyStatus = PolicyCoverageNone
			set.categories[id] = current
		}
	}
	last, err := q.LastRun(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return set, nil
	}
	if err != nil {
		return coverageSet{}, err
	}
	affected, err := q.SumRunAffected(ctx, last.ID)
	if err != nil {
		return coverageSet{}, err
	}
	set.lastRun = &RunSummary{
		ID: last.ID, Mode: last.Mode, Trigger: last.Trigger, StartedAt: last.StartedAt, Status: last.Status, Affected: affected,
	}
	if last.FinishedAt.Valid {
		at := last.FinishedAt.Time
		set.lastRun.FinishedAt = &at
	}
	return set, nil
}

// CoverageOf returns the coverage of one category, with PolicyCoverageNone for an unknown one.
func CoverageOf(set map[CategoryID]Coverage, id CategoryID) Coverage {
	if current, ok := set[id]; ok {
		return current
	}
	return Coverage{PolicyStatus: PolicyCoverageNone}
}
