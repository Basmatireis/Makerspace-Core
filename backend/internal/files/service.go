package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

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

func (s *Service) StoreBytes(ctx context.Context, principal authorization.Principal, originalFilename, contentType string, data []byte, requestID *uuid.UUID) (File, error) {
	actor := principal.AccountID
	return s.storeBytes(ctx, &actor, originalFilename, contentType, data, requestID)
}

// StoreSystemBytes stores a private file produced by a controlled unauthenticated
// workflow. The creator remains null while the audit event is still recorded.
func (s *Service) StoreSystemBytes(ctx context.Context, originalFilename, contentType string, data []byte, requestID *uuid.UUID) (File, error) {
	return s.storeBytes(ctx, nil, originalFilename, contentType, data, requestID)
}

func (s *Service) storeBytes(ctx context.Context, actor *uuid.UUID, originalFilename, contentType string, data []byte, requestID *uuid.UUID) (File, error) {
	filename := strings.TrimSpace(originalFilename)
	contentType = strings.TrimSpace(contentType)
	if filename == "" || len(filename) > 255 || contentType == "" || len(contentType) > 255 {
		return File{}, apperror.New(422, "file_metadata_invalid", "File name or content type is invalid")
	}
	id := uuid.Must(uuid.NewV7())
	key := strings.ReplaceAll(id.String()[:2]+"/"+id.String(), "..", "")
	digest := sha256.Sum256(data)
	metadata := storage.Metadata{Size: int64(len(data)), SHA256: digest}
	if err := s.store.Put(ctx, key, bytes.NewReader(data), metadata); err != nil {
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
		SizeBytes: int64(len(data)), Sha256: digest[:], CreatedByAccountID: actor,
	})
	if err != nil {
		return File{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: actor, Action: "file.created", ResourceType: "file", ResourceID: &id, RequestID: requestID}); err != nil {
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
		return File{}, nil, apperror.New(500, "file_blob_missing", "Stored file is unavailable")
	}
	return fromRow(row), reader, err
}

func (s *Service) Delete(ctx context.Context, principal authorization.Principal, id uuid.UUID, requestID *uuid.UUID) error {
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
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: actor, Action: "file.deleted", ResourceType: "file", ResourceID: &id, RequestID: requestID}); err != nil {
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
		if current, metadataErr := destination.Metadata(ctx, row.StorageKey); metadataErr == nil && current == expected {
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
	return File{ID: row.ID, StorageKey: row.StorageKey, OriginalFilename: row.OriginalFilename, ContentType: row.ContentType, Size: row.SizeBytes, SHA256: digest, CreatedByAccountID: row.CreatedByAccountID, CreatedAt: row.CreatedAt}
}
