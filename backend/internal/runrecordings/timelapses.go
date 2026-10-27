package runrecordings

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"path"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// UploadTimelapse streams a connector's timelapse video into private storage and
// links it to the run. The body is verified against the declared length and
// SHA-256 while it is written; the database transaction opens only after the
// blob is stored. A run keeps its first timelapse: the same bytes again are
// deduplicated, different bytes refused.
func (s *Service) UploadTimelapse(
	ctx context.Context,
	connector printerconnectors.Context,
	upload TimelapseUpload,
	body io.Reader,
	requestID *uuid.UUID,
) (TimelapseUploadResult, error) {
	if connector.Lifecycle != printerconnectors.LifecycleActive {
		return TimelapseUploadResult{}, apperror.New(http.StatusForbidden, "printer_connector_inactive", "Connector is not active")
	}
	name := path.Base(strings.ReplaceAll(strings.TrimSpace(upload.FileName), `\`, "/"))
	digest, err := hex.DecodeString(strings.ToLower(strings.TrimSpace(upload.SHA256)))
	if err != nil || len(digest) != 32 || name == "." || name == "/" || len(name) > 255 ||
		!strings.HasSuffix(strings.ToLower(name), ".mp4") || upload.ContentLength < 1 {
		return TimelapseUploadResult{}, invalid("timelapse_metadata_invalid", "Timelapse file name, length or SHA-256 is invalid")
	}
	if upload.ContentLength > s.timelapseMaxBytes {
		return TimelapseUploadResult{}, apperror.New(
			http.StatusRequestEntityTooLarge,
			"timelapse_too_large",
			"Timelapse video exceeds the configured limit",
		)
	}
	q := db.New(s.pool)
	settings, err := q.GetRecordingSettings(ctx)
	if err != nil {
		return TimelapseUploadResult{}, err
	}
	if !settings.TimelapseEnabled {
		return TimelapseUploadResult{}, apperror.Conflicting("timelapse_disabled", "Timelapse collection is disabled")
	}
	target, err := q.GetConnectorRunTarget(ctx, db.GetConnectorRunTargetParams{
		RunID:        upload.RunID,
		AssignmentID: upload.AssignmentID,
		ConnectorID:  connector.ID,
	})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !target.AssignmentActive) {
		return TimelapseUploadResult{}, apperror.NotFound
	}
	if err != nil {
		return TimelapseUploadResult{}, err
	}
	if result, done, existingErr := existingTimelapse(ctx, q, upload, digest); done || existingErr != nil {
		return result, existingErr
	}
	// An MP4 file starts with an ftyp box; refuse anything else before storing it.
	buffered := bufio.NewReaderSize(io.LimitReader(body, upload.ContentLength+1), 64<<10)
	head, err := buffered.Peek(12)
	if err != nil || !bytes.Equal(head[4:8], []byte("ftyp")) {
		return TimelapseUploadResult{}, invalid("timelapse_not_mp4", "Timelapse video is not an MP4 file")
	}
	var expected storage.Metadata
	expected.Size = upload.ContentLength
	copy(expected.SHA256[:], digest)
	blob, err := s.files.PutSystemBlob(ctx, name, TimelapseContentType, buffered, expected)
	if err != nil {
		return TimelapseUploadResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			blob.Discard()
		}
	}()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return TimelapseUploadResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tq := db.New(tx)
	if _, err = tq.GetConnectorRunTargetForUpdate(ctx, db.GetConnectorRunTargetForUpdateParams{
		RunID:        upload.RunID,
		AssignmentID: upload.AssignmentID,
		ConnectorID:  connector.ID,
	}); errors.Is(err, pgx.ErrNoRows) {
		return TimelapseUploadResult{}, apperror.NotFound
	} else if err != nil {
		return TimelapseUploadResult{}, err
	}
	if result, done, existingErr := existingTimelapse(ctx, tq, upload, digest); done || existingErr != nil {
		return result, existingErr
	}
	file, err := blob.Commit(ctx, tx, requestID)
	if err != nil {
		return TimelapseUploadResult{}, err
	}
	if _, err = tq.InsertRunTimelapse(ctx, db.InsertRunTimelapseParams{
		RunID:     upload.RunID,
		FileID:    file.ID,
		SizeBytes: upload.ContentLength,
		Sha256:    digest,
	}); err != nil {
		return TimelapseUploadResult{}, err
	}
	uploaded := "uploaded"
	if err = tq.UpsertRunTimelapseReport(ctx, db.UpsertRunTimelapseReportParams{
		RunID:      upload.RunID,
		State:      &uploaded,
		ObservedAt: timestamptz(s.now()),
	}); err != nil {
		return TimelapseUploadResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return TimelapseUploadResult{}, err
	}
	committed = true
	return TimelapseUploadResult{RunID: upload.RunID, Created: true, SizeBytes: upload.ContentLength}, nil
}

// existingTimelapse answers an upload for a run that already has a timelapse.
func existingTimelapse(
	ctx context.Context,
	q *db.Queries,
	upload TimelapseUpload,
	digest []byte,
) (TimelapseUploadResult, bool, error) {
	existing, err := q.GetRunTimelapse(ctx, upload.RunID)
	if errors.Is(err, pgx.ErrNoRows) {
		return TimelapseUploadResult{}, false, nil
	}
	if err != nil {
		return TimelapseUploadResult{}, true, err
	}
	if bytes.Equal(existing.Sha256, digest) {
		return TimelapseUploadResult{RunID: upload.RunID, SizeBytes: existing.SizeBytes}, true, nil
	}
	return TimelapseUploadResult{}, true, apperror.Conflicting("run_timelapse_exists", "The run already has another timelapse")
}
