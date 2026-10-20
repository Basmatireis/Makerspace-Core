package signage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	_ "image/jpeg" // registers the JPEG decoder for DecodeConfig
	_ "image/png"  // registers the PNG decoder for DecodeConfig
	"io"
	"net/http"
	"os"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	_ "golang.org/x/image/webp" // registers the WebP decoder for DecodeConfig
)

const (
	// MaxImageBytes and MaxVideoBytes are the upload limits per asset kind.
	MaxImageBytes int64 = 20 << 20
	MaxVideoBytes int64 = 200 << 20

	maxImageSide   = 8192
	maxImagePixels = 40_000_000
)

// Asset is an uploaded image or video; the bytes live in the files module.
type Asset struct {
	ID                 uuid.UUID
	Kind               string
	Name               string
	Width, Height      *int
	DurationMs         *int
	ContentType        string
	SizeBytes          int64
	SHA256             string
	CreatedByAccountID *uuid.UUID
	CreatedByName      *string
	CreatedAt          time.Time
}

// UploadInput describes one asset upload. Width, Height and DurationMs are only read for videos.
type UploadInput struct {
	Name        string
	ContentType string
	Width       *int
	Height      *int
	DurationMs  *int
	Body        io.Reader
}

var assetContentTypes = map[string]string{
	"image/png": "image", "image/jpeg": "image", "image/webp": "image", "video/mp4": "video",
}

var imageFormats = map[string]string{"image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp"}

// OpenedAsset is an asset together with an open reader over its bytes.
type OpenedAsset struct {
	Asset  Asset
	Reader io.ReadCloser
}

// assetFromRow maps a row; an empty createdByName (account deleted) becomes nil.
func assetFromRow(
	id uuid.UUID,
	kind, name string,
	width, height, duration *int32,
	createdBy *uuid.UUID,
	createdByName string,
	createdAt time.Time,
	contentType string,
	size int64,
	digest []byte,
) Asset {
	var uploader *string
	if createdByName != "" {
		uploader = &createdByName
	}
	return Asset{
		ID:                 id,
		Kind:               kind,
		Name:               name,
		Width:              intPointer(width),
		Height:             intPointer(height),
		DurationMs:         intPointer(duration),
		ContentType:        contentType,
		SizeBytes:          size,
		SHA256:             hex.EncodeToString(digest),
		CreatedByAccountID: createdBy,
		CreatedByName:      uploader,
		CreatedAt:          createdAt.UTC(),
	}
}

// ListAssets lists assets newest first, optionally only one kind.
func (s *Service) ListAssets(ctx context.Context, principal authorization.Principal, kind *string) ([]Asset, error) {
	if err := requireRead(principal); err != nil {
		return nil, err
	}
	if kind != nil && *kind != "image" && *kind != "video" {
		return nil, validation("kind must be image or video")
	}
	rows, err := signagedb.New(s.pool).ListSignageAssets(ctx, kind)
	if err != nil {
		return nil, err
	}
	items := make([]Asset, 0, len(rows))
	for _, row := range rows {
		items = append(
			items,
			assetFromRow(
				row.ID,
				row.Kind,
				row.Name,
				row.Width,
				row.Height,
				row.DurationMs,
				row.CreatedByAccountID,
				row.CreatedByName,
				row.CreatedAt,
				row.ContentType,
				row.SizeBytes,
				row.Sha256,
			),
		)
	}
	return items, nil
}

// GetAsset reads one asset's metadata.
func (s *Service) GetAsset(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Asset, error) {
	if err := requireRead(principal); err != nil {
		return Asset{}, err
	}
	return s.getAsset(ctx, signagedb.New(s.pool), id)
}

func (s *Service) getAsset(ctx context.Context, q *signagedb.Queries, id uuid.UUID) (Asset, error) {
	row, err := q.GetSignageAsset(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Asset{}, apperror.NotFound
	}
	if err != nil {
		return Asset{}, err
	}
	return assetFromRow(
		row.ID,
		row.Kind,
		row.Name,
		row.Width,
		row.Height,
		row.DurationMs,
		row.CreatedByAccountID,
		row.CreatedByName,
		row.CreatedAt,
		row.ContentType,
		row.SizeBytes,
		row.Sha256,
	), nil
}

// OpenAsset opens the asset bytes for an admin preview.
func (s *Service) OpenAsset(ctx context.Context, principal authorization.Principal, id uuid.UUID) (OpenedAsset, error) {
	if err := requireRead(principal); err != nil {
		return OpenedAsset{}, err
	}
	row, err := signagedb.New(s.pool).GetSignageAsset(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return OpenedAsset{}, apperror.NotFound
	}
	if err != nil {
		return OpenedAsset{}, err
	}
	_, reader, err := s.files.Open(ctx, row.FileID)
	if err != nil {
		return OpenedAsset{}, err
	}
	return OpenedAsset{
		Asset: assetFromRow(
			row.ID,
			row.Kind,
			row.Name,
			row.Width,
			row.Height,
			row.DurationMs,
			row.CreatedByAccountID,
			row.CreatedByName,
			row.CreatedAt,
			row.ContentType,
			row.SizeBytes,
			row.Sha256,
		),
		Reader: reader,
	}, nil
}

func positiveHeader(value *int, max int, label string) error {
	if value != nil && (*value < 1 || *value > max) {
		return validation("%s must be between 1 and %d", label, max)
	}
	return nil
}

// UploadAsset validates and stores an image (PNG, JPEG, WebP up to 20 MiB, dimensions decoded from
// the bytes) or an MP4 video (up to 200 MiB, dimensions and duration optional). The body is
// spooled to a temporary file while hashing so large videos never sit in memory; the HTTP layer
// does not buffer it either (raw binary routes skip OpenAPI body validation, see isRawBinaryUpload).
func (s *Service) UploadAsset(
	ctx context.Context,
	principal authorization.Principal,
	input UploadInput,
	requestID *uuid.UUID,
) (Asset, error) {
	if err := requireContentManage(principal); err != nil {
		return Asset{}, err
	}
	kind, ok := assetContentTypes[input.ContentType]
	if !ok {
		return Asset{}, validation("content type must be image/png, image/jpeg, image/webp or video/mp4")
	}
	name, err := cleanName(input.Name, "asset name", 150)
	if err != nil {
		return Asset{}, err
	}
	if kind == "video" {
		if err := positiveHeader(input.Width, 20000, "video width"); err != nil {
			return Asset{}, err
		}
		if err := positiveHeader(input.Height, 20000, "video height"); err != nil {
			return Asset{}, err
		}
		if (input.Width == nil) != (input.Height == nil) {
			return Asset{}, validation("video width and height must be given together")
		}
		if err := positiveHeader(input.DurationMs, 86_400_000, "video duration"); err != nil {
			return Asset{}, err
		}
	}
	limit := MaxImageBytes
	if kind == "video" {
		limit = MaxVideoBytes
	}
	spool, err := os.CreateTemp("", "signage-upload-*")
	if err != nil {
		return Asset{}, err
	}
	defer func() {
		_ = spool.Close()
		_ = os.Remove(spool.Name())
	}()
	hasher := sha256.New()
	size, err := io.Copy(io.MultiWriter(spool, hasher), io.LimitReader(input.Body, limit+1))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return Asset{}, assetTooLarge(kind)
		}
		return Asset{}, apperror.New(400, "invalid_request", "Could not read the upload")
	}
	if size > limit {
		return Asset{}, assetTooLarge(kind)
	}
	if size == 0 {
		return Asset{}, validation("the file is empty")
	}
	if _, err := spool.Seek(0, io.SeekStart); err != nil {
		return Asset{}, err
	}
	var width, height, duration *int
	if kind == "image" {
		configuration, format, err := image.DecodeConfig(spool)
		if err != nil || format != imageFormats[input.ContentType] {
			return Asset{}, validation("the file is not a valid %s image", imageFormats[input.ContentType])
		}
		if configuration.Width < 1 || configuration.Height < 1 || configuration.Width > maxImageSide ||
			configuration.Height > maxImageSide ||
			int64(configuration.Width)*int64(configuration.Height) > maxImagePixels {
			return Asset{}, validation(
				"image dimensions exceed %d pixels per side or %d megapixels",
				maxImageSide,
				maxImagePixels/1_000_000,
			)
		}
		w, h := configuration.Width, configuration.Height
		width, height = &w, &h
	} else {
		header := make([]byte, 12)
		if _, err := io.ReadFull(spool, header); err != nil || string(header[4:8]) != "ftyp" {
			return Asset{}, validation("the file is not a valid MP4 video")
		}
		width, height, duration = input.Width, input.Height, input.DurationMs
	}
	if _, err := spool.Seek(0, io.SeekStart); err != nil {
		return Asset{}, err
	}
	var digest [sha256.Size]byte
	copy(digest[:], hasher.Sum(nil))
	// The blob is written to storage first; the file row, asset row and both audit events then
	// commit in one transaction. If anything fails before the commit, cleanup removes the blob.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Asset{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	stored, cleanup, err := s.files.StoreReaderInTransaction(
		ctx,
		tx,
		principal,
		name,
		input.ContentType,
		spool,
		storage.Metadata{Size: size, SHA256: digest},
		requestID,
	)
	if err != nil {
		return Asset{}, err
	}
	committed := false
	defer func() {
		if !committed {
			cleanup()
		}
	}()
	id := uuid.Must(uuid.NewV7())
	actor := principal.AccountID
	if _, err := signagedb.New(tx).CreateSignageAsset(ctx, signagedb.CreateSignageAssetParams{
		ID:                 id,
		FileID:             stored.ID,
		Kind:               kind,
		Name:               name,
		Width:              int32Pointer(width),
		Height:             int32Pointer(height),
		DurationMs:         int32Pointer(duration),
		CreatedByAccountID: &actor,
	}); err != nil {
		return Asset{}, databaseError(err)
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_asset.created",
		"signage_asset",
		id,
		requestID,
		[]string{"kind", "name", "file"},
	); err != nil {
		return Asset{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Asset{}, err
	}
	committed = true
	return s.getAsset(ctx, signagedb.New(s.pool), id)
}

func assetTooLarge(kind string) error {
	if kind == "video" {
		return apperror.New(413, "signage_asset_too_large", "Videos are limited to 200 MiB")
	}
	return apperror.New(413, "signage_asset_too_large", "Images are limited to 20 MiB")
}

// RenameAsset changes the display name of an asset.
func (s *Service) RenameAsset(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	name string,
	requestID *uuid.UUID,
) (Asset, error) {
	if err := requireContentManage(principal); err != nil {
		return Asset{}, err
	}
	name, err := cleanName(name, "asset name", 150)
	if err != nil {
		return Asset{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Asset{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	if affected, err := q.RenameSignageAsset(ctx, signagedb.RenameSignageAssetParams{ID: id, Name: name}); err != nil {
		return Asset{}, err
	} else if affected == 0 {
		return Asset{}, apperror.NotFound
	}
	if err := writeAudit(
		ctx,
		tx,
		principal,
		"signage_asset.renamed",
		"signage_asset",
		id,
		requestID,
		[]string{"name"},
	); err != nil {
		return Asset{}, err
	}
	asset, err := s.getAsset(ctx, q, id)
	if err != nil {
		return Asset{}, err
	}
	return asset, tx.Commit(ctx)
}

// DeleteAsset removes an asset that no scene (background or widget) references.
func (s *Service) DeleteAsset(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) error {
	if err := requireContentManage(principal); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := signagedb.New(tx)
	if _, err := q.GetSignageAssetForUpdate(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	scenes, err := q.ListScenesReferencingAsset(ctx, id)
	if err != nil {
		return err
	}
	if len(scenes) > 0 {
		references := make([]Reference, 0, len(scenes))
		for _, scene := range scenes {
			references = append(references, Reference{Kind: "scene", ID: scene.ID, Name: scene.Name})
		}
		return inUse("Asset", references)
	}
	fileID, err := q.DeleteSignageAsset(ctx, id)
	if err != nil {
		return databaseError(err)
	}
	if err := writeAudit(ctx, tx, principal, "signage_asset.deleted", "signage_asset", id, requestID, nil); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	// The asset is gone; removing the stored bytes is best effort and never undoes the deletion.
	_ = s.files.Delete(context.WithoutCancel(ctx), principal, fileID, requestID)
	return nil
}
