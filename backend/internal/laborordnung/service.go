package laborordnung

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	laborordnungdb "github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/ledongthuc/pdf"
)

const maxPDFBytes = 25 << 20

type Version struct {
	ID            uuid.UUID
	Status        string
	HumanRevision string
	PDFFileID     uuid.UUID
	SHA256        string
	EffectiveAt   *time.Time
	PublishedAt   *time.Time
	CreatedAt     time.Time
}

type Status struct {
	Mode                   string
	State                  string
	ActionRequired         bool
	CurrentVersion         *Version
	LatestConfirmedVersion *Version
	RequestID              *uuid.UUID
}

type Request struct {
	ID                        uuid.UUID
	PersonID                  uuid.UUID
	PersonName                string
	RequiredVersion           Version
	PreviousVersion           *Version
	Status                    string
	RequestedAt               time.Time
	CompletedAt               *time.Time
	PhysicalDocumentReference *string
	SignedDate                *time.Time
	ArchiveNote               *string
}

type Service struct {
	pool  *pgxpool.Pool
	files *files.Service
}

func NewService(pool *pgxpool.Pool, fileService *files.Service) *Service {
	return &Service{pool: pool, files: fileService}
}

func (s *Service) CreateVersion(ctx context.Context, principal authorization.Principal, revision, filename string, reader io.Reader, requestID *uuid.UUID) (Version, error) {
	if !principal.Has(authorization.LaborordnungManage) {
		return Version{}, apperror.PermissionDenied
	}
	revision = strings.TrimSpace(revision)
	if revision == "" || len([]rune(revision)) > 100 {
		return Version{}, validation("human revision is required and limited to 100 characters")
	}
	data, err := io.ReadAll(io.LimitReader(reader, maxPDFBytes+1))
	if err != nil {
		return Version{}, err
	}
	if len(data) == 0 || len(data) > maxPDFBytes {
		return Version{}, apperror.New(413, "laborordnung_pdf_too_large", "Lab Rules PDF exceeds 25 MiB")
	}
	parsed, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil || parsed.NumPage() < 1 {
		return Version{}, validation("uploaded content is not a parseable PDF with at least one page")
	}
	stored, err := s.files.StoreBytes(ctx, principal, filename, "application/pdf", data, requestID)
	if err != nil {
		return Version{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = s.files.Delete(context.Background(), principal, stored.ID, requestID)
		}
	}()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Version{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := uuid.Must(uuid.NewV7())
	actor := principal.AccountID
	row, err := laborordnungdb.New(tx).CreateVersion(ctx, laborordnungdb.CreateVersionParams{
		ID: id, HumanRevision: revision, PdfFileID: stored.ID, PdfSha256: stored.SHA256[:], CreatedByAccountID: &actor,
	})
	if err != nil {
		return Version{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "laborordnung.version.created", ResourceType: "laborordnung_version", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"humanRevision", "pdfFileId"}}); err != nil {
		return Version{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Version{}, err
	}
	committed = true
	return versionFromRow(row), nil
}

func (s *Service) ListVersions(ctx context.Context, principal authorization.Principal) ([]Version, error) {
	if !principal.Has(authorization.LaborordnungRead) && !principal.Has(authorization.LaborordnungManage) {
		return nil, apperror.PermissionDenied
	}
	rows, err := laborordnungdb.New(s.pool).ListVersions(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Version, 0, len(rows))
	for _, row := range rows {
		result = append(result, versionFromRow(row))
	}
	return result, nil
}

func (s *Service) Publish(ctx context.Context, principal authorization.Principal, id uuid.UUID, effectiveAt time.Time, requestID *uuid.UUID) (Version, error) {
	if !principal.Has(authorization.LaborordnungManage) {
		return Version{}, apperror.PermissionDenied
	}
	if effectiveAt.IsZero() {
		return Version{}, validation("effectiveAt is required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Version{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, err := laborordnungdb.New(tx).PublishVersion(ctx, laborordnungdb.PublishVersionParams{ID: id, EffectiveAt: pgtype.Timestamptz{Time: effectiveAt.UTC(), Valid: true}})
	if errors.Is(err, pgx.ErrNoRows) {
		return Version{}, apperror.New(409, "laborordnung_not_draft", "Only an existing draft can be published")
	}
	if err != nil {
		return Version{}, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "laborordnung.version.published", ResourceType: "laborordnung_version", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"status", "effectiveAt"}}); err != nil {
		return Version{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Version{}, err
	}
	return versionFromRow(row), nil
}

func (s *Service) OpenPDF(ctx context.Context, principal authorization.Principal, id uuid.UUID) (files.File, io.ReadCloser, error) {
	if !principal.Has(authorization.LaborordnungRead) && !principal.Has(authorization.LaborordnungManage) {
		queries := laborordnungdb.New(s.pool)
		mode, err := queries.GetPersonMode(ctx, principal.PersonID)
		if err != nil {
			return files.File{}, nil, err
		}
		current, err := queries.GetCurrentVersion(ctx)
		if mode == "not_required" || err != nil || current.ID != id {
			return files.File{}, nil, apperror.PermissionDenied
		}
	}
	row, err := laborordnungdb.New(s.pool).GetVersion(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return files.File{}, nil, apperror.NotFound
	}
	if err != nil {
		return files.File{}, nil, err
	}
	return s.files.Open(ctx, row.PdfFileID)
}

// Evaluate is deliberately read-only. Merely authenticating or reading status
// must never enqueue a physical-signature request.
func (s *Service) Evaluate(ctx context.Context, personID uuid.UUID) (Status, error) {
	queries := laborordnungdb.New(s.pool)
	mode, err := queries.GetPersonMode(ctx, personID)
	if err != nil {
		return Status{}, err
	}
	status := Status{Mode: mode, State: "not_required"}
	if mode == "not_required" {
		return status, nil
	}
	current, err := queries.GetCurrentVersion(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		status.State = "no_published_version"
		return status, nil
	}
	if err != nil {
		return Status{}, err
	}
	version := versionFromRow(current)
	status.CurrentVersion = &version
	completed, completedErr := queries.GetLatestCompletedRequest(ctx, personID)
	if completedErr != nil && !errors.Is(completedErr, pgx.ErrNoRows) {
		return Status{}, completedErr
	}
	if completedErr == nil {
		confirmed, err := queries.GetVersion(ctx, completed.RequiredVersionID)
		if err != nil {
			return Status{}, err
		}
		value := versionFromRow(confirmed)
		status.LatestConfirmedVersion = &value
		if completed.RequiredVersionID == current.ID {
			status.State = "current"
			return status, nil
		}
	}
	status.State = "outdated"
	status.ActionRequired = true
	pending, pendingErr := queries.GetPendingRequestForStatus(ctx, personID)
	if pendingErr == nil && pending.RequiredVersionID == current.ID {
		status.RequestID = &pending.ID
	} else if pendingErr != nil && !errors.Is(pendingErr, pgx.ErrNoRows) {
		return Status{}, pendingErr
	}
	return status, nil
}

// RequestOwnConfirmation is the explicit, idempotent command that enqueues a
// physical-signature confirmation. It is never called from authentication or
// status reads.
func (s *Service) RequestOwnConfirmation(ctx context.Context, principal authorization.Principal, requestID *uuid.UUID) (Request, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Request{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := laborordnungdb.New(tx)
	if err := queries.LockPerson(ctx, principal.PersonID); err != nil {
		return Request{}, false, err
	}
	mode, err := queries.GetPersonMode(ctx, principal.PersonID)
	if err != nil {
		return Request{}, false, err
	}
	if mode == "not_required" {
		return Request{}, false, apperror.New(409, "lab_rules_not_required", "Lab Rules confirmation is not required")
	}
	current, err := queries.GetCurrentVersion(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, false, apperror.New(409, "lab_rules_unavailable", "No effective Lab Rules version is available")
	}
	if err != nil {
		return Request{}, false, err
	}
	completed, completedErr := queries.GetLatestCompletedRequest(ctx, principal.PersonID)
	if completedErr == nil && completed.RequiredVersionID == current.ID {
		return Request{}, false, apperror.New(409, "lab_rules_current", "The current Lab Rules are already confirmed")
	}
	if completedErr != nil && !errors.Is(completedErr, pgx.ErrNoRows) {
		return Request{}, false, completedErr
	}
	pending, pendingErr := queries.GetPendingRequest(ctx, principal.PersonID)
	if pendingErr == nil && pending.RequiredVersionID == current.ID {
		result, err := s.hydrateRequest(ctx, queries, pending)
		if err != nil {
			return Request{}, false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Request{}, false, err
		}
		return result, false, nil
	}
	if pendingErr == nil {
		if err := queries.SupersedePendingRequest(ctx, pending.ID); err != nil {
			return Request{}, false, err
		}
	} else if !errors.Is(pendingErr, pgx.ErrNoRows) {
		return Request{}, false, pendingErr
	}
	var previous *uuid.UUID
	if completedErr == nil {
		previous = &completed.RequiredVersionID
	}
	created, err := queries.CreateRequest(ctx, laborordnungdb.CreateRequestParams{
		ID: uuid.Must(uuid.NewV7()), PersonID: principal.PersonID,
		RequiredVersionID: current.ID, PreviousVersionID: previous,
	})
	if err != nil {
		return Request{}, false, err
	}
	actor := principal.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "laborordnung.request.created", ResourceType: "laborordnung_request", ResourceID: &created.ID, RequestID: requestID}); err != nil {
		return Request{}, false, err
	}
	result, err := s.hydrateRequest(ctx, queries, created)
	if err != nil {
		return Request{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Request{}, false, err
	}
	return result, true, nil
}

func (s *Service) ListRequests(ctx context.Context, principal authorization.Principal) ([]Request, error) {
	if !principal.Has(authorization.LaborordnungRequestsRead) {
		return nil, apperror.PermissionDenied
	}
	queries := laborordnungdb.New(s.pool)
	rows, err := queries.ListRequests(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Request, 0, len(rows))
	for _, row := range rows {
		hydrated, err := s.hydrateRequest(ctx, queries, row)
		if err != nil {
			return nil, err
		}
		result = append(result, hydrated)
	}
	return result, nil
}

func (s *Service) Confirm(ctx context.Context, principal authorization.Principal, id uuid.UUID, reference string, signedDate *time.Time, archiveNote *string, requestID *uuid.UUID) (Request, error) {
	if !principal.Has(authorization.LaborordnungConfirm) {
		return Request{}, apperror.PermissionDenied
	}
	reference = strings.TrimSpace(reference)
	if reference == "" || len([]rune(reference)) > 255 {
		return Request{}, validation("physical document reference is required and limited to 255 characters")
	}
	archiveNote = cleanOptional(archiveNote)
	if archiveNote != nil && len([]rune(*archiveNote)) > 1000 {
		return Request{}, validation("archive note is too long")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Request{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := laborordnungdb.New(tx)
	current, err := queries.GetRequestForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, apperror.NotFound
	}
	if err != nil {
		return Request{}, err
	}
	if current.Status != "pending" {
		return Request{}, apperror.New(409, "laborordnung_request_not_pending", "Only a pending request can be confirmed")
	}
	var date pgtype.Date
	if signedDate != nil {
		date = pgtype.Date{Time: signedDate.UTC(), Valid: true}
	}
	actor := principal.AccountID
	row, err := queries.ConfirmRequest(ctx, laborordnungdb.ConfirmRequestParams{ID: id, ConfirmedByAccountID: &actor, PhysicalDocumentReference: &reference, SignedDate: date, ArchiveNote: archiveNote})
	if err != nil {
		return Request{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &actor, Action: "laborordnung.request.confirmed", ResourceType: "laborordnung_request", ResourceID: &id, RequestID: requestID, ChangedFields: []string{"status", "physicalDocumentReference", "signedDate", "archiveNote"}}); err != nil {
		return Request{}, err
	}
	result, err := s.hydrateRequest(ctx, queries, row)
	if err != nil {
		return Request{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Request{}, err
	}
	return result, nil
}

func (s *Service) hydrateRequest(ctx context.Context, queries *laborordnungdb.Queries, row laborordnungdb.LaborordnungRequest) (Request, error) {
	name, err := queries.GetPersonName(ctx, row.PersonID)
	if err != nil {
		return Request{}, err
	}
	required, err := queries.GetVersion(ctx, row.RequiredVersionID)
	if err != nil {
		return Request{}, err
	}
	result := Request{ID: row.ID, PersonID: row.PersonID, PersonName: name.FirstName + " " + name.LastName, RequiredVersion: versionFromRow(required), Status: row.Status, RequestedAt: row.RequestedAt, PhysicalDocumentReference: row.PhysicalDocumentReference, ArchiveNote: row.ArchiveNote}
	if row.PreviousVersionID != nil {
		previous, err := queries.GetVersion(ctx, *row.PreviousVersionID)
		if err != nil {
			return Request{}, err
		}
		value := versionFromRow(previous)
		result.PreviousVersion = &value
	}
	if row.CompletedAt.Valid {
		result.CompletedAt = &row.CompletedAt.Time
	}
	if row.SignedDate.Valid {
		result.SignedDate = &row.SignedDate.Time
	}
	return result, nil
}

func versionFromRow(row laborordnungdb.LaborordnungVersion) Version {
	result := Version{ID: row.ID, Status: row.Status, HumanRevision: row.HumanRevision, PDFFileID: row.PdfFileID, SHA256: hex.EncodeToString(row.PdfSha256), CreatedAt: row.CreatedAt}
	if row.EffectiveAt.Valid {
		result.EffectiveAt = &row.EffectiveAt.Time
	}
	if row.PublishedAt.Valid {
		result.PublishedAt = &row.PublishedAt.Time
	}
	return result
}

func cleanOptional(value *string) *string {
	if value == nil {
		return nil
	}
	clean := strings.TrimSpace(*value)
	if clean == "" {
		return nil
	}
	return &clean
}

func validation(reason string) *apperror.Error {
	err := apperror.New(422, "validation_failed", "Request validation failed")
	err.Details["reason"] = reason
	return err
}
