package printartifacts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts/parser"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

// MaxCompressedSize is the largest uploaded print artifact.
const MaxCompressedSize int64 = 512 << 20

type Service struct {
	pool    *pgxpool.Pool
	files   *files.Service
	logbook *machinelogbook.Service
}

func NewService(pool *pgxpool.Pool, fileService *files.Service, logbook *machinelogbook.Service) *Service {
	return &Service{pool: pool, files: fileService, logbook: logbook}
}

type Filament struct {
	Key, Type, Color                               string
	Extruder                                       *int
	WeightGrams, LengthMM, DensityGCM3, DiameterMM *string
}

type Artifact struct {
	ID, OriginalFileID          uuid.UUID
	OriginalFilename, SHA256    string
	SizeBytes                   int64
	ParserStatus, ParserVersion string
	Metadata                    map[string]any
	PrimaryPreviewID            *uuid.UUID
	Filaments                   []Filament
	CreatedAt, UpdatedAt        time.Time
}

type Preview struct {
	ID, ArtifactID    uuid.UUID
	ArchivePath, Role string
	PlateNumber       *int
	Width, Height     int
	MIMEType, SHA256  string
	SizeBytes         int64
	Primary           bool
	FileID            uuid.UUID
}

type UploadResult struct {
	Artifact          Artifact
	Disposition       string
	RunID             uuid.UUID
	AutoAttachedJobID *uuid.UUID
}

type PlannedJobInput struct {
	MachineID        uuid.UUID
	Customer         machinelogbook.PartyReference
	OperatorPersonID uuid.UUID
	Title, Notes     *string
	PricingGroupID   *uuid.UUID
}

func validation(code, message string) error { return apperror.New(422, code, message) }
func conflict(code, message string) error   { return apperror.New(409, code, message) }

func (s *Service) Get(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Artifact, error) {
	if !principal.Has(authorization.PrintArtifactsRead) {
		return Artifact{}, apperror.PermissionDenied
	}
	return s.load(ctx, db.New(s.pool), id)
}

func (s *Service) load(ctx context.Context, q *db.Queries, id uuid.UUID) (Artifact, error) {
	row, err := q.GetArtifactByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Artifact{}, apperror.NotFound
	}
	if err != nil {
		return Artifact{}, err
	}
	return s.artifactFromRow(ctx, q, row)
}

func (s *Service) artifactFromRow(ctx context.Context, q *db.Queries, row db.GetArtifactByIDRow) (Artifact, error) {
	var metadata map[string]any
	if err := json.Unmarshal(row.Metadata, &metadata); err != nil {
		return Artifact{}, fmt.Errorf("decode artifact metadata: %w", err)
	}
	result := Artifact{ID: row.ID, OriginalFileID: row.OriginalFileID, OriginalFilename: row.OriginalFilename, SHA256: hex.EncodeToString(row.Sha256), SizeBytes: row.SizeBytes, ParserStatus: row.ParserStatus, ParserVersion: row.ParserVersion, Metadata: metadata, PrimaryPreviewID: row.PrimaryPreviewID, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Filaments: []Filament{}}
	rows, err := q.ListArtifactFilaments(ctx, row.ID)
	if err != nil {
		return Artifact{}, err
	}
	for _, item := range rows {
		var extruder *int
		if item.Extruder != nil {
			v := int(*item.Extruder)
			extruder = &v
		}
		result.Filaments = append(result.Filaments, Filament{Key: item.FilamentKey, Type: stringValue(item.FilamentType), Color: stringValue(item.Color), Extruder: extruder, WeightGrams: numericString(item.PlannedWeightG), LengthMM: numericString(item.PlannedLengthMm), DensityGCM3: numericString(item.DensityGCm3), DiameterMM: numericString(item.DiameterMm)})
	}
	return result, nil
}

func (s *Service) Open(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Artifact, io.ReadCloser, error) {
	artifact, err := s.Get(ctx, principal, id)
	if err != nil {
		return Artifact{}, nil, err
	}
	_, reader, err := s.files.Open(ctx, artifact.OriginalFileID)
	return artifact, reader, err
}

func (s *Service) ListPreviews(ctx context.Context, principal authorization.Principal, artifactID uuid.UUID) ([]Preview, error) {
	artifact, err := s.Get(ctx, principal, artifactID)
	if err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListArtifactPreviews(ctx, artifactID)
	if err != nil {
		return nil, err
	}
	result := make([]Preview, 0, len(rows))
	for _, row := range rows {
		var plate *int
		if row.PlateNumber != nil {
			v := int(*row.PlateNumber)
			plate = &v
		}
		result = append(result, Preview{ID: row.ID, ArtifactID: row.ArtifactID, FileID: row.FileID, ArchivePath: row.ArchivePath, Role: row.Role, PlateNumber: plate, Width: int(row.Width), Height: int(row.Height), MIMEType: row.MimeType, SizeBytes: row.SizeBytes, SHA256: hex.EncodeToString(row.Sha256), Primary: artifact.PrimaryPreviewID != nil && *artifact.PrimaryPreviewID == row.ID})
	}
	return result, nil
}

func (s *Service) OpenPreview(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Preview, io.ReadCloser, error) {
	if !principal.Has(authorization.PrintArtifactsRead) {
		return Preview{}, nil, apperror.PermissionDenied
	}
	row, err := db.New(s.pool).GetArtifactPreview(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Preview{}, nil, apperror.NotFound
	}
	if err != nil {
		return Preview{}, nil, err
	}
	var plate *int
	if row.PlateNumber != nil {
		v := int(*row.PlateNumber)
		plate = &v
	}
	artifact, err := db.New(s.pool).GetArtifactByID(ctx, row.ArtifactID)
	if err != nil {
		return Preview{}, nil, err
	}
	_, reader, err := s.files.Open(ctx, row.FileID)
	if err != nil {
		return Preview{}, nil, err
	}
	return Preview{ID: row.ID, ArtifactID: row.ArtifactID, FileID: row.FileID, ArchivePath: row.ArchivePath, Role: row.Role, PlateNumber: plate, Width: int(row.Width), Height: int(row.Height), MIMEType: row.MimeType, SizeBytes: row.SizeBytes, SHA256: hex.EncodeToString(row.Sha256), Primary: artifact.PrimaryPreviewID != nil && *artifact.PrimaryPreviewID == row.ID}, reader, nil
}

func (s *Service) Upload(ctx context.Context, connectorID, assignmentID, runID uuid.UUID, configurationVersion int64, filename, declaredSHA string, contentLength int64, body io.Reader, requestID *uuid.UUID) (UploadResult, error) {
	filename = strings.TrimSpace(filename)
	if filename == "" || len(filename) > 255 || contentLength < 1 || contentLength > MaxCompressedSize {
		return UploadResult{}, validation("artifact_metadata_invalid", "Artifact filename and content length are invalid")
	}
	digestBytes, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(declaredSHA)))
	if err != nil || len(digestBytes) != sha256.Size || configurationVersion < 1 {
		return UploadResult{}, validation("artifact_metadata_invalid", "Artifact SHA-256 or configuration version is invalid")
	}
	check, err := db.New(s.pool).CheckConnectorArtifactUploadTarget(ctx, db.CheckConnectorArtifactUploadTargetParams{AssignmentID: assignmentID, ConnectorID: connectorID, RunID: runID})
	if errors.Is(err, pgx.ErrNoRows) {
		return UploadResult{}, apperror.NotFound
	}
	if err != nil {
		return UploadResult{}, err
	}
	if check.ConfigurationVersion != configurationVersion {
		return UploadResult{}, conflict("configuration_version_mismatch", "Assignment configuration has changed")
	}
	temp, err := os.CreateTemp("", "makerspace-artifact-*.3mf")
	if err != nil {
		return UploadResult{}, err
	}
	path := temp.Name()
	defer os.Remove(path)
	defer temp.Close()
	if err = temp.Chmod(0o600); err != nil {
		return UploadResult{}, err
	}
	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(temp, hasher), io.LimitReader(body, contentLength+1))
	if err != nil {
		return UploadResult{}, err
	}
	if written != contentLength || !bytes.Equal(hasher.Sum(nil), digestBytes) {
		return UploadResult{}, validation("artifact_integrity_mismatch", "Uploaded bytes do not match the declared length and SHA-256")
	}
	if _, err = temp.Seek(0, io.SeekStart); err != nil {
		return UploadResult{}, err
	}
	parsed, err := parser.Parse(temp, contentLength, parser.DefaultLimits())
	if err != nil {
		var invalid *parser.ValidationError
		if errors.As(err, &invalid) {
			return UploadResult{}, validation("artifact_"+invalid.Code, "Archived printer job failed validation")
		}
		return UploadResult{}, validation("artifact_parse_failed", "Archived printer job could not be parsed")
	}
	metadata, err := normalizedMetadata(parsed)
	if err != nil {
		return UploadResult{}, err
	}
	return s.persistUpload(ctx, connectorID, assignmentID, runID, configurationVersion, filename, contentLength, digestBytes, temp, parsed, metadata, requestID)
}

func normalizedMetadata(result parser.Result) ([]byte, error) {
	m := result.Metadata
	value := map[string]any{"schemaVersion": 1, "warnings": result.Warnings}
	if m.JobName != "" {
		value["jobName"] = m.JobName
	}
	if m.SlicerName != "" {
		value["slicerName"] = m.SlicerName
	}
	if m.SlicerVersion != "" {
		value["slicerVersion"] = m.SlicerVersion
	}
	if m.PrinterProfile != "" {
		value["printerProfile"] = m.PrinterProfile
	}
	if m.BuildPlate != "" {
		value["buildPlate"] = m.BuildPlate
	}
	if len(m.ModelNames) != 0 {
		value["modelNames"] = m.ModelNames
	}
	if len(m.PlateNumbers) != 0 {
		value["plateNumbers"] = m.PlateNumbers
	}
	if m.EstimatedDurationSeconds != nil {
		value["estimatedDurationSeconds"] = m.EstimatedDurationSeconds
	}
	if m.LayerCount != nil {
		value["layerCount"] = m.LayerCount
	}
	if m.FilamentChanges != nil {
		value["filamentChanges"] = m.FilamentChanges
	}
	if m.PurgeWeightGrams != nil {
		value["purgeWeightGrams"] = m.PurgeWeightGrams
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(encoded) > 65536 {
		return nil, validation("artifact_metadata_too_large", "Normalized artifact metadata is too large")
	}
	return encoded, nil
}

func (s *Service) persistUpload(ctx context.Context, connectorID, assignmentID, runID uuid.UUID, configurationVersion int64, filename string, size int64, digest []byte, temp *os.File, parsed parser.Result, metadata []byte, requestID *uuid.UUID) (UploadResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	committed := false
	cleanups := []func(){}
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
			for _, cleanup := range cleanups {
				cleanup()
			}
		}
	}()
	q := db.New(tx)
	target, err := q.GetConnectorArtifactUploadTarget(ctx, db.GetConnectorArtifactUploadTargetParams{AssignmentID: assignmentID, ConnectorID: connectorID, RunID: runID})
	if errors.Is(err, pgx.ErrNoRows) {
		return UploadResult{}, apperror.NotFound
	}
	if err != nil {
		return UploadResult{}, err
	}
	if target.ConfigurationVersion != configurationVersion {
		return UploadResult{}, conflict("configuration_version_mismatch", "Assignment configuration has changed")
	}
	if existing, getErr := q.GetArtifactBySHA256(ctx, digest); getErr == nil {
		return s.attachExisting(ctx, tx, q, target, existing.ID, connectorID, assignmentID, runID, requestID, &committed)
	} else if !errors.Is(getErr, pgx.ErrNoRows) {
		return UploadResult{}, getErr
	}
	if _, err = temp.Seek(0, io.SeekStart); err != nil {
		return UploadResult{}, err
	}
	var expected storage.Metadata
	expected.Size = size
	copy(expected.SHA256[:], digest)
	file, cleanup, err := s.files.StoreSystemReaderInTransaction(ctx, tx, filename, "application/vnd.ms-package.3dmanufacturing-3dmodel+xml", temp, expected, requestID)
	if err != nil {
		return UploadResult{}, err
	}
	cleanups = append(cleanups, cleanup)
	artifactID := uuid.Must(uuid.NewV7())
	status := "complete"
	if parsed.Status == parser.StatusPartial {
		status = "partial"
	}
	_, err = q.InsertArtifact(ctx, db.InsertArtifactParams{ID: artifactID, OriginalFileID: file.ID, Sha256: digest, ParserStatus: status, ParserVersion: parsed.ParserVersion, Metadata: metadata})
	if errors.Is(err, pgx.ErrNoRows) {
		_ = tx.Rollback(ctx)
		for _, cleanup := range cleanups {
			cleanup()
		}
		cleanups = nil
		committed = true
		return s.attachExistingAfterRace(ctx, connectorID, assignmentID, runID, digest, requestID)
	}
	if err != nil {
		return UploadResult{}, err
	}
	for _, filament := range parsed.Filaments {
		var extruder *int32
		if len(filament.Extruders) != 0 {
			v := int32(filament.Extruders[0])
			extruder = &v
		}
		if err = q.InsertArtifactFilament(ctx, db.InsertArtifactFilamentParams{ArtifactID: artifactID, FilamentKey: filament.ID, FilamentType: optionalString(filament.Type), Color: optionalString(filament.Color), Extruder: extruder, PlannedWeightG: floatNumeric(filament.WeightGrams), PlannedLengthMm: floatNumeric(filament.LengthMM), DensityGCm3: floatNumeric(filament.DensityGCM3), DiameterMm: floatNumeric(filament.DiameterMM)}); err != nil {
			return UploadResult{}, err
		}
	}
	var primary *uuid.UUID
	for _, preview := range parsed.Previews {
		previewDigest, decodeErr := hex.DecodeString(preview.SHA256)
		if decodeErr != nil {
			return UploadResult{}, decodeErr
		}
		var previewExpected storage.Metadata
		previewExpected.Size = preview.Size
		copy(previewExpected.SHA256[:], previewDigest)
		stored, previewCleanup, storeErr := s.files.StoreSystemReaderInTransaction(ctx, tx, filepath.Base(preview.ArchivePath), preview.MIMEType, bytes.NewReader(preview.Bytes), previewExpected, requestID)
		if storeErr != nil {
			return UploadResult{}, storeErr
		}
		cleanups = append(cleanups, previewCleanup)
		role := "other"
		if preview.Role == parser.PreviewRolePlate {
			role = "plate"
		}
		var plate *int32
		if preview.PlateNumber != nil {
			v := int32(*preview.PlateNumber)
			plate = &v
		}
		previewID := uuid.Must(uuid.NewV7())
		row, insertErr := q.InsertArtifactPreview(ctx, db.InsertArtifactPreviewParams{ID: previewID, ArtifactID: artifactID, FileID: stored.ID, ArchivePath: preview.ArchivePath, Role: &role, PlateNumber: plate, Width: int32(preview.Width), Height: int32(preview.Height), MimeType: preview.MIMEType, SizeBytes: preview.Size, Sha256: previewDigest})
		if errors.Is(insertErr, pgx.ErrNoRows) {
			continue
		}
		if insertErr != nil {
			return UploadResult{}, insertErr
		}
		if preview.Primary {
			v := row.ID
			primary = &v
		}
	}
	if err = q.SetArtifactPrimaryPreview(ctx, db.SetArtifactPrimaryPreviewParams{PrimaryPreviewID: primary, ID: artifactID}); err != nil {
		return UploadResult{}, err
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: "print_artifact.created", ResourceType: "print_artifact", ResourceID: &artifactID, RequestID: requestID, Source: "system", ChangedFields: []string{"file", "metadata", "previews", "filaments"}, Metadata: map[string]any{"connectorId": connectorID.String(), "assignmentId": assignmentID.String(), "runId": runID.String(), "artifactId": artifactID.String()}}); err != nil {
		return UploadResult{}, err
	}
	result, err := s.attachArtifact(ctx, tx, q, target, artifactID, connectorID, assignmentID, runID, requestID)
	if err != nil {
		return UploadResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return UploadResult{}, err
	}
	committed = true
	for range cleanups { /* committed blobs are retained */
	}
	result.Disposition = "created"
	result.Artifact, err = s.load(ctx, db.New(s.pool), artifactID)
	return result, err
}

func (s *Service) attachExistingAfterRace(ctx context.Context, connectorID, assignmentID, runID uuid.UUID, digest []byte, requestID *uuid.UUID) (UploadResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()
	q := db.New(tx)
	target, err := q.GetConnectorArtifactUploadTarget(ctx, db.GetConnectorArtifactUploadTargetParams{AssignmentID: assignmentID, ConnectorID: connectorID, RunID: runID})
	if errors.Is(err, pgx.ErrNoRows) {
		return UploadResult{}, apperror.NotFound
	}
	if err != nil {
		return UploadResult{}, err
	}
	existing, err := q.GetArtifactBySHA256(ctx, digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return UploadResult{}, conflict("artifact_deduplication_race", "Artifact upload conflicted and can be retried")
	}
	if err != nil {
		return UploadResult{}, err
	}
	return s.attachExisting(ctx, tx, q, target, existing.ID, connectorID, assignmentID, runID, requestID, &committed)
}

func (s *Service) attachExisting(ctx context.Context, tx pgx.Tx, q *db.Queries, target db.GetConnectorArtifactUploadTargetRow, artifactID, connectorID, assignmentID, runID uuid.UUID, requestID *uuid.UUID, committed *bool) (UploadResult, error) {
	result, err := s.attachArtifact(ctx, tx, q, target, artifactID, connectorID, assignmentID, runID, requestID)
	if err != nil {
		return UploadResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return UploadResult{}, err
	}
	*committed = true
	result.Disposition = "deduplicated"
	result.Artifact, err = s.load(ctx, db.New(s.pool), artifactID)
	return result, err
}

func (s *Service) attachArtifact(ctx context.Context, tx pgx.Tx, q *db.Queries, target db.GetConnectorArtifactUploadTargetRow, artifactID, connectorID, assignmentID, runID uuid.UUID, requestID *uuid.UUID) (UploadResult, error) {
	if target.ArtifactID != nil && *target.ArtifactID != artifactID {
		return UploadResult{}, conflict("artifact_mismatch", "Run already references a different artifact")
	}
	if _, err := q.AttachArtifactToRun(ctx, db.AttachArtifactToRunParams{ArtifactID: &artifactID, RunID: runID}); err != nil {
		return UploadResult{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{ActorType: "system", Action: "machine_run.artifact_attached", ResourceType: "machine_run", ResourceID: &runID, RequestID: requestID, Source: "system", ChangedFields: []string{"artifactId"}, Metadata: map[string]any{"connectorId": connectorID.String(), "assignmentId": assignmentID.String(), "runId": runID.String(), "artifactId": artifactID.String()}}); err != nil {
		return UploadResult{}, err
	}
	result := UploadResult{RunID: runID}
	if target.JobID != nil {
		return result, nil
	}
	jobs, err := q.FindPlannedJobsForArtifact(ctx, db.FindPlannedJobsForArtifactParams{MachineID: target.MachineID, ArtifactID: &artifactID})
	if err != nil {
		return UploadResult{}, err
	}
	if len(jobs) == 1 {
		attached, attachErr := s.logbook.AttachPlannedRunSystem(ctx, tx, connectorID, assignmentID, runID, jobs[0], artifactID, requestID)
		if attachErr != nil {
			return UploadResult{}, attachErr
		}
		if attached {
			result.AutoAttachedJobID = &jobs[0]
		}
	}
	return result, nil
}

func (s *Service) CreatePlannedJob(ctx context.Context, principal authorization.Principal, artifactID uuid.UUID, input PlannedJobInput, requestID *uuid.UUID) (machinelogbook.MachineJob, error) {
	if !principal.Has(authorization.PrintArtifactsRead) || !principal.Has(authorization.MachineJobsCreate) {
		return machinelogbook.MachineJob{}, apperror.PermissionDenied
	}
	title, err := cleanOptional(input.Title, 200)
	if err != nil {
		return machinelogbook.MachineJob{}, err
	}
	notes, err := cleanOptional(input.Notes, 2000)
	if err != nil {
		return machinelogbook.MachineJob{}, err
	}
	if input.OperatorPersonID == uuid.Nil || input.MachineID == uuid.Nil {
		return machinelogbook.MachineJob{}, validation("validation_failed", "Machine and operator are required")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return machinelogbook.MachineJob{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if _, err = q.GetArtifactByID(ctx, artifactID); errors.Is(err, pgx.ErrNoRows) {
		return machinelogbook.MachineJob{}, apperror.NotFound
	} else if err != nil {
		return machinelogbook.MachineJob{}, err
	}
	machine, err := q.GetMachineForArtifactJob(ctx, input.MachineID)
	if errors.Is(err, pgx.ErrNoRows) {
		return machinelogbook.MachineJob{}, apperror.NotFound
	}
	if err != nil {
		return machinelogbook.MachineJob{}, err
	}
	if machine.Status == "retired" || !machine.ProfileEnabled {
		return machinelogbook.MachineJob{}, conflict("printer_profile_disabled", "An enabled printer profile is required")
	}
	if ok, checkErr := q.OperatorExists(ctx, input.OperatorPersonID); checkErr != nil {
		return machinelogbook.MachineJob{}, checkErr
	} else if !ok {
		return machinelogbook.MachineJob{}, validation("validation_failed", "Operator must have an enabled account")
	}
	var personID, organizationID *uuid.UUID
	switch input.Customer.Kind {
	case "person":
		if ok, checkErr := q.BillingPersonExists(ctx, input.Customer.ID); checkErr != nil {
			return machinelogbook.MachineJob{}, checkErr
		} else if !ok {
			return machinelogbook.MachineJob{}, apperror.NotFound
		}
		personID = &input.Customer.ID
	case "organization":
		if ok, checkErr := q.ActiveOrganizationExists(ctx, input.Customer.ID); checkErr != nil {
			return machinelogbook.MachineJob{}, checkErr
		} else if !ok {
			return machinelogbook.MachineJob{}, apperror.NotFound
		}
		organizationID = &input.Customer.ID
	default:
		return machinelogbook.MachineJob{}, validation("validation_failed", "Customer must be a person or organization")
	}
	groupID, groupName, _, err := machinelogbook.ResolvePricingGroup(ctx, tx, personID, organizationID, input.PricingGroupID)
	if err != nil {
		return machinelogbook.MachineJob{}, err
	}
	sequence, err := q.NextMachineJobSequence(ctx)
	if err != nil {
		return machinelogbook.MachineJob{}, err
	}
	jobID := uuid.Must(uuid.NewV7())
	displayID := fmt.Sprintf("J-%04d-%06d", time.Now().UTC().Year(), sequence)
	job, err := q.CreatePlannedMachineJob(ctx, db.CreatePlannedMachineJobParams{ID: jobID, DisplayID: displayID, MachineID: input.MachineID, CustomerPersonID: personID, CustomerOrganizationID: organizationID, OperatorPersonID: &input.OperatorPersonID, Title: title, Notes: notes, ArtifactID: &artifactID})
	if err != nil {
		return machinelogbook.MachineJob{}, err
	}
	revision, err := q.NextPricingSnapshotRevision(ctx, jobID)
	if err != nil {
		return machinelogbook.MachineJob{}, err
	}
	snapshotID := uuid.Must(uuid.NewV7())
	if _, err = q.CreatePricingSnapshot(ctx, db.CreatePricingSnapshotParams{ID: snapshotID, MachineJobID: jobID, Revision: revision, PricingGroupID: &groupID, PricingGroupName: groupName, CapturedByAccountID: &principal.AccountID}); err != nil {
		return machinelogbook.MachineJob{}, err
	}
	if err = q.InsertPricingSnapshotRules(ctx, db.InsertPricingSnapshotRulesParams{SnapshotID: snapshotID, PricingGroupID: groupID}); err != nil {
		return machinelogbook.MachineJob{}, err
	}
	if _, err = q.ActivatePricingSnapshot(ctx, db.ActivatePricingSnapshotParams{SnapshotID: &snapshotID, ID: job.ID}); err != nil {
		return machinelogbook.MachineJob{}, err
	}
	if err = audit.Write(ctx, tx, audit.Event{ActorAccountID: &principal.AccountID, Action: "machine_job.created_from_artifact", ResourceType: "machine_job", ResourceID: &jobID, RequestID: requestID, ChangedFields: []string{"machineId", "customer", "operatorPersonId", "artifactId", "pricingSnapshot"}, Metadata: map[string]any{"jobId": jobID.String(), "artifactId": artifactID.String()}}); err != nil {
		return machinelogbook.MachineJob{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return machinelogbook.MachineJob{}, err
	}
	return s.logbook.GetJob(ctx, principal, jobID)
}

func cleanOptional(value *string, max int) (*string, error) {
	if value == nil {
		return nil, nil
	}
	clean := strings.TrimSpace(*value)
	if clean == "" || len(clean) > max {
		return nil, validation("validation_failed", "Text field is empty or too long")
	}
	return &clean, nil
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
func numericString(value pgtype.Numeric) *string {
	if !value.Valid {
		return nil
	}
	v := decimal.NewFromBigInt(value.Int, value.Exp).String()
	return &v
}
func floatNumeric(value *float64) pgtype.Numeric {
	if value == nil {
		return pgtype.Numeric{}
	}
	v := decimal.NewFromFloat(*value).Round(6)
	return pgtype.Numeric{Int: v.Coefficient(), Exp: v.Exponent(), Valid: true}
}
