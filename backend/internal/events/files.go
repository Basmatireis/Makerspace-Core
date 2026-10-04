package events

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	eventsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/events/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const maxEventFileBytes = 25 << 20

var allowedEventFileTypes = map[string]struct{}{
	"application/pdf": {}, "image/jpeg": {}, "image/png": {}, "image/gif": {}, "image/webp": {},
	"text/plain": {}, "text/csv": {}, "application/csv": {},
	"application/msword": {}, "application/vnd.ms-excel": {}, "application/vnd.ms-powerpoint": {},
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":   {},
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         {},
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": {},
	"application/vnd.oasis.opendocument.text":                                   {}, "application/vnd.oasis.opendocument.spreadsheet": {}, "application/vnd.oasis.opendocument.presentation": {},
}

func (s *Service) ListFiles(ctx context.Context, principal authorization.Principal, eventID uuid.UUID) ([]EventFile, error) {
	if !canRead(principal) {
		return nil, apperror.PermissionDenied
	}
	rows, err := eventsdb.New(s.pool).ListEventFiles(ctx, eventID)
	if err != nil {
		return nil, err
	}
	result := make([]EventFile, 0, len(rows))
	for _, row := range rows {
		result = append(result, EventFile{ID: row.ID, EventID: row.EventID, FileID: row.FileID, Description: row.Description, Visibility: row.Visibility, IsBanner: row.IsBanner, OriginalFilename: row.OriginalFilename, ContentType: row.ContentType, SizeBytes: row.SizeBytes, Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt})
	}
	return result, nil
}

func (s *Service) AttachFile(ctx context.Context, principal authorization.Principal, eventID uuid.UUID, filename, contentType, visibility string, isBanner bool, description *string, data []byte, requestID *uuid.UUID) (EventFile, error) {
	if !principal.Has(authorization.EventsManage) {
		return EventFile{}, apperror.PermissionDenied
	}
	if s.files == nil {
		return EventFile{}, errors.New("file storage is unavailable")
	}
	if len(data) > maxEventFileBytes {
		return EventFile{}, apperror.New(413, "event_file_too_large", "Event files are limited to 25 MiB")
	}
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if _, ok := allowedEventFileTypes[contentType]; !ok {
		return EventFile{}, validation("file type is not allowed")
	}
	if err := validateEventFileContent(contentType, data); err != nil {
		return EventFile{}, err
	}
	if visibility != "internal" && visibility != "public" {
		return EventFile{}, validation("visibility is invalid")
	}
	if isBanner && (visibility != "public" || !isEventImageType(contentType)) {
		return EventFile{}, validation("a banner must be a public JPEG, PNG, GIF, or WebP image")
	}
	description, err := cleanOptional(description, 2000)
	if err != nil {
		return EventFile{}, err
	}
	stored, err := s.files.StoreBytes(ctx, principal, filename, contentType, data, requestID)
	if err != nil {
		return EventFile{}, err
	}
	attached := false
	defer func() {
		if !attached {
			_ = s.files.DeleteSystem(context.Background(), stored.ID, requestID)
		}
	}()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EventFile{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, true); err != nil {
		return EventFile{}, err
	}
	id := uuid.Must(uuid.NewV7())
	if isBanner {
		if err = q.ClearOtherEventBanners(ctx, eventsdb.ClearOtherEventBannersParams{EventID: eventID, ExcludedID: id}); err != nil {
			return EventFile{}, err
		}
	}
	row, err := q.CreateEventFile(ctx, eventsdb.CreateEventFileParams{ID: id, EventID: eventID, FileID: stored.ID, Description: description, Visibility: visibility, IsBanner: isBanner})
	if err != nil {
		return EventFile{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, "event_file.attached", "event_file", id, requestID, []string{"description", "visibility", "isBanner"}, map[string]any{"eventId": eventID.String()}); err != nil {
		return EventFile{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return EventFile{}, err
	}
	attached = true
	return EventFile{ID: row.ID, EventID: row.EventID, FileID: row.FileID, Description: row.Description, Visibility: row.Visibility, IsBanner: row.IsBanner, OriginalFilename: stored.OriginalFilename, ContentType: stored.ContentType, SizeBytes: stored.Size, Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

func isEventImageType(contentType string) bool {
	switch contentType {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

func validateEventFileContent(declared string, data []byte) error {
	prefix := data
	if len(prefix) > 4096 {
		prefix = prefix[:4096]
	}
	lower := bytes.ToLower(bytes.TrimSpace(prefix))
	if bytes.HasPrefix(lower, []byte("<html")) || bytes.HasPrefix(lower, []byte("<!doctype html")) ||
		bytes.HasPrefix(lower, []byte("<script")) || bytes.HasPrefix(lower, []byte("#!")) ||
		bytes.Contains(lower, []byte("<svg")) || bytes.HasPrefix(prefix, []byte("MZ")) ||
		bytes.HasPrefix(prefix, []byte{0x7f, 'E', 'L', 'F'}) || isMachO(prefix) {
		return validation("file content is not allowed")
	}
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(prefix), ";")[0]))
	switch declared {
	case "application/pdf":
		if detected != "application/pdf" {
			return validation("file content does not match its type")
		}
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		if detected != declared {
			return validation("file content does not match its type")
		}
	case "text/plain", "text/csv", "application/csv":
		if detected != "text/plain" {
			return validation("file content does not match its type")
		}
	}
	return nil
}

func isMachO(value []byte) bool {
	if len(value) < 4 {
		return false
	}
	magic := [4]byte{value[0], value[1], value[2], value[3]}
	return magic == [4]byte{0xfe, 0xed, 0xfa, 0xce} || magic == [4]byte{0xce, 0xfa, 0xed, 0xfe} ||
		magic == [4]byte{0xfe, 0xed, 0xfa, 0xcf} || magic == [4]byte{0xcf, 0xfa, 0xed, 0xfe} ||
		magic == [4]byte{0xca, 0xfe, 0xba, 0xbe}
}

func (s *Service) UpdateFile(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID, expected int64, visibility string, isBanner *bool, description *string, requestID *uuid.UUID) (EventFile, error) {
	if !principal.Has(authorization.EventsManage) {
		return EventFile{}, apperror.PermissionDenied
	}
	if err := validateVersion(expected); err != nil {
		return EventFile{}, err
	}
	if visibility != "internal" && visibility != "public" {
		return EventFile{}, validation("visibility is invalid")
	}
	description, err := cleanOptional(description, 2000)
	if err != nil {
		return EventFile{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return EventFile{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, true); err != nil {
		return EventFile{}, err
	}
	current, err := q.GetEventFile(ctx, eventsdb.GetEventFileParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return EventFile{}, apperror.NotFound
	}
	if err != nil {
		return EventFile{}, err
	}
	if int64(current.Version) != expected {
		return EventFile{}, apperror.StaleWrite
	}
	nextBanner := current.IsBanner
	if isBanner != nil {
		nextBanner = *isBanner
	}
	if visibility == "internal" {
		nextBanner = false
	}
	if nextBanner && !isEventImageType(current.ContentType) {
		return EventFile{}, validation("a banner must be a public JPEG, PNG, GIF, or WebP image")
	}
	if nextBanner {
		if err = q.ClearOtherEventBanners(ctx, eventsdb.ClearOtherEventBannersParams{EventID: eventID, ExcludedID: id}); err != nil {
			return EventFile{}, err
		}
	}
	row, err := q.UpdateEventFile(ctx, eventsdb.UpdateEventFileParams{Description: description, Visibility: visibility, IsBanner: nextBanner, ID: id, EventID: eventID, ExpectedVersion: int32(expected)})
	if err != nil {
		return EventFile{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, "event_file.updated", "event_file", id, requestID, []string{"description", "visibility", "isBanner"}, map[string]any{"eventId": eventID.String()}); err != nil {
		return EventFile{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return EventFile{}, err
	}
	return EventFile{ID: row.ID, EventID: row.EventID, FileID: row.FileID, Description: row.Description, Visibility: row.Visibility, IsBanner: row.IsBanner, OriginalFilename: current.OriginalFilename, ContentType: current.ContentType, SizeBytes: current.SizeBytes, Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}

func (s *Service) RemoveFile(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID, expected int64, requestID *uuid.UUID) error {
	if !principal.Has(authorization.EventsManage) {
		return apperror.PermissionDenied
	}
	if err := validateVersion(expected); err != nil {
		return err
	}
	if s.files == nil {
		return errors.New("file storage is unavailable")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := eventsdb.New(tx)
	if err = requireEventWritable(ctx, q, eventID, true); err != nil {
		return err
	}
	current, err := q.GetEventFile(ctx, eventsdb.GetEventFileParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	}
	if err != nil {
		return err
	}
	if int64(current.Version) != expected {
		return apperror.StaleWrite
	}
	fileID, err := q.DeleteEventFile(ctx, eventsdb.DeleteEventFileParams{ID: id, EventID: eventID, ExpectedVersion: int32(expected)})
	if err != nil {
		return databaseError(err)
	}
	actor := principal.AccountID
	if err = eventAudit(ctx, tx, &actor, "event_file.removed", "event_file", id, requestID, nil, map[string]any{"eventId": eventID.String()}); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	return s.files.Delete(ctx, principal, fileID, requestID)
}

func (s *Service) OpenFile(ctx context.Context, principal authorization.Principal, eventID, id uuid.UUID) (EventFile, files.File, io.ReadCloser, error) {
	if !canRead(principal) {
		return EventFile{}, files.File{}, nil, apperror.PermissionDenied
	}
	row, err := eventsdb.New(s.pool).GetEventFile(ctx, eventsdb.GetEventFileParams{ID: id, EventID: eventID})
	if errors.Is(err, pgx.ErrNoRows) {
		return EventFile{}, files.File{}, nil, apperror.NotFound
	}
	if err != nil {
		return EventFile{}, files.File{}, nil, err
	}
	file, reader, err := s.files.Open(ctx, row.FileID)
	return EventFile{ID: row.ID, EventID: row.EventID, FileID: row.FileID, Description: row.Description, Visibility: row.Visibility, IsBanner: row.IsBanner, OriginalFilename: row.OriginalFilename, ContentType: row.ContentType, SizeBytes: row.SizeBytes, Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, file, reader, err
}
func (s *Service) OpenPublicFile(ctx context.Context, publicID string, id uuid.UUID) (EventFile, files.File, io.ReadCloser, error) {
	row, err := eventsdb.New(s.pool).GetPublicEventFile(ctx, eventsdb.GetPublicEventFileParams{ID: id, PublicID: publicID})
	if errors.Is(err, pgx.ErrNoRows) {
		return EventFile{}, files.File{}, nil, apperror.NotFound
	}
	if err != nil {
		return EventFile{}, files.File{}, nil, err
	}
	file, reader, err := s.files.Open(ctx, row.FileID)
	return EventFile{ID: row.ID, EventID: uuid.Nil, FileID: uuid.Nil, Description: row.Description, Visibility: "public", IsBanner: row.IsBanner, OriginalFilename: row.OriginalFilename, ContentType: row.ContentType, SizeBytes: row.SizeBytes, Version: int64(row.Version), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, file, reader, err
}

func (s *Service) OpenBanner(ctx context.Context, principal authorization.Principal, eventID uuid.UUID) (files.File, io.ReadCloser, error) {
	if !canRead(principal) {
		return files.File{}, nil, apperror.PermissionDenied
	}
	row, err := eventsdb.New(s.pool).GetEventBanner(ctx, eventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return files.File{}, nil, apperror.NotFound
	}
	if err != nil {
		return files.File{}, nil, err
	}
	file, reader, err := s.files.Open(ctx, row.FileID)
	return file, reader, err
}

func (s *Service) OpenPublicBanner(ctx context.Context, publicID string) (files.File, io.ReadCloser, error) {
	row, err := eventsdb.New(s.pool).GetPublicEventBanner(ctx, publicID)
	if errors.Is(err, pgx.ErrNoRows) {
		return files.File{}, nil, apperror.NotFound
	}
	if err != nil {
		return files.File{}, nil, err
	}
	file, reader, err := s.files.Open(ctx, row.FileID)
	return file, reader, err
}
