// Package subjectrequests answers data-subject requests (access and erasure)
// against the privacy registry: it records a request, walks it through the
// manual identity check, the assessment, the approval and the execution, and
// keeps the record of processing activities. The data itself comes from the
// subject handlers that modules register with the privacy service; this
// package only orchestrates them and stores counts and outcomes.
package subjectrequests

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	requestsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Request kinds, statuses and channels.
const (
	KindAccess  = "access"
	KindErasure = "erasure"

	StatusReceived           = "received"
	StatusIdentityVerified   = "identity_verified"
	StatusAssessed           = "assessed"
	StatusApproved           = "approved"
	StatusExecuting          = "executing"
	StatusCompleted          = "completed"
	StatusPartiallyCompleted = "partially_completed"
	StatusRejected           = "rejected"

	// ResponseDeadline is the statutory month a controller has to answer.
	ResponseDeadline = 30 * 24 * time.Hour
	listLimit        = 200
)

var channels = map[string]bool{"email": true, "in_person": true, "letter": true, "other": true}

// Request is a recorded data-subject request.
type Request struct {
	ID       uuid.UUID
	Kind     string
	Status   string
	PersonID *uuid.UUID
	// PersonName is resolved at read time and nil once the person was erased.
	PersonName             *string
	IdentityVerifiedByName *string
	ApprovedByName         *string
	ExecutedByName         *string
	Reference              string
	Channel                string
	ReceivedAt             time.Time
	DueAt                  time.Time
	Notes                  string
	IdentityVerifiedAt     *time.Time
	IdentityVerifiedBy     *uuid.UUID
	AssessedAt             *time.Time
	Assessment             *Assessment
	ApprovedAt             *time.Time
	ApprovedBy             *uuid.UUID
	ExecutedAt             *time.Time
	ExecutedBy             *uuid.UUID
	Result                 *Assessment
	ExportFileID           *uuid.UUID
	CompletedAt            *time.Time
	RejectionReason        string
	Steps                  []Step
	Version                int64
	CreatedAt              time.Time
	CreatedBy              *uuid.UUID
}

// Step is one lifecycle transition.
type Step struct {
	Status     string
	OccurredAt time.Time
	Actor      *uuid.UUID
	ActorName  *string
	Note       string
}

// Assessment is what the handlers found (or did) per category.
type Assessment struct {
	Categories          []CategoryOutcome    `json:"categories"`
	Blockers            []string             `json:"blockers"`
	OpenHolds           int64                `json:"openHolds"`
	UncoveredCategories []privacy.CategoryID `json:"uncoveredCategories"`
}

// CategoryOutcome is one category's count and, for erasure, its outcome.
type CategoryOutcome struct {
	CategoryID privacy.CategoryID    `json:"categoryId"`
	Name       string                `json:"name"`
	Records    int64                 `json:"records"`
	Outcome    *privacy.EraseOutcome `json:"outcome"`
	Note       string                `json:"note"`
}

// Input records a new request.
type Input struct {
	Kind       string
	PersonID   uuid.UUID
	Reference  string
	Channel    string
	ReceivedAt time.Time
	Notes      string
}

// Service orchestrates requests and keeps the processing activities.
type Service struct {
	pool    *pgxpool.Pool
	privacy *privacy.Service
	people  *people.Service
	files   *files.Service
	now     func() time.Time
}

// NewService wires the orchestration to the privacy registry, the people
// service (for the erasure itself) and the file store (for exports), and
// registers the built-in subject handlers.
func NewService(pool *pgxpool.Pool, privacyService *privacy.Service, peopleService *people.Service, fileService *files.Service) *Service {
	s := &Service{pool: pool, privacy: privacyService, people: peopleService, files: fileService, now: time.Now}
	registerBuiltinHandlers(privacyService, fileService)
	return s
}

func requestFrom(row requestsdb.PrivacySubjectRequest, steps []requestsdb.PrivacySubjectRequestStep) (Request, error) {
	request := Request{
		ID: row.ID, Kind: row.Kind, Status: row.Status, PersonID: row.SubjectPersonID, Reference: row.Reference,
		Channel: row.Channel, ReceivedAt: row.ReceivedAt, DueAt: row.DueAt, Notes: row.Notes,
		IdentityVerifiedAt: optionalTime(row.IdentityVerifiedAt), IdentityVerifiedBy: row.IdentityVerifiedByAccountID,
		AssessedAt: optionalTime(row.AssessedAt), ApprovedAt: optionalTime(row.ApprovedAt), ApprovedBy: row.ApprovedByAccountID,
		ExecutedAt: optionalTime(row.ExecutedAt), ExecutedBy: row.ExecutedByAccountID, ExportFileID: row.ExportFileID,
		CompletedAt: optionalTime(row.CompletedAt), RejectionReason: row.RejectionReason, Version: row.Version,
		CreatedAt: row.CreatedAt, CreatedBy: row.CreatedByAccountID, Steps: make([]Step, 0, len(steps)),
	}
	var err error
	if request.Assessment, err = decodeAssessment(row.Assessment); err != nil {
		return Request{}, err
	}
	if request.Result, err = decodeAssessment(row.Result); err != nil {
		return Request{}, err
	}
	for _, step := range steps {
		request.Steps = append(request.Steps, Step{Status: step.Status, OccurredAt: step.OccurredAt, Actor: step.ActorAccountID, Note: step.Note})
	}
	return request, nil
}

func optionalTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	t := value.Time
	return &t
}

func decodeAssessment(raw []byte) (*Assessment, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var assessment Assessment
	if err := json.Unmarshal(raw, &assessment); err != nil {
		return nil, err
	}
	if assessment.Categories == nil {
		assessment.Categories = []CategoryOutcome{}
	}
	if assessment.Blockers == nil {
		assessment.Blockers = []string{}
	}
	if assessment.UncoveredCategories == nil {
		assessment.UncoveredCategories = []privacy.CategoryID{}
	}
	return &assessment, nil
}

// List returns the recent requests (privacy.requests.manage), newest first, without steps.
func (s *Service) List(ctx context.Context, p authorization.Principal) ([]Request, error) {
	if !p.Has(authorization.PrivacyRequestsManage) {
		return nil, apperror.PermissionDenied
	}
	rows, err := requestsdb.New(s.pool).ListSubjectRequests(ctx, listLimit)
	if err != nil {
		return nil, err
	}
	requests := make([]Request, 0, len(rows))
	for _, row := range rows {
		request, err := requestFrom(row, nil)
		if err != nil {
			return nil, err
		}
		requests = append(requests, request)
	}
	if err := s.resolveNames(ctx, requestsdb.New(s.pool), requests); err != nil {
		return nil, err
	}
	return requests, nil
}

// resolveNames fills the person and actor names of requests from the current people records, so a name never
// lives in the request itself and disappears with the person.
func (s *Service) resolveNames(ctx context.Context, q *requestsdb.Queries, requests []Request) error {
	people := map[string]bool{}
	accounts := map[string]bool{}
	for _, request := range requests {
		if request.PersonID != nil {
			people[request.PersonID.String()] = true
		}
		for _, id := range []*uuid.UUID{request.IdentityVerifiedBy, request.ApprovedBy, request.ExecutedBy} {
			if id != nil {
				accounts[id.String()] = true
			}
		}
		for _, step := range request.Steps {
			if step.Actor != nil {
				accounts[step.Actor.String()] = true
			}
		}
	}
	personNames := map[uuid.UUID]string{}
	if len(people) > 0 {
		rows, err := q.ListPeopleNames(ctx, keys(people))
		if err != nil {
			return err
		}
		for _, row := range rows {
			personNames[row.ID] = strings.TrimSpace(row.FirstName + " " + row.LastName)
		}
	}
	accountNames := map[uuid.UUID]string{}
	if len(accounts) > 0 {
		rows, err := q.ListAccountPersonNames(ctx, keys(accounts))
		if err != nil {
			return err
		}
		for _, row := range rows {
			accountNames[row.AccountID] = strings.TrimSpace(row.FirstName + " " + row.LastName)
		}
	}
	lookup := func(names map[uuid.UUID]string, id *uuid.UUID) *string {
		if id == nil {
			return nil
		}
		if name, ok := names[*id]; ok && name != "" {
			return &name
		}
		return nil
	}
	for i := range requests {
		request := &requests[i]
		request.PersonName = lookup(personNames, request.PersonID)
		request.IdentityVerifiedByName = lookup(accountNames, request.IdentityVerifiedBy)
		request.ApprovedByName = lookup(accountNames, request.ApprovedBy)
		request.ExecutedByName = lookup(accountNames, request.ExecutedBy)
		for j := range request.Steps {
			request.Steps[j].ActorName = lookup(accountNames, request.Steps[j].Actor)
		}
	}
	return nil
}

func keys(set map[string]bool) []string {
	result := make([]string, 0, len(set))
	for key := range set {
		result = append(result, key)
	}
	sort.Strings(result)
	return result
}

// Get returns one request with its steps (privacy.requests.manage).
func (s *Service) Get(ctx context.Context, p authorization.Principal, id uuid.UUID) (Request, error) {
	if !p.Has(authorization.PrivacyRequestsManage) {
		return Request{}, apperror.PermissionDenied
	}
	return s.load(ctx, requestsdb.New(s.pool), id)
}

func (s *Service) load(ctx context.Context, q *requestsdb.Queries, id uuid.UUID) (Request, error) {
	row, err := q.GetSubjectRequest(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, apperror.NotFound
	}
	if err != nil {
		return Request{}, err
	}
	steps, err := q.ListSubjectRequestSteps(ctx, id)
	if err != nil {
		return Request{}, err
	}
	request, err := requestFrom(row, steps)
	if err != nil {
		return Request{}, err
	}
	return s.withNames(ctx, q, request)
}

// Create records a request as received (privacy.requests.manage).
func (s *Service) Create(ctx context.Context, p authorization.Principal, input Input, requestID *uuid.UUID) (Request, error) {
	if !p.Has(authorization.PrivacyRequestsManage) {
		return Request{}, apperror.PermissionDenied
	}
	if input.Kind != KindAccess && input.Kind != KindErasure {
		return Request{}, apperror.InvalidField("kind must be access or erasure")
	}
	if !channels[input.Channel] {
		return Request{}, apperror.InvalidField("unknown channel")
	}
	if input.ReceivedAt.IsZero() || input.ReceivedAt.After(s.now().Add(time.Hour)) {
		return Request{}, apperror.InvalidField("receivedAt must be in the past")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Request{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := requestsdb.New(tx)
	if _, err := q.GetSubjectPerson(ctx, input.PersonID); errors.Is(err, pgx.ErrNoRows) {
		return Request{}, apperror.NotFound
	} else if err != nil {
		return Request{}, err
	}
	id := ids.New()
	actor := p.AccountID
	row, err := q.InsertSubjectRequest(ctx, requestsdb.InsertSubjectRequestParams{
		ID: id, Kind: input.Kind, SubjectPersonID: &input.PersonID, Reference: strings.TrimSpace(input.Reference),
		Channel: input.Channel, ReceivedAt: input.ReceivedAt.UTC(), DueAt: input.ReceivedAt.UTC().Add(ResponseDeadline),
		Notes: strings.TrimSpace(input.Notes), CreatedByAccountID: &actor,
	})
	if err != nil {
		return Request{}, err
	}
	if err := s.step(ctx, q, id, StatusReceived, &actor, ""); err != nil {
		return Request{}, err
	}
	if err := s.auditRequest(ctx, tx, &actor, "privacy.subject_request_created", id, requestID, nil); err != nil {
		return Request{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Request{}, err
	}
	request, err := requestFrom(row, []requestsdb.PrivacySubjectRequestStep{{Status: StatusReceived, ActorAccountID: &actor, OccurredAt: row.CreatedAt}})
	if err != nil {
		return Request{}, err
	}
	return s.withNames(ctx, requestsdb.New(s.pool), request)
}

// withNames resolves the names of one request.
func (s *Service) withNames(ctx context.Context, q *requestsdb.Queries, request Request) (Request, error) {
	requests := []Request{request}
	if err := s.resolveNames(ctx, q, requests); err != nil {
		return Request{}, err
	}
	return requests[0], nil
}

func (s *Service) step(ctx context.Context, q *requestsdb.Queries, requestID uuid.UUID, status string, actor *uuid.UUID, note string) error {
	return q.InsertSubjectRequestStep(ctx, requestsdb.InsertSubjectRequestStepParams{
		ID: ids.New(), RequestID: requestID, Status: status, ActorAccountID: actor, Note: strings.TrimSpace(note),
	})
}

func (s *Service) auditRequest(
	ctx context.Context, tx pgx.Tx, actor *uuid.UUID, action string, id uuid.UUID, requestID *uuid.UUID, metadata map[string]any,
) error {
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: actor, Action: action, ResourceType: "privacy_subject_request", ResourceID: &id,
		RequestID: requestID, ChangedFields: []string{"status"}, Metadata: metadata,
	})
}

// Transition moves a request to identity_verified, assessed, approved or rejected (privacy.requests.manage).
func (s *Service) Transition(
	ctx context.Context, p authorization.Principal, id uuid.UUID, target, note string, expectedVersion int64, requestID *uuid.UUID,
) (Request, error) {
	if !p.Has(authorization.PrivacyRequestsManage) {
		return Request{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Request{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := requestsdb.New(tx)
	current, err := q.LockSubjectRequest(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, apperror.NotFound
	}
	if err != nil {
		return Request{}, err
	}
	if current.Version != expectedVersion {
		return Request{}, apperror.StaleWrite
	}
	actor := p.AccountID
	var row requestsdb.PrivacySubjectRequest
	switch target {
	case StatusIdentityVerified:
		if current.Status != StatusReceived {
			return Request{}, apperror.Conflicting("request_state_invalid", "Only received requests can have their identity verified")
		}
		if strings.TrimSpace(note) == "" {
			return Request{}, apperror.InvalidField("note must say how the identity was verified")
		}
		row, err = q.MarkSubjectRequestIdentityVerified(ctx, requestsdb.MarkSubjectRequestIdentityVerifiedParams{
			ActorAccountID: &actor, ID: id, ExpectedVersion: expectedVersion,
		})
	case StatusAssessed:
		if current.Status != StatusIdentityVerified && current.Status != StatusAssessed {
			return Request{}, apperror.Conflicting("request_state_invalid", "The identity must be verified before the assessment")
		}
		if current.SubjectPersonID == nil {
			return Request{}, apperror.Conflicting("request_subject_missing", "The person of this request no longer exists")
		}
		assessment, err := s.assess(ctx, p, current.Kind, *current.SubjectPersonID)
		if err != nil {
			return Request{}, err
		}
		encoded, err := json.Marshal(assessment)
		if err != nil {
			return Request{}, err
		}
		row, err = q.MarkSubjectRequestAssessed(ctx, requestsdb.MarkSubjectRequestAssessedParams{
			Assessment: string(encoded), ID: id, ExpectedVersion: expectedVersion,
		})
		if err != nil {
			return Request{}, err
		}
	case StatusApproved:
		if current.Status != StatusAssessed {
			return Request{}, apperror.Conflicting("request_state_invalid", "Only assessed requests can be approved")
		}
		if current.IdentityVerifiedByAccountID != nil && *current.IdentityVerifiedByAccountID == actor && !p.Master {
			return Request{}, apperror.Conflicting("request_four_eyes", "The person who verified the identity cannot also approve the request")
		}
		row, err = q.MarkSubjectRequestApproved(ctx, requestsdb.MarkSubjectRequestApprovedParams{
			ActorAccountID: &actor, ID: id, ExpectedVersion: expectedVersion,
		})
	case StatusRejected:
		if current.Status == StatusCompleted || current.Status == StatusPartiallyCompleted ||
			current.Status == StatusRejected || current.Status == StatusExecuting {
			return Request{}, apperror.Conflicting("request_state_invalid", "The request is already closed")
		}
		if strings.TrimSpace(note) == "" {
			return Request{}, apperror.InvalidField("note must give the reason for the rejection")
		}
		row, err = q.MarkSubjectRequestRejected(ctx, requestsdb.MarkSubjectRequestRejectedParams{
			RejectionReason: strings.TrimSpace(note), ID: id, ExpectedVersion: expectedVersion,
		})
	default:
		return Request{}, apperror.InvalidField("unknown request transition")
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, apperror.StaleWrite
	}
	if err != nil {
		return Request{}, err
	}
	if err := s.step(ctx, q, id, target, &actor, note); err != nil {
		return Request{}, err
	}
	if err := s.auditRequest(ctx, tx, &actor, "privacy.subject_request_"+target, id, requestID, nil); err != nil {
		return Request{}, err
	}
	steps, err := q.ListSubjectRequestSteps(ctx, id)
	if err != nil {
		return Request{}, err
	}
	request, err := requestFrom(row, steps)
	if err != nil {
		return Request{}, err
	}
	if request, err = s.withNames(ctx, q, request); err != nil {
		return Request{}, err
	}
	return request, tx.Commit(ctx)
}
