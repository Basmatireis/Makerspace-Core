package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	filesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/files/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type File struct {
	ID                 uuid.UUID
	StorageKey         string
	OriginalFilename   string
	ContentType        string
	Size               int64
	SHA256             [sha256.Size]byte
	CreatedByAccountID *uuid.UUID
	CreatedAt          time.Time
}

type Service struct {
	pool  *pgxpool.Pool
	store storage.Store
}

func NewService(pool *pgxpool.Pool, store storage.Store) *Service {
	return &Service{pool: pool, store: store}
}

func (s *Service) StoreBytes(
	ctx context.Context,
	principal authorization.Principal,
	originalFilename, contentType string,
	data []byte,
	requestID *uuid.UUID,
) (File, error) {
	actor := principal.AccountID
	return s.storeBytes(ctx, &actor, originalFilename, contentType, data, requestID)
}

// StoreSystemBytes stores a private file produced by a controlled unauthenticated
// workflow. The creator remains null while the audit event is still recorded.
func (s *Service) StoreSystemBytes(
	ctx context.Context,
	originalFilename, contentType string,
	data []byte,
	requestID *uuid.UUID,
) (File, error) {
	return s.storeBytes(ctx, nil, originalFilename, contentType, data, requestID)
}

// StoreSystemReaderInTransaction writes a verified private blob and inserts
// its metadata and audit record into the caller's transaction. The returned
// cleanup must be called when the outer transaction does not commit. Keeping
// this boundary explicit lets artifact metadata and the file row commit
// atomically without teaching the storage backend about PostgreSQL.
func (s *Service) StoreSystemReaderInTransaction(
	ctx context.Context,
	tx pgx.Tx,
	originalFilename, contentType string,
	reader io.Reader,
	expected storage.Metadata,
	requestID *uuid.UUID,
) (File, func(), error) {
	return s.storeReaderInTransaction(ctx, tx, nil, originalFilename, contentType, reader, expected, requestID)
}

// StoreReaderInTransaction is StoreSystemReaderInTransaction for a file created by an
// authenticated account: the creator is recorded and the audit event names the actor.
func (s *Service) StoreReaderInTransaction(
	ctx context.Context,
	tx pgx.Tx,
	principal authorization.Principal,
	originalFilename, contentType string,
	reader io.Reader,
	expected storage.Metadata,
	requestID *uuid.UUID,
) (File, func(), error) {
	actor := principal.AccountID
	return s.storeReaderInTransaction(ctx, tx, &actor, originalFilename, contentType, reader, expected, requestID)
}

func (s *Service) storeReaderInTransaction(
	ctx context.Context,
	tx pgx.Tx,
	actor *uuid.UUID,
	originalFilename, contentType string,
	reader io.Reader,
	expected storage.Metadata,
	requestID *uuid.UUID,
) (File, func(), error) {
	filename := strings.TrimSpace(originalFilename)
	contentType = strings.TrimSpace(contentType)
	if filename == "" || len(filename) > 255 || contentType == "" || len(contentType) > 255 || expected.Size < 0 {
		return File{}, func() {}, apperror.New(
			http.StatusUnprocessableEntity,
			"file_metadata_invalid",
			"File name or content type is invalid",
		)
	}
	id := ids.New()
	key := strings.ReplaceAll(id.String()[:2]+"/"+id.String(), "..", "")
	hasher := sha256.New()
	var read int64
	verified := io.TeeReader(reader, io.MultiWriter(hasher, countWriter{add: func(n int) { read += int64(n) }}))
	if err := s.store.Put(ctx, key, verified, expected); err != nil {
		return File{}, func() {}, err
	}
	cleanup := func() { _ = s.store.Delete(context.Background(), key) }
	var actual [sha256.Size]byte
	copy(actual[:], hasher.Sum(nil))
	if read != expected.Size || actual != expected.SHA256 {
		cleanup()
		return File{}, func() {}, apperror.New(
			http.StatusUnprocessableEntity,
			"file_integrity_mismatch",
			"File size or SHA-256 does not match the declared content",
		)
	}
	row, err := filesdb.New(tx).CreateFile(ctx, filesdb.CreateFileParams{
		ID: id, StorageKey: key, OriginalFilename: filename, ContentType: contentType,
		SizeBytes: expected.Size, Sha256: expected.SHA256[:], CreatedByAccountID: actor,
	})
	if err != nil {
		cleanup()
		return File{}, func() {}, err
	}
	event := audit.Event{
		ActorAccountID: actor,
		Action:         "file.created",
		ResourceType:   "file",
		ResourceID:     &id,
		RequestID:      requestID,
	}
	if actor == nil {
		event.ActorType = "system"
	}
	if err := audit.Write(ctx, tx, event); err != nil {
		cleanup()
		return File{}, func() {}, err
	}
	return fromRow(row), cleanup, nil
}

type countWriter struct{ add func(int) }

func (w countWriter) Write(p []byte) (int, error) {
	w.add(len(p))
	return len(p), nil
}

func (s *Service) storeBytes(
	ctx context.Context,
	actor *uuid.UUID,
	originalFilename, contentType string,
	data []byte,
	requestID *uuid.UUID,
) (File, error) {
	digest := sha256.Sum256(data)
	return s.storeReader(
		ctx,
		actor,
		originalFilename,
		contentType,
		bytes.NewReader(data),
		storage.Metadata{Size: int64(len(data)), SHA256: digest},
		requestID,
	)
}

// StoreReader stores a private file from a reader whose size and SHA-256 are already known, for
// large uploads that a caller has spooled to disk instead of holding in memory. The blob is verified
// against the declared metadata while it is written.
func (s *Service) StoreReader(
	ctx context.Context,
	principal authorization.Principal,
	originalFilename, contentType string,
	reader io.Reader,
	metadata storage.Metadata,
	requestID *uuid.UUID,
) (File, error) {
	actor := principal.AccountID
	return s.storeReader(ctx, &actor, originalFilename, contentType, reader, metadata, requestID)
}

func (s *Service) storeReader(
	ctx context.Context,
	actor *uuid.UUID,
	originalFilename, contentType string,
	reader io.Reader,
	metadata storage.Metadata,
	requestID *uuid.UUID,
) (File, error) {
	filename := strings.TrimSpace(originalFilename)
	contentType = strings.TrimSpace(contentType)
	if filename == "" || len(filename) > 255 || contentType == "" || len(contentType) > 255 || metadata.Size < 0 {
		return File{}, apperror.New(
			http.StatusUnprocessableEntity,
			"file_metadata_invalid",
			"File name or content type is invalid",
		)
	}
	id := ids.New()
	key := strings.ReplaceAll(id.String()[:2]+"/"+id.String(), "..", "")
	if err := s.store.Put(ctx, key, reader, metadata); err != nil {
		return File{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = s.store.Delete(context.Background(), key)
		}
	}()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, err := filesdb.New(tx).CreateFile(ctx, filesdb.CreateFileParams{
		ID: id, StorageKey: key, OriginalFilename: filename, ContentType: contentType,
		SizeBytes: metadata.Size, Sha256: metadata.SHA256[:], CreatedByAccountID: actor,
	})
	if err != nil {
		return File{}, err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: actor,
			Action:         "file.created",
			ResourceType:   "file",
			ResourceID:     &id,
			RequestID:      requestID,
		},
	); err != nil {
		return File{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, err
	}
	committed = true
	return fromRow(row), nil
}

func (s *Service) DeleteSystem(ctx context.Context, id uuid.UUID, requestID *uuid.UUID) error {
	return s.delete(ctx, nil, id, requestID)
}

func (s *Service) Open(ctx context.Context, id uuid.UUID) (File, io.ReadCloser, error) {
	row, err := filesdb.New(s.pool).GetFile(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, nil, apperror.NotFound
	}
	if err != nil {
		return File{}, nil, err
	}
	reader, err := s.store.Open(ctx, row.StorageKey)
	if errors.Is(err, storage.ErrNotFound) {
		return File{}, nil, apperror.New(
			http.StatusInternalServerError,
			"file_blob_missing",
			"Stored file is unavailable",
		)
	}
	return fromRow(row), reader, err
}

func (s *Service) Delete(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) error {
	actor := principal.AccountID
	return s.delete(ctx, &actor, id, requestID)
}

func (s *Service) delete(ctx context.Context, actor *uuid.UUID, id uuid.UUID, requestID *uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row, err := filesdb.New(tx).DeleteFile(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if err := audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: actor,
			Action:         "file.deleted",
			ResourceType:   "file",
			ResourceID:     &id,
			RequestID:      requestID,
		},
	); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	return s.store.Delete(ctx, row.StorageKey)
}

func (s *Service) Verify(ctx context.Context) ([]uuid.UUID, error) {
	rows, err := filesdb.New(s.pool).ListFiles(ctx)
	if err != nil {
		return nil, err
	}
	invalid := make([]uuid.UUID, 0)
	for _, row := range rows {
		metadata, metadataErr := s.store.Metadata(ctx, row.StorageKey)
		if metadataErr != nil || metadata.Size != row.SizeBytes || !bytes.Equal(metadata.SHA256[:], row.Sha256) {
			invalid = append(invalid, row.ID)
		}
	}
	return invalid, nil
}

// CopyStorage copies database-referenced objects under unchanged keys and
// verifies destination size and SHA-256 before reporting success.
func (s *Service) CopyStorage(ctx context.Context, source, destination storage.Store) (int64, error) {
	rows, err := filesdb.New(s.pool).ListFiles(ctx)
	if err != nil {
		return 0, err
	}
	var copied int64
	for _, row := range rows {
		expected := storage.Metadata{Size: row.SizeBytes}
		copy(expected.SHA256[:], row.Sha256)
		if current, metadataErr := destination.Metadata(ctx, row.StorageKey); metadataErr == nil &&
			current == expected {
			continue
		}
		reader, err := source.Open(ctx, row.StorageKey)
		if err != nil {
			return copied, fmt.Errorf("open source file %s: %w", row.ID, err)
		}
		err = destination.Put(ctx, row.StorageKey, reader, expected)
		closeErr := reader.Close()
		if err != nil {
			return copied, fmt.Errorf("copy file %s: %w", row.ID, err)
		}
		if closeErr != nil {
			return copied, closeErr
		}
		actual, err := destination.Metadata(ctx, row.StorageKey)
		if err != nil || actual != expected {
			return copied, fmt.Errorf("verify copied file %s: integrity mismatch", row.ID)
		}
		copied++
	}
	return copied, nil
}

func fromRow(row filesdb.File) File {
	var digest [sha256.Size]byte
	copy(digest[:], row.Sha256)
	return File{
		ID:                 row.ID,
		StorageKey:         row.StorageKey,
		OriginalFilename:   row.OriginalFilename,
		ContentType:        row.ContentType,
		Size:               row.SizeBytes,
		SHA256:             digest,
		CreatedByAccountID: row.CreatedByAccountID,
		CreatedAt:          row.CreatedAt,
	}
}

// StagedBlob is a verified storage blob without a file row yet. Slow uploads are
// written with PutSystemBlob before any transaction opens; the caller then
// records the file row with Commit inside its transaction, or calls Discard.
type StagedBlob struct {
	service          *Service
	id               uuid.UUID
	key              string
	originalFilename string
	contentType      string
	expected         storage.Metadata
}

// PutSystemBlob streams reader into private storage and verifies its size and
// SHA-256 against expected while writing, without holding it in memory.
func (s *Service) PutSystemBlob(
	ctx context.Context,
	originalFilename, contentType string,
	reader io.Reader,
	expected storage.Metadata,
) (*StagedBlob, error) {
	filename := strings.TrimSpace(originalFilename)
	contentType = strings.TrimSpace(contentType)
	if filename == "" || len(filename) > 255 || contentType == "" || len(contentType) > 255 || expected.Size < 1 {
		return nil, apperror.New(http.StatusUnprocessableEntity, "file_metadata_invalid", "File name or content type is invalid")
	}
	id := ids.New()
	key := id.String()[:2] + "/" + id.String()
	hasher := sha256.New()
	var read int64
	verified := io.TeeReader(reader, io.MultiWriter(hasher, countWriter{add: func(n int) { read += int64(n) }}))
	if err := s.store.Put(ctx, key, verified, expected); err != nil {
		_ = s.store.Delete(context.Background(), key)
		return nil, err
	}
	var actual [sha256.Size]byte
	copy(actual[:], hasher.Sum(nil))
	if read != expected.Size || actual != expected.SHA256 {
		_ = s.store.Delete(context.Background(), key)
		return nil, apperror.New(
			http.StatusUnprocessableEntity,
			"file_integrity_mismatch",
			"File size or SHA-256 does not match the declared content",
		)
	}
	return &StagedBlob{
		service:          s,
		id:               id,
		key:              key,
		originalFilename: filename,
		contentType:      contentType,
		expected:         expected,
	}, nil
}

// Commit inserts the file row and its audit event (system actor) into tx.
func (b *StagedBlob) Commit(ctx context.Context, tx pgx.Tx, requestID *uuid.UUID) (File, error) {
	row, err := filesdb.New(tx).CreateFile(ctx, filesdb.CreateFileParams{
		ID: b.id, StorageKey: b.key, OriginalFilename: b.originalFilename, ContentType: b.contentType,
		SizeBytes: b.expected.Size, Sha256: b.expected.SHA256[:],
	})
	if err != nil {
		return File{}, err
	}
	if err = audit.Write(ctx, tx, audit.Event{
		ActorType:    "system",
		Action:       "file.created",
		ResourceType: "file",
		ResourceID:   &b.id,
		RequestID:    requestID,
	}); err != nil {
		return File{}, err
	}
	return fromRow(row), nil
}

// Discard deletes the blob when its file row was not committed.
func (b *StagedBlob) Discard() { _ = b.service.store.Delete(context.Background(), b.key) }

// DeleteQueuedBlobs deletes up to limit storage blobs whose file rows were
// deleted in another transaction. A blob that is already gone counts as deleted;
// a failing one stays queued for the next pass.
func (s *Service) DeleteQueuedBlobs(ctx context.Context, limit int32) (int, error) {
	q := filesdb.New(s.pool)
	keys, err := q.ListQueuedBlobDeletions(ctx, limit)
	if err != nil {
		return 0, err
	}
	deleted := 0
	var failures []error
	for _, key := range keys {
		if err := s.store.Delete(ctx, key); err != nil && !errors.Is(err, storage.ErrNotFound) {
			failures = append(failures, err)
			continue
		}
		if err := q.DeleteQueuedBlobDeletion(ctx, key); err != nil {
			return deleted, err
		}
		deleted++
	}
	return deleted, errors.Join(failures...)
}
