package subjectrequests

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	requestsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// maxExportBytes bounds one export archive; a person's structured data stays
// far below it, and the profile image is already size-limited.
const maxExportBytes = 64 << 20

func subjectFrom(row requestsdb.GetSubjectPersonRow) privacy.DataSubject {
	return privacy.DataSubject{PersonID: row.ID, AccountID: row.AccountID}
}

// subjectCategories lists the categories whose rows are linked to a person or
// an account, in catalog order: the ones a request must cover.
func (s *Service) subjectCategories() []privacy.Definition {
	var result []privacy.Definition
	for _, definition := range s.privacy.Catalog().Definitions() {
		if definition.Subject == privacy.SubjectNone {
			continue
		}
		result = append(result, definition)
	}
	return result
}

// assess runs every handler in a transaction that is rolled back and reports
// counts, outcomes, blockers and holds. It never changes data.
func (s *Service) assess(ctx context.Context, p authorization.Principal, kind string, personID uuid.UUID) (Assessment, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Assessment{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := requestsdb.New(tx)
	person, err := q.GetSubjectPerson(ctx, personID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Assessment{}, apperror.Conflicting("request_subject_missing", "The person of this request no longer exists")
	}
	if err != nil {
		return Assessment{}, err
	}
	subject := subjectFrom(person)
	assessment := Assessment{Categories: []CategoryOutcome{}, Blockers: []string{}, UncoveredCategories: []privacy.CategoryID{}}
	for _, definition := range s.subjectCategories() {
		handler, ok := s.privacy.SubjectHandler(definition.ID)
		if !ok {
			assessment.UncoveredCategories = append(assessment.UncoveredCategories, definition.ID)
			continue
		}
		outcome := CategoryOutcome{CategoryID: definition.ID, Name: definition.Name}
		if kind == KindErasure {
			result, err := handler.Erase(ctx, tx, subject)
			if err != nil {
				return Assessment{}, fmt.Errorf("assess %s: %w", definition.ID, err)
			}
			value := result.Outcome
			outcome.Records, outcome.Outcome, outcome.Note = result.Records, &value, result.Note
		} else {
			section, err := handler.Export(ctx, tx, subject)
			if err != nil {
				return Assessment{}, fmt.Errorf("assess %s: %w", definition.ID, err)
			}
			outcome.Records = section.Records
		}
		assessment.Categories = append(assessment.Categories, outcome)
	}
	if kind == KindErasure {
		holds, err := q.CountOpenPersonHolds(ctx, personID)
		if err != nil {
			return Assessment{}, err
		}
		assessment.OpenHolds = holds
		blockers, err := s.people.DeletionBlockers(ctx, tx, p, personID)
		if err != nil {
			return Assessment{}, err
		}
		for _, blocker := range blockers {
			assessment.Blockers = append(assessment.Blockers, blocker.Code)
		}
	}
	return assessment, nil
}

// Execute performs an approved request (privacy.requests.execute): an access
// request stores its export as a private file, an erasure deletes the person
// through the people service after the category handlers ran.
func (s *Service) Execute(ctx context.Context, p authorization.Principal, id uuid.UUID, expectedVersion int64, requestID *uuid.UUID) (Request, error) {
	if !p.Has(authorization.PrivacyRequestsExecute) {
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
	if current.Status != StatusApproved {
		return Request{}, apperror.Conflicting("request_state_invalid", "Only approved requests can be executed")
	}
	if current.SubjectPersonID == nil {
		return Request{}, apperror.Conflicting("request_subject_missing", "The person of this request no longer exists")
	}
	person, err := q.GetSubjectPerson(ctx, *current.SubjectPersonID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, apperror.Conflicting("request_subject_missing", "The person of this request no longer exists")
	}
	if err != nil {
		return Request{}, err
	}
	actor := p.AccountID
	if err := s.step(ctx, q, id, StatusExecuting, &actor, ""); err != nil {
		return Request{}, err
	}
	var (
		result       Assessment
		status       string
		exportFileID *uuid.UUID
		staged       *files.StagedBlob
		profileImage *uuid.UUID
	)
	switch current.Kind {
	case KindAccess:
		result, staged, err = s.export(ctx, tx, current, person)
		if err != nil {
			return Request{}, err
		}
		defer func() {
			if staged != nil {
				staged.Discard()
			}
		}()
		file, err := staged.Commit(ctx, tx, requestID)
		if err != nil {
			return Request{}, err
		}
		exportFileID, status = &file.ID, StatusCompleted
	case KindErasure:
		result, profileImage, err = s.erase(ctx, tx, p, person, requestID)
		if err != nil {
			return Request{}, err
		}
		status = StatusCompleted
		for _, category := range result.Categories {
			if category.Outcome != nil && category.Records > 0 &&
				(*category.Outcome == privacy.OutcomeRetainedLegal || *category.Outcome == privacy.OutcomeManualReview) {
				status = StatusPartiallyCompleted
			}
		}
		if len(result.UncoveredCategories) > 0 {
			status = StatusPartiallyCompleted
		}
	default:
		return Request{}, apperror.InvalidField("unknown request kind")
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return Request{}, err
	}
	row, err := q.MarkSubjectRequestExecuted(ctx, requestsdb.MarkSubjectRequestExecutedParams{
		Status: status, ActorAccountID: &actor, Result: string(encoded), ExportFileID: exportFileID, ID: id, ExpectedVersion: expectedVersion,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Request{}, apperror.StaleWrite
	}
	if err != nil {
		return Request{}, err
	}
	if err := s.step(ctx, q, id, status, &actor, ""); err != nil {
		return Request{}, err
	}
	var records int64
	for _, category := range result.Categories {
		records += category.Records
	}
	if err := s.auditRequest(ctx, tx, &actor, "privacy.subject_request_executed", id, requestID, map[string]any{
		"countRecords":    fmt.Sprintf("%d", records),
		"countCategories": fmt.Sprintf("%d", len(result.Categories)),
	}); err != nil {
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
	if err := tx.Commit(ctx); err != nil {
		return Request{}, err
	}
	staged = nil
	if profileImage != nil {
		// The person is gone; the profile image blob is removed by the system like after a manual deletion.
		if err := s.files.DeleteSystem(ctx, *profileImage, requestID); err != nil {
			return request, err
		}
	}
	return request, nil
}

type manifestSection struct {
	CategoryID privacy.CategoryID `json:"categoryId"`
	Name       string             `json:"name"`
	Records    int64              `json:"records"`
	File       string             `json:"file"`
	Files      []string           `json:"files,omitempty"`
}

type manifest struct {
	RequestID           uuid.UUID            `json:"requestId"`
	Reference           string               `json:"reference"`
	GeneratedAt         time.Time            `json:"generatedAt"`
	Controller          manifestController   `json:"controller"`
	PersonID            uuid.UUID            `json:"personId"`
	Sections            []manifestSection    `json:"sections"`
	UncoveredCategories []privacy.CategoryID `json:"uncoveredCategories"`
	NotPersonLinked     []privacy.CategoryID `json:"notPersonLinked"`
	ReferencedOnly      string               `json:"referencedOnly"`
}

type manifestController struct {
	Name    string `json:"name"`
	Address string `json:"address"`
	Contact string `json:"contact"`
}

// export builds the ZIP for an access request inside the read transaction and
// stages it in the file store; the caller commits or discards it with tx.
func (s *Service) export(
	ctx context.Context, tx pgx.Tx, current requestsdb.PrivacySubjectRequest, person requestsdb.GetSubjectPersonRow,
) (Assessment, *files.StagedBlob, error) {
	subject := subjectFrom(person)
	settings, err := s.privacy.SettingsForExport(ctx)
	if err != nil {
		return Assessment{}, nil, err
	}
	result := Assessment{Categories: []CategoryOutcome{}, Blockers: []string{}, UncoveredCategories: []privacy.CategoryID{}}
	document := manifest{
		RequestID: current.ID, Reference: current.Reference, GeneratedAt: s.now().UTC(), PersonID: person.ID,
		Controller: manifestController{Name: settings.ControllerName, Address: settings.ControllerAddress, Contact: settings.DataProtectionContact},
		Sections:   []manifestSection{}, UncoveredCategories: []privacy.CategoryID{}, NotPersonLinked: []privacy.CategoryID{},
		ReferencedOnly: "Print files and run timelapses are not person-linked and are only referenced by machine jobs; they are not part of this export.",
	}
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	for _, definition := range s.privacy.Catalog().Definitions() {
		if definition.Subject == privacy.SubjectNone {
			document.NotPersonLinked = append(document.NotPersonLinked, definition.ID)
			continue
		}
		handler, ok := s.privacy.SubjectHandler(definition.ID)
		if !ok {
			result.UncoveredCategories = append(result.UncoveredCategories, definition.ID)
			document.UncoveredCategories = append(document.UncoveredCategories, definition.ID)
			continue
		}
		section, err := handler.Export(ctx, tx, subject)
		if err != nil {
			return Assessment{}, nil, fmt.Errorf("export %s: %w", definition.ID, err)
		}
		entry := manifestSection{CategoryID: definition.ID, Name: definition.Name, Records: section.Records, File: "data/" + string(definition.ID) + ".json"}
		if err := writeEntry(archive, entry.File, section.JSON); err != nil {
			return Assessment{}, nil, err
		}
		for _, file := range section.Files {
			name := "files/" + path.Base(file.Name)
			reader, err := file.Open(ctx)
			if err != nil {
				return Assessment{}, nil, err
			}
			content, err := io.ReadAll(io.LimitReader(reader, maxExportBytes))
			_ = reader.Close()
			if err != nil {
				return Assessment{}, nil, err
			}
			if err := writeEntry(archive, name, content); err != nil {
				return Assessment{}, nil, err
			}
			entry.Files = append(entry.Files, name)
		}
		document.Sections = append(document.Sections, entry)
		result.Categories = append(result.Categories, CategoryOutcome{CategoryID: definition.ID, Name: definition.Name, Records: section.Records})
	}
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return Assessment{}, nil, err
	}
	if err := writeEntry(archive, "manifest.json", encoded); err != nil {
		return Assessment{}, nil, err
	}
	if err := archive.Close(); err != nil {
		return Assessment{}, nil, err
	}
	if buffer.Len() > maxExportBytes {
		return Assessment{}, nil, apperror.Conflicting("export_too_large", "The export exceeds the archive size limit")
	}
	staged, err := s.files.PutSystemBlob(ctx, exportFilename(current), "application/zip", bytes.NewReader(buffer.Bytes()),
		storage.Metadata{Size: int64(buffer.Len()), SHA256: sha256.Sum256(buffer.Bytes())})
	if err != nil {
		return Assessment{}, nil, err
	}
	return result, staged, nil
}

func exportFilename(current requestsdb.PrivacySubjectRequest) string {
	return "subject-request-" + current.ID.String() + ".zip"
}

func writeEntry(archive *zip.Writer, name string, content []byte) error {
	writer, err := archive.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Unix(0, 0).UTC()})
	if err != nil {
		return err
	}
	_, err = writer.Write(content)
	return err
}

// erase runs the category handlers and deletes the person inside tx. The
// returned file id is the profile image to remove once tx committed.
func (s *Service) erase(
	ctx context.Context, tx pgx.Tx, p authorization.Principal, person requestsdb.GetSubjectPersonRow, requestID *uuid.UUID,
) (Assessment, *uuid.UUID, error) {
	if !p.Has(authorization.PeopleDelete) {
		return Assessment{}, nil, apperror.PermissionDenied
	}
	q := requestsdb.New(tx)
	holds, err := q.CountOpenPersonHolds(ctx, person.ID)
	if err != nil {
		return Assessment{}, nil, err
	}
	if holds > 0 {
		return Assessment{}, nil, apperror.Conflicting("erasure_on_hold", "An open retention hold protects this person's data")
	}
	subject := subjectFrom(person)
	result := Assessment{Categories: []CategoryOutcome{}, Blockers: []string{}, UncoveredCategories: []privacy.CategoryID{}}
	for _, definition := range s.subjectCategories() {
		handler, ok := s.privacy.SubjectHandler(definition.ID)
		if !ok {
			result.UncoveredCategories = append(result.UncoveredCategories, definition.ID)
			continue
		}
		outcome, err := handler.Erase(ctx, tx, subject)
		if err != nil {
			return Assessment{}, nil, fmt.Errorf("erase %s: %w", definition.ID, err)
		}
		value := outcome.Outcome
		result.Categories = append(result.Categories, CategoryOutcome{
			CategoryID: definition.ID, Name: definition.Name, Records: outcome.Records, Outcome: &value, Note: outcome.Note,
		})
	}
	profileImage, err := s.people.DeleteInTransaction(ctx, tx, p, person.ID, person.Version, requestID)
	if err != nil {
		return Assessment{}, nil, err
	}
	return result, profileImage, nil
}

// OpenExport returns the export archive of an executed access request (privacy.requests.execute) and audits the download.
func (s *Service) OpenExport(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) (files.File, io.ReadCloser, error) {
	if !p.Has(authorization.PrivacyRequestsExecute) {
		return files.File{}, nil, apperror.PermissionDenied
	}
	row, err := requestsdb.New(s.pool).GetSubjectRequest(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && row.ExportFileID == nil) {
		return files.File{}, nil, apperror.NotFound
	}
	if err != nil {
		return files.File{}, nil, err
	}
	actor := p.AccountID
	if err := audit.Write(ctx, s.pool, audit.Event{
		ActorAccountID: &actor, Action: "privacy.subject_request_export_downloaded", ResourceType: "privacy_subject_request",
		ResourceID: &id, RequestID: requestID,
	}); err != nil {
		return files.File{}, nil, err
	}
	return s.files.Open(ctx, *row.ExportFileID)
}

// ExportFilename is the download name of a request's archive.
func ExportFilename(id uuid.UUID) string { return "subject-request-" + id.String() + ".zip" }

// Processing activities --------------------------------------------------------

// Activity is one entry of the record of processing activities.
type Activity struct {
	ID            uuid.UUID
	Name          string
	Purpose       string
	LegalBasis    string
	CategoryIDs   []privacy.CategoryID
	Recipients    string
	RetentionNote string
	Version       int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
	UpdatedBy     *uuid.UUID
}

// ActivityInput creates or changes an activity.
type ActivityInput struct {
	Name          string
	Purpose       string
	LegalBasis    string
	CategoryIDs   []privacy.CategoryID
	Recipients    string
	RetentionNote string
}

func activityFrom(row requestsdb.PrivacyProcessingActivity) Activity {
	categories := make([]privacy.CategoryID, 0, len(row.CategoryIds))
	for _, id := range row.CategoryIds {
		categories = append(categories, privacy.CategoryID(id))
	}
	return Activity{
		ID: row.ID, Name: row.Name, Purpose: row.Purpose, LegalBasis: row.LegalBasis, CategoryIDs: categories,
		Recipients: row.Recipients, RetentionNote: row.RetentionNote, Version: row.Version,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, UpdatedBy: row.UpdatedByAccountID,
	}
}

// ListActivities returns the record of processing activities (privacy.read).
func (s *Service) ListActivities(ctx context.Context, p authorization.Principal) ([]Activity, error) {
	if !p.Has(authorization.PrivacyRead) {
		return nil, apperror.PermissionDenied
	}
	rows, err := requestsdb.New(s.pool).ListProcessingActivities(ctx)
	if err != nil {
		return nil, err
	}
	activities := make([]Activity, 0, len(rows))
	for _, row := range rows {
		activities = append(activities, activityFrom(row))
	}
	return activities, nil
}

func (s *Service) validateActivity(input ActivityInput) (ActivityInput, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" {
		return input, apperror.InvalidField("name is required")
	}
	seen := map[privacy.CategoryID]bool{}
	for _, id := range input.CategoryIDs {
		if _, ok := s.privacy.Catalog().Lookup(id); !ok {
			return input, apperror.InvalidField("unknown category " + string(id))
		}
		if seen[id] {
			return input, apperror.InvalidField("category listed twice: " + string(id))
		}
		seen[id] = true
	}
	input.Purpose, input.LegalBasis = strings.TrimSpace(input.Purpose), strings.TrimSpace(input.LegalBasis)
	input.Recipients, input.RetentionNote = strings.TrimSpace(input.Recipients), strings.TrimSpace(input.RetentionNote)
	return input, nil
}

func categoryStrings(ids []privacy.CategoryID) []string {
	result := make([]string, 0, len(ids))
	for _, id := range ids {
		result = append(result, string(id))
	}
	return result
}

// CreateActivity adds an activity (privacy.settings.manage).
func (s *Service) CreateActivity(ctx context.Context, p authorization.Principal, input ActivityInput, requestID *uuid.UUID) (result Activity, err error) {
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.CreateActivityTx(ctx, tx, p, input, requestID)
		return err
	})
	return result, err
}

// CreateActivityTx is CreateActivity inside the caller's transaction.
func (s *Service) CreateActivityTx(
	ctx context.Context, tx pgx.Tx, p authorization.Principal, input ActivityInput, requestID *uuid.UUID,
) (Activity, error) {
	if !p.Has(authorization.PrivacySettingsManage) {
		return Activity{}, apperror.PermissionDenied
	}
	input, err := s.validateActivity(input)
	if err != nil {
		return Activity{}, err
	}
	actor := p.AccountID
	row, err := requestsdb.New(tx).InsertProcessingActivity(ctx, requestsdb.InsertProcessingActivityParams{
		ID: ids.New(), Name: input.Name, Purpose: input.Purpose, LegalBasis: input.LegalBasis, CategoryIds: categoryStrings(input.CategoryIDs),
		Recipients: input.Recipients, RetentionNote: input.RetentionNote, UpdatedByAccountID: &actor,
	})
	if err != nil {
		return Activity{}, err
	}
	if err := s.auditActivity(ctx, tx, actor, "privacy.processing_activity_created", row.ID, requestID); err != nil {
		return Activity{}, err
	}
	return activityFrom(row), nil
}

// UpdateActivity changes an activity (privacy.settings.manage), version-checked.
func (s *Service) UpdateActivity(
	ctx context.Context, p authorization.Principal, id uuid.UUID, input ActivityInput, expectedVersion int64, requestID *uuid.UUID,
) (result Activity, err error) {
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) (err error) {
		result, err = s.UpdateActivityTx(ctx, tx, p, id, input, expectedVersion, requestID)
		return err
	})
	return result, err
}

// UpdateActivityTx is UpdateActivity inside the caller's transaction.
func (s *Service) UpdateActivityTx(
	ctx context.Context, tx pgx.Tx, p authorization.Principal, id uuid.UUID, input ActivityInput, expectedVersion int64,
	requestID *uuid.UUID,
) (Activity, error) {
	if !p.Has(authorization.PrivacySettingsManage) {
		return Activity{}, apperror.PermissionDenied
	}
	input, err := s.validateActivity(input)
	if err != nil {
		return Activity{}, err
	}
	q := requestsdb.New(tx)
	if _, err := q.GetProcessingActivity(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return Activity{}, apperror.NotFound
	} else if err != nil {
		return Activity{}, err
	}
	actor := p.AccountID
	row, err := q.UpdateProcessingActivity(ctx, requestsdb.UpdateProcessingActivityParams{
		Name: input.Name, Purpose: input.Purpose, LegalBasis: input.LegalBasis, CategoryIds: categoryStrings(input.CategoryIDs),
		Recipients: input.Recipients, RetentionNote: input.RetentionNote, UpdatedByAccountID: &actor, ID: id, ExpectedVersion: expectedVersion,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Activity{}, apperror.StaleWrite
	}
	if err != nil {
		return Activity{}, err
	}
	if err := s.auditActivity(ctx, tx, actor, "privacy.processing_activity_updated", id, requestID); err != nil {
		return Activity{}, err
	}
	return activityFrom(row), nil
}

// DeleteActivity removes an activity (privacy.settings.manage), version-checked.
func (s *Service) DeleteActivity(ctx context.Context, p authorization.Principal, id uuid.UUID, expectedVersion int64, requestID *uuid.UUID) error {
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		return s.DeleteActivityTx(ctx, tx, p, id, expectedVersion, requestID)
	})
}

// DeleteActivityTx is DeleteActivity inside the caller's transaction.
func (s *Service) DeleteActivityTx(
	ctx context.Context, tx pgx.Tx, p authorization.Principal, id uuid.UUID, expectedVersion int64, requestID *uuid.UUID,
) error {
	if !p.Has(authorization.PrivacySettingsManage) {
		return apperror.PermissionDenied
	}
	q := requestsdb.New(tx)
	if _, err := q.GetProcessingActivity(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	_, err := q.DeleteProcessingActivity(ctx, requestsdb.DeleteProcessingActivityParams{ID: id, ExpectedVersion: expectedVersion})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.StaleWrite
	}
	if err != nil {
		return err
	}
	return s.auditActivity(ctx, tx, p.AccountID, "privacy.processing_activity_deleted", id, requestID)
}

func (s *Service) auditActivity(ctx context.Context, tx pgx.Tx, actor uuid.UUID, action string, id uuid.UUID, requestID *uuid.UUID) error {
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor, Action: action, ResourceType: "privacy_processing_activity", ResourceID: &id, RequestID: requestID,
	})
}
