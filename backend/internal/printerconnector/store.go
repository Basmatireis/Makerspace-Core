package printerconnector

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
	_ "modernc.org/sqlite"
)

type Identity struct {
	ConnectorID         uuid.UUID `json:"connectorId"`
	CredentialID        uuid.UUID `json:"credentialId"`
	CredentialSecret    string    `json:"credentialSecret"`
	CredentialExpiresAt time.Time `json:"credentialExpiresAt"`
	Enrolled            bool      `json:"enrolled"`
}

type QueuedEvent struct {
	EventID              uuid.UUID       `json:"eventId"`
	AssignmentID         uuid.UUID       `json:"assignmentId"`
	RunID                *uuid.UUID      `json:"runId"`
	HistoryComplete      bool            `json:"historyComplete"`
	ConfigurationVersion int64           `json:"configurationVersion"`
	Sequence             int64           `json:"sequence"`
	OccurredAt           time.Time       `json:"occurredAt"`
	Kind                 string          `json:"kind"`
	ExternalPrintID      *string         `json:"externalPrintId"`
	ReportRevision       *int64          `json:"reportRevision"`
	Payload              json.RawMessage `json:"payload"`
}

type Store struct {
	db       *sql.DB
	aead     cipher.AEAD
	lockFile *os.File
}

const maxOutboxEvents = 100000

func OpenStore(dataDir string) (*Store, error) {
	if dataDir == "" {
		return nil, errors.New("data directory is required")
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	if err := os.Chmod(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("protect data directory: %w", err)
	}
	lockFile, err := os.OpenFile(filepath.Join(dataDir, "connector.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open process lock: %w", err)
	}
	if err = unix.Flock(int(lockFile.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = lockFile.Close()
		return nil, errors.New("connector data directory is already in use")
	}
	aead, err := loadLocalAEAD(filepath.Join(dataDir, "local.key"))
	if err != nil {
		_ = lockFile.Close()
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(dataDir, "connector.db"))
	if err != nil {
		_ = lockFile.Close()
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db, aead: aead, lockFile: lockFile}
	if err = store.migrate(context.Background()); err != nil {
		_ = store.Close()
		return nil, err
	}
	return store, nil
}

func loadLocalAEAD(path string) (cipher.AEAD, error) {
	key, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		if err = os.WriteFile(path, key, 0o600); err != nil {
			return nil, fmt.Errorf("write local encryption key: %w", err)
		}
	} else if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, errors.New("local encryption key must contain exactly 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (s *Store) migrate(ctx context.Context) error {
	for _, statement := range []string{
		"PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL", "PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=5000",
		`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT`,
		`CREATE TABLE IF NOT EXISTS assignment_sequences (assignment_id TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL CHECK(next_sequence > 0)) STRICT`,
		`CREATE TABLE IF NOT EXISTS outbox (
			event_id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL, configuration_version INTEGER NOT NULL CHECK(configuration_version > 0),
			sequence INTEGER NOT NULL CHECK(sequence > 0), occurred_at TEXT NOT NULL, kind TEXT NOT NULL,
			run_id TEXT, history_complete INTEGER NOT NULL DEFAULT 1 CHECK(history_complete IN (0,1)),
			external_print_id TEXT, report_revision INTEGER, payload BLOB NOT NULL,
			state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','quarantined')),
			attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, reason_code TEXT,
			created_at TEXT NOT NULL, UNIQUE(assignment_id, sequence)) STRICT`,
		`CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(state, next_attempt_at, created_at)`,
	} {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize connector state: %w", err)
		}
	}
	return nil
}

func (s *Store) Close() error {
	var dbErr error
	if s.db != nil {
		_, _ = s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
		dbErr = s.db.Close()
	}
	if s.lockFile != nil {
		_ = unix.Flock(int(s.lockFile.Fd()), unix.LOCK_UN)
		_ = s.lockFile.Close()
	}
	return dbErr
}

func (s *Store) seal(value []byte) ([]byte, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return s.aead.Seal(nonce, nonce, value, []byte("printer-connector-local-state-v1")), nil
}

func (s *Store) open(value []byte) ([]byte, error) {
	if len(value) < s.aead.NonceSize() {
		return nil, errors.New("encrypted local state is truncated")
	}
	nonce := value[:s.aead.NonceSize()]
	return s.aead.Open(nil, nonce, value[s.aead.NonceSize():], []byte("printer-connector-local-state-v1"))
}

func (s *Store) SaveIdentity(ctx context.Context, value Identity) error {
	plain, err := json.Marshal(value)
	if err != nil {
		return err
	}
	encrypted, err := s.seal(plain)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO metadata(key,value) VALUES('identity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, encrypted)
	return err
}

func (s *Store) Identity(ctx context.Context) (*Identity, error) {
	var encrypted []byte
	err := s.db.QueryRowContext(ctx, `SELECT value FROM metadata WHERE key='identity'`).Scan(&encrypted)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	plain, err := s.open(encrypted)
	if err != nil {
		return nil, err
	}
	var value Identity
	if err = json.Unmarshal(plain, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func (s *Store) SaveConfiguration(ctx context.Context, value Configuration) error {
	plain, err := json.Marshal(value)
	if err != nil {
		return err
	}
	encrypted, err := s.seal(plain)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO metadata(key,value) VALUES('configuration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, encrypted)
	return err
}

func (s *Store) Configuration(ctx context.Context) (*Configuration, error) {
	var encrypted []byte
	err := s.db.QueryRowContext(ctx, `SELECT value FROM metadata WHERE key='configuration'`).Scan(&encrypted)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	plain, err := s.open(encrypted)
	if err != nil {
		return nil, err
	}
	var value Configuration
	if err = json.Unmarshal(plain, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

func (s *Store) Enqueue(ctx context.Context, assignmentID uuid.UUID, configurationVersion int64, kind string, payload json.RawMessage, runID *uuid.UUID, historyComplete bool, externalPrintID *string, reportRevision *int64) (QueuedEvent, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return QueuedEvent{}, err
	}
	defer tx.Rollback()
	var queued int64
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM outbox`).Scan(&queued); err != nil {
		return QueuedEvent{}, err
	}
	if queued >= maxOutboxEvents {
		return QueuedEvent{}, errors.New("connector event queue is full; printer polling is paused until delivery resumes")
	}
	var sequence int64
	err = tx.QueryRowContext(ctx, `SELECT next_sequence FROM assignment_sequences WHERE assignment_id=?`, assignmentID.String()).Scan(&sequence)
	if errors.Is(err, sql.ErrNoRows) {
		sequence = 1
		_, err = tx.ExecContext(ctx, `INSERT INTO assignment_sequences(assignment_id,next_sequence) VALUES(?,2)`, assignmentID.String())
	} else if err == nil {
		_, err = tx.ExecContext(ctx, `UPDATE assignment_sequences SET next_sequence=? WHERE assignment_id=?`, sequence+1, assignmentID.String())
	}
	if err != nil {
		return QueuedEvent{}, err
	}
	now := time.Now().UTC()
	event := QueuedEvent{EventID: uuid.Must(uuid.NewV7()), AssignmentID: assignmentID, RunID: runID, HistoryComplete: historyComplete, ConfigurationVersion: configurationVersion, Sequence: sequence, OccurredAt: now, Kind: kind, ExternalPrintID: externalPrintID, ReportRevision: reportRevision, Payload: payload}
	var runValue any
	if runID != nil {
		runValue = runID.String()
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO outbox(event_id,assignment_id,configuration_version,sequence,occurred_at,kind,run_id,history_complete,external_print_id,report_revision,payload,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, event.EventID.String(), assignmentID.String(), configurationVersion, sequence, now.Format(time.RFC3339Nano), kind, runValue, historyComplete, externalPrintID, reportRevision, []byte(payload), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return QueuedEvent{}, err
	}
	if err = tx.Commit(); err != nil {
		return QueuedEvent{}, err
	}
	return event, nil
}

func (s *Store) MarkDeliveryFailure(ctx context.Context, events []QueuedEvent) error {
	if len(events) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, event := range events {
		var attempt int
		if err = tx.QueryRowContext(ctx, `SELECT attempt_count FROM outbox WHERE event_id=? AND state='pending'`, event.EventID.String()).Scan(&attempt); errors.Is(err, sql.ErrNoRows) {
			continue
		} else if err != nil {
			return err
		}
		delay := time.Second * time.Duration(1<<min(attempt, 8))
		if delay > 5*time.Minute {
			delay = 5 * time.Minute
		}
		_, err = tx.ExecContext(ctx, `UPDATE outbox SET attempt_count=attempt_count+1,next_attempt_at=? WHERE event_id=? AND state='pending'`, time.Now().UTC().Add(delay).Format(time.RFC3339Nano), event.EventID.String())
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) Pending(ctx context.Context, limit int) ([]QueuedEvent, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT event_id,assignment_id,configuration_version,sequence,occurred_at,kind,run_id,history_complete,external_print_id,report_revision,payload FROM outbox WHERE state='pending' AND next_attempt_at<=? ORDER BY created_at LIMIT ?`, time.Now().UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []QueuedEvent{}
	for rows.Next() {
		var eventID, assignmentID, occurred string
		var event QueuedEvent
		var runID, external sql.NullString
		var revision sql.NullInt64
		if err = rows.Scan(&eventID, &assignmentID, &event.ConfigurationVersion, &event.Sequence, &occurred, &event.Kind, &runID, &event.HistoryComplete, &external, &revision, &event.Payload); err != nil {
			return nil, err
		}
		event.EventID, err = uuid.Parse(eventID)
		if err != nil {
			return nil, err
		}
		event.AssignmentID, err = uuid.Parse(assignmentID)
		if err != nil {
			return nil, err
		}
		event.OccurredAt, err = time.Parse(time.RFC3339Nano, occurred)
		if err != nil {
			return nil, err
		}
		if runID.Valid {
			parsed, parseErr := uuid.Parse(runID.String)
			if parseErr != nil {
				return nil, parseErr
			}
			event.RunID = &parsed
		}
		if external.Valid {
			event.ExternalPrintID = &external.String
		}
		if revision.Valid {
			event.ReportRevision = &revision.Int64
		}
		result = append(result, event)
	}
	return result, rows.Err()
}

func (s *Store) ApplyReceipts(ctx context.Context, receipts []EventReceipt) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, receipt := range receipts {
		switch receipt.Status {
		case "accepted", "duplicate":
			_, err = tx.ExecContext(ctx, `DELETE FROM outbox WHERE event_id=?`, receipt.EventID.String())
		case "rejected":
			_, err = tx.ExecContext(ctx, `UPDATE outbox SET state='quarantined',reason_code=? WHERE event_id=?`, receipt.ReasonCode, receipt.EventID.String())
		case "retry":
			var attempt int
			if err = tx.QueryRowContext(ctx, `SELECT attempt_count FROM outbox WHERE event_id=? AND state='pending'`, receipt.EventID.String()).Scan(&attempt); errors.Is(err, sql.ErrNoRows) {
				continue
			} else if err != nil {
				return err
			}
			delay := time.Second * time.Duration(1<<min(attempt, 8))
			if delay > 5*time.Minute {
				delay = 5 * time.Minute
			}
			_, err = tx.ExecContext(ctx, `UPDATE outbox SET attempt_count=attempt_count+1,next_attempt_at=? WHERE event_id=? AND state='pending'`, time.Now().UTC().Add(delay).Format(time.RFC3339Nano), receipt.EventID.String())
		default:
			return fmt.Errorf("unknown event receipt status %q", receipt.Status)
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) QueueCounts(ctx context.Context) (pending, quarantined int64, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE state='pending'), count(*) FILTER (WHERE state='quarantined') FROM outbox`).Scan(&pending, &quarantined)
	return
}
