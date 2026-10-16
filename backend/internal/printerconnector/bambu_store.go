package printerconnector

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	maxArtifactTransfers = 100
	maxArtifactBytes     = int64(2 << 30)
	maxStagedArtifact    = int64(512 << 20)
)

func (s *Store) BambuState(ctx context.Context, assignmentID uuid.UUID) (bambuPersistedState, bool, error) {
	return s.BambuStateFor(ctx, assignmentID, bambuH2DAdapterKind)
}

func (s *Store) BambuStateFor(ctx context.Context, assignmentID uuid.UUID, adapterKind string) (bambuPersistedState, bool, error) {
	if !isBambuAdapterKind(adapterKind) {
		return bambuPersistedState{}, false, errors.New("unsupported Bambu adapter kind")
	}
	var encrypted []byte
	err := s.db.QueryRowContext(ctx, `SELECT encrypted_value FROM adapter_state WHERE assignment_id=? AND adapter_kind=?`, assignmentID.String(), adapterKind).Scan(&encrypted)
	if errors.Is(err, sql.ErrNoRows) {
		return bambuPersistedState{}, false, nil
	}
	if err != nil {
		return bambuPersistedState{}, false, err
	}
	plain, err := s.open(encrypted)
	if err != nil {
		return bambuPersistedState{}, false, err
	}
	var state bambuPersistedState
	if err = json.Unmarshal(plain, &state); err != nil {
		return bambuPersistedState{}, false, err
	}
	return state, true, nil
}

func (s *Store) SaveBambuState(ctx context.Context, assignmentID uuid.UUID, state bambuPersistedState) error {
	return s.SaveBambuStateFor(ctx, assignmentID, bambuH2DAdapterKind, state)
}

func (s *Store) SaveBambuStateFor(ctx context.Context, assignmentID uuid.UUID, adapterKind string, state bambuPersistedState) error {
	if !isBambuAdapterKind(adapterKind) {
		return errors.New("unsupported Bambu adapter kind")
	}
	plain, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if len(plain) > maximumReducerBytes*2 {
		return errors.New("encrypted Bambu state exceeds storage limit")
	}
	encrypted, err := s.seal(plain)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO adapter_state(assignment_id,adapter_kind,encrypted_value,updated_at) VALUES(?,?,?,?) ON CONFLICT(assignment_id) DO UPDATE SET adapter_kind=excluded.adapter_kind,encrypted_value=excluded.encrypted_value,updated_at=excluded.updated_at`, assignmentID.String(), adapterKind, encrypted, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

// EnqueueBambuState makes normalized lifecycle facts and the reducer/session
// checkpoint durable in one SQLite transaction. This prevents a restart from
// allocating a second run ID after an event was already queued.
func (s *Store) EnqueueBambuState(ctx context.Context, assignmentID uuid.UUID, configurationVersion int64, observations []Observation, state bambuPersistedState) error {
	return s.EnqueueBambuStateFor(ctx, assignmentID, bambuH2DAdapterKind, configurationVersion, observations, state)
}

func (s *Store) EnqueueBambuStateFor(ctx context.Context, assignmentID uuid.UUID, adapterKind string, configurationVersion int64, observations []Observation, state bambuPersistedState) error {
	if !isBambuAdapterKind(adapterKind) {
		return errors.New("unsupported Bambu adapter kind")
	}
	plain, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if len(plain) > maximumReducerBytes*2 {
		return errors.New("encrypted Bambu state exceeds storage limit")
	}
	encrypted, err := s.seal(plain)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var queued int64
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM outbox`).Scan(&queued); err != nil {
		return err
	}
	if queued+int64(len(observations)) > maxOutboxEvents {
		return errors.New("connector event queue is full; printer polling is paused until delivery resumes")
	}
	sequence := int64(1)
	if len(observations) > 0 {
		err = tx.QueryRowContext(ctx, `SELECT next_sequence FROM assignment_sequences WHERE assignment_id=?`, assignmentID.String()).Scan(&sequence)
		if errors.Is(err, sql.ErrNoRows) {
			_, err = tx.ExecContext(ctx, `INSERT INTO assignment_sequences(assignment_id,next_sequence) VALUES(?,?)`, assignmentID.String(), sequence+int64(len(observations)))
		} else if err == nil {
			_, err = tx.ExecContext(ctx, `UPDATE assignment_sequences SET next_sequence=? WHERE assignment_id=?`, sequence+int64(len(observations)), assignmentID.String())
		}
		if err != nil {
			return err
		}
	}
	now := time.Now().UTC()
	for index, observation := range observations {
		var runValue any
		if observation.RunID != nil {
			runValue = observation.RunID.String()
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO outbox(event_id,assignment_id,configuration_version,sequence,occurred_at,kind,run_id,history_complete,external_print_id,report_revision,payload,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, uuid.Must(uuid.NewV7()).String(), assignmentID.String(), configurationVersion, sequence+int64(index), now.Format(time.RFC3339Nano), observation.Kind, runValue, observation.HistoryComplete, observation.ExternalPrintID, observation.ReportRevision, []byte(observation.Payload), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
		if err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO adapter_state(assignment_id,adapter_kind,encrypted_value,updated_at) VALUES(?,?,?,?) ON CONFLICT(assignment_id) DO UPDATE SET adapter_kind=excluded.adapter_kind,encrypted_value=excluded.encrypted_value,updated_at=excluded.updated_at`, assignmentID.String(), adapterKind, encrypted, now.Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	return tx.Commit()
}

type ArtifactTransfer struct {
	ID                   uuid.UUID
	AssignmentID         uuid.UUID
	RunID                uuid.UUID
	ConfigurationVersion int64
	RemotePath           string
	FileName             string
	StagedPath           string
	SizeBytes            int64
	SHA256               string
	AttemptCount         int
	ExpiresAt            time.Time
}

// StageArtifact validates and durably queues a retrieved 3MF. It never removes
// an already queued file; only CompleteArtifactTransfer does that after Core
// acknowledges creation or deduplication.
func (s *Store) StageArtifact(ctx context.Context, assignmentID, runID uuid.UUID, configurationVersion int64, remotePath, fileName string, source io.Reader, expiresAt time.Time) (ArtifactTransfer, error) {
	if assignmentID == uuid.Nil || runID == uuid.Nil || configurationVersion < 1 || source == nil {
		return ArtifactTransfer{}, errors.New("invalid artifact transfer")
	}
	fileName = filepath.Base(strings.TrimSpace(fileName))
	if fileName == "." || fileName == "" || len(fileName) > 255 {
		return ArtifactTransfer{}, errors.New("invalid artifact file name")
	}
	if expiresAt.IsZero() {
		expiresAt = time.Now().UTC().Add(24 * time.Hour)
	}
	var count, bytes int64
	if err := s.db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM artifact_transfers)+(SELECT count(*) FROM artifact_retrievals WHERE state='pending'),coalesce(sum(size_bytes),0) FROM artifact_transfers`).Scan(&count, &bytes); err != nil {
		return ArtifactTransfer{}, err
	}
	if count >= maxArtifactTransfers || bytes >= maxArtifactBytes {
		return ArtifactTransfer{}, errors.New("artifact transfer queue is full")
	}
	directory := filepath.Join(s.dataDir, "artifacts")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return ArtifactTransfer{}, err
	}
	id := uuid.Must(uuid.NewV7())
	path := filepath.Join(directory, id.String()+".3mf")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return ArtifactTransfer{}, err
	}
	keep := false
	defer func() {
		_ = file.Close()
		if !keep {
			_ = os.Remove(path)
		}
	}()
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(source, maxStagedArtifact+1))
	if err != nil {
		return ArtifactTransfer{}, err
	}
	if size == 0 || size > maxStagedArtifact {
		return ArtifactTransfer{}, errors.New("artifact exceeds 512 MiB compressed limit")
	}
	if bytes+size > maxArtifactBytes {
		return ArtifactTransfer{}, errors.New("artifact transfer queue exceeds 2 GiB")
	}
	if err = file.Sync(); err != nil {
		return ArtifactTransfer{}, err
	}
	if err = file.Close(); err != nil {
		return ArtifactTransfer{}, err
	}
	if err = validateStagedZIP(path, size); err != nil {
		return ArtifactTransfer{}, err
	}
	transfer := ArtifactTransfer{ID: id, AssignmentID: assignmentID, RunID: runID, ConfigurationVersion: configurationVersion, RemotePath: remotePath, FileName: fileName, StagedPath: path, SizeBytes: size, SHA256: hex.EncodeToString(hash.Sum(nil)), ExpiresAt: expiresAt.UTC()}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = s.db.ExecContext(ctx, `INSERT INTO artifact_transfers(id,assignment_id,run_id,configuration_version,remote_path,file_name,staged_path,size_bytes,sha256,next_attempt_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id.String(), assignmentID.String(), runID.String(), configurationVersion, remotePath, fileName, path, size, transfer.SHA256, now, transfer.ExpiresAt.Format(time.RFC3339Nano), now)
	if err != nil {
		return ArtifactTransfer{}, err
	}
	keep = true
	return transfer, nil
}

func validateStagedZIP(path string, size int64) error {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return fmt.Errorf("validate staged 3MF: %w", err)
	}
	defer reader.Close()
	if len(reader.File) == 0 || len(reader.File) > 4096 {
		return errors.New("staged 3MF has an invalid entry count")
	}
	var expanded uint64
	for _, entry := range reader.File {
		name := strings.ReplaceAll(entry.Name, `\`, "/")
		if strings.HasPrefix(name, "/") || strings.Contains("/"+name+"/", "/../") || entry.FileInfo().Mode()&os.ModeSymlink != 0 {
			return errors.New("staged 3MF contains an unsafe path or link")
		}
		if entry.Flags&0x1 != 0 || entry.UncompressedSize64 > 1<<30 {
			return errors.New("staged 3MF contains an encrypted or oversized entry")
		}
		expanded += entry.UncompressedSize64
		if expanded > 2<<30 {
			return errors.New("staged 3MF expanded size exceeds 2 GiB")
		}
		stream, openErr := entry.Open()
		if openErr != nil {
			return openErr
		}
		_, copyErr := io.Copy(io.Discard, io.LimitReader(stream, int64(entry.UncompressedSize64)+1))
		closeErr := stream.Close()
		if copyErr != nil {
			return fmt.Errorf("verify staged 3MF CRC: %w", copyErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close staged 3MF entry: %w", closeErr)
		}
	}
	_ = size
	return nil
}

func (s *Store) PendingArtifactTransfers(ctx context.Context, limit int) ([]ArtifactTransfer, error) {
	if limit < 1 || limit > maxArtifactTransfers {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,assignment_id,run_id,configuration_version,remote_path,file_name,staged_path,size_bytes,sha256,attempt_count,expires_at FROM artifact_transfers
		WHERE state='pending' AND next_attempt_at<=? AND expires_at>? AND NOT EXISTS (SELECT 1 FROM artifact_upload_receipts r WHERE r.transfer_id=artifact_transfers.id)
		ORDER BY created_at LIMIT ?`, time.Now().UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []ArtifactTransfer
	for rows.Next() {
		var item ArtifactTransfer
		var id, assignmentID, runID, expires string
		if err = rows.Scan(&id, &assignmentID, &runID, &item.ConfigurationVersion, &item.RemotePath, &item.FileName, &item.StagedPath, &item.SizeBytes, &item.SHA256, &item.AttemptCount, &expires); err != nil {
			return nil, err
		}
		if item.ID, err = uuid.Parse(id); err != nil {
			return nil, err
		}
		if item.AssignmentID, err = uuid.Parse(assignmentID); err != nil {
			return nil, err
		}
		if item.RunID, err = uuid.Parse(runID); err != nil {
			return nil, err
		}
		if item.ExpiresAt, err = time.Parse(time.RFC3339Nano, expires); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Store) MarkArtifactTransferFailure(ctx context.Context, id uuid.UUID, reason string) error {
	if len(reason) > 80 {
		reason = reason[:80]
	}
	var attempt int
	if err := s.db.QueryRowContext(ctx, `SELECT attempt_count FROM artifact_transfers WHERE id=? AND state='pending'`, id.String()).Scan(&attempt); err != nil {
		return err
	}
	delay := 5 * time.Second * time.Duration(1<<min(attempt, 6))
	if delay > 5*time.Minute {
		delay = 5 * time.Minute
	}
	_, err := s.db.ExecContext(ctx, `UPDATE artifact_transfers SET attempt_count=attempt_count+1,next_attempt_at=?,reason_code=? WHERE id=? AND state='pending'`, time.Now().UTC().Add(delay).Format(time.RFC3339Nano), reason, id.String())
	return err
}

func (s *Store) QuarantineExpiredArtifactTransfers(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `UPDATE artifact_transfers SET state='quarantined',reason_code='artifact_retry_expired' WHERE state='pending' AND expires_at<=? AND NOT EXISTS (SELECT 1 FROM artifact_upload_receipts r WHERE r.transfer_id=artifact_transfers.id)`, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *Store) CompleteArtifactTransfer(ctx context.Context, id uuid.UUID) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var path, assignmentID, runID, hash string
	if err = tx.QueryRowContext(ctx, `SELECT staged_path,assignment_id,run_id,sha256 FROM artifact_transfers WHERE id=?`, id.String()).Scan(&path, &assignmentID, &runID, &hash); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err = tx.ExecContext(ctx, `INSERT INTO artifact_upload_receipts(transfer_id,acknowledged_at) VALUES(?,?) ON CONFLICT(transfer_id) DO NOTHING`, id.String(), now); err != nil {
		return err
	}
	var bambuStateExists int
	bambuErr := tx.QueryRowContext(ctx, `SELECT 1 FROM adapter_state WHERE assignment_id=? AND adapter_kind IN ('bambu_h2d','bambu_x1c')`, assignmentID).Scan(&bambuStateExists)
	if bambuErr != nil && !errors.Is(bambuErr, sql.ErrNoRows) {
		return bambuErr
	}
	var reportExists int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM artifact_consumption_reports WHERE assignment_id=? AND run_id=? AND artifact_sha256=?`, assignmentID, runID, hash).Scan(&reportExists)
	if errors.Is(err, sql.ErrNoRows) && bambuErr == nil {
		return tx.Commit()
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM artifact_transfers WHERE id=?`, id.String()); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func isBambuAdapterKind(kind string) bool {
	return kind == bambuH2DAdapterKind || kind == bambuX1CAdapterKind
}
