package printartifacts

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RunUploadResult is what staff learn from uploading a 3MF to a recorded run.
type RunUploadResult struct {
	RunID    uuid.UUID
	Artifact Artifact
	// Replaced is true when a manually uploaded file of the run was replaced.
	Replaced bool
	// NameMismatch is true when neither the file name nor the project name matches the run's print name.
	NameMismatch           bool
	PrintName, ProjectName *string
	ConsumptionRecompute   runrecordings.RecomputeOutcome
}

// UploadForRun stores a 3MF that staff upload for a recorded run (typically one printed from the printer's
// internal storage, which the connector cannot read), links it to the run and, when the run has ended, asks
// its connector to calculate the consumption from it. Needs machine_jobs.edit. A file the connector retrieved
// is never overwritten; a manually uploaded one can be replaced. The upload succeeds even when the names do
// not match; the result says so.
func (s *Service) UploadForRun(
	ctx context.Context,
	principal authorization.Principal,
	runID uuid.UUID,
	filename string,
	body io.Reader,
	requestID *uuid.UUID,
) (RunUploadResult, error) {
	if !principal.Has(authorization.MachineJobsEdit) {
		return RunUploadResult{}, apperror.PermissionDenied
	}
	filename = strings.TrimSpace(filename)
	if filename == "" || len(filename) > 255 {
		return RunUploadResult{}, validation("artifact_metadata_invalid", "The file name is missing or too long")
	}
	// Refuse before spooling up to 512 MiB; the transaction below checks again under the run's lock.
	if _, err := checkManualUploadTarget(ctx, db.New(s.pool), runID); err != nil {
		return RunUploadResult{}, err
	}
	temp, err := os.CreateTemp("", "makerspace-artifact-*.3mf")
	if err != nil {
		return RunUploadResult{}, err
	}
	path := temp.Name()
	defer func() { _ = os.Remove(path) }()
	defer func() { _ = temp.Close() }()
	if err = temp.Chmod(0o600); err != nil {
		return RunUploadResult{}, err
	}
	hasher := sha256.New()
	size, err := io.Copy(io.MultiWriter(temp, hasher), io.LimitReader(body, MaxCompressedSize+1))
	if err != nil {
		return RunUploadResult{}, apperror.Invalid("the file could not be read")
	}
	if size > MaxCompressedSize {
		return RunUploadResult{}, apperror.New(
			http.StatusRequestEntityTooLarge,
			"artifact_too_large",
			"Print files are limited to 512 MiB",
		)
	}
	if size < 1 {
		return RunUploadResult{}, validation("artifact_metadata_invalid", "The file is empty")
	}
	digest := hasher.Sum(nil)
	parsed, metadata, err := parseArtifactFile(temp, size)
	if err != nil {
		return RunUploadResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return RunUploadResult{}, err
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
	run, err := checkManualUploadTarget(ctx, q, runID)
	if err != nil {
		return RunUploadResult{}, err
	}
	var artifactID uuid.UUID
	if existing, getErr := q.GetArtifactBySHA256(ctx, digest); getErr == nil {
		artifactID = existing.ID
	} else if !errors.Is(getErr, pgx.ErrNoRows) {
		return RunUploadResult{}, getErr
	} else {
		var created bool
		artifactID, created, err = s.createArtifact(
			ctx, tx, q, filename, size, digest, temp, parsed, metadata, requestID, &cleanups,
		)
		if err != nil {
			return RunUploadResult{}, err
		}
		if !created {
			return RunUploadResult{}, apperror.Conflicting(
				"artifact_deduplication_race",
				"Artifact upload conflicted and can be retried",
			)
		}
		if err = audit.Write(ctx, tx, audit.Event{
			ActorAccountID: &principal.AccountID,
			Action:         "print_artifact.created",
			ResourceType:   "print_artifact",
			ResourceID:     &artifactID,
			RequestID:      requestID,
			ChangedFields:  []string{"file", "metadata", "previews", "filaments"},
			Metadata:       map[string]any{"runId": runID.String(), "artifactId": artifactID.String()},
		}); err != nil {
			return RunUploadResult{}, err
		}
	}
	replaced := run.ArtifactID != nil && *run.ArtifactID != artifactID
	if err = q.SetManualRunArtifact(ctx, db.SetManualRunArtifactParams{ArtifactID: &artifactID, RunID: runID}); err != nil {
		return RunUploadResult{}, err
	}
	var projectName *string
	if parsed.Metadata.JobName != "" {
		projectName = &parsed.Metadata.JobName
	}
	mismatch := NameMismatch(run.FileName, filename, parsed.Metadata.JobName)
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &principal.AccountID,
		Action:         "machine_run.artifact_uploaded",
		ResourceType:   "machine_run",
		ResourceID:     &runID,
		RequestID:      requestID,
		ChangedFields:  []string{"artifactId"},
		Metadata:       map[string]any{"runId": runID.String(), "artifactId": artifactID.String()},
	}); err != nil {
		return RunUploadResult{}, err
	}
	outcome, err := s.recordings.RequestRecomputeAfterArtifact(ctx, tx, principal.AccountID, runID, requestID)
	if err != nil {
		return RunUploadResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RunUploadResult{}, err
	}
	committed = true
	artifact, err := s.load(ctx, db.New(s.pool), artifactID)
	if err != nil {
		return RunUploadResult{}, err
	}
	return RunUploadResult{
		RunID:                runID,
		Artifact:             artifact,
		Replaced:             replaced,
		NameMismatch:         mismatch,
		PrintName:            run.FileName,
		ProjectName:          projectName,
		ConsumptionRecompute: outcome,
	}, nil
}

// checkManualUploadTarget locks the run and applies the rules for attaching a manually uploaded 3MF.
func checkManualUploadTarget(ctx context.Context, q *db.Queries, runID uuid.UUID) (db.GetRunForManualArtifactUploadRow, error) {
	run, err := q.GetRunForManualArtifactUpload(ctx, runID)
	if errors.Is(err, pgx.ErrNoRows) {
		return run, apperror.NotFound
	}
	if err != nil {
		return run, err
	}
	switch {
	case run.Source != "recorded":
		return run, apperror.Conflicting("run_not_recorded", "Only runs recorded by a printer connector have a print file")
	case run.State != nil && *run.State == "replaced":
		return run, apperror.Conflicting("run_replaced", "A replaced run cannot be changed")
	case run.ArtifactID != nil && !run.ArtifactManual:
		return run, apperror.Conflicting(
			"run_artifact_connector_retrieved",
			"The connector already retrieved this run's print file; it is never replaced by an upload",
		)
	}
	return run, nil
}
