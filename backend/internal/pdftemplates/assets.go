package pdftemplates

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MaxAssets bounds the images an installation keeps for templates; a makerspace needs a handful.
const MaxAssets = 100

// maxFileNameLength is the longest stored file name, matching the table constraint.
const maxFileNameLength = 200

// assetsLock is the advisory lock key serializing uploads, so the image limit holds under concurrency.
const assetsLock = "assets"

// Asset describes one uploaded image.
type Asset struct {
	ID          uuid.UUID
	FileName    string
	ContentType string
	ByteSize    int
	Width       int
	Height      int
	CreatedAt   time.Time
}

// AssetContent is an image with its bytes.
type AssetContent struct {
	Asset
	Data []byte
}

func invalidFileName() error {
	return apperror.New(
		http.StatusUnprocessableEntity, CodeInvalidFileName,
		fmt.Sprintf("The file name must have 1 to %d characters and no control characters", maxFileNameLength),
	)
}

func cleanFileName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxFileNameLength || !utf8.ValidString(name) {
		return "", invalidFileName()
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", invalidFileName()
		}
	}
	return name, nil
}

// ListAssets returns the uploaded images without their bytes, newest first.
func (s *Service) ListAssets(ctx context.Context, p authorization.Principal) ([]Asset, error) {
	if err := requireManage(p); err != nil {
		return nil, err
	}
	rows, err := db.New(s.pool).ListAssets(ctx, MaxAssets+1)
	if err != nil {
		return nil, fmt.Errorf("list pdf template assets: %w", err)
	}
	assets := make([]Asset, 0, len(rows))
	for _, row := range rows {
		assets = append(assets, Asset{
			ID: row.ID, FileName: row.FileName, ContentType: row.ContentType, ByteSize: int(row.ByteSize),
			Width: int(row.Width), Height: int(row.Height), CreatedAt: row.CreatedAt,
		})
	}
	return assets, nil
}

// GetAsset returns an image with its bytes.
func (s *Service) GetAsset(ctx context.Context, p authorization.Principal, id uuid.UUID) (AssetContent, error) {
	if err := requireManage(p); err != nil {
		return AssetContent{}, err
	}
	row, err := db.New(s.pool).GetAsset(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return AssetContent{}, apperror.NotFound
	}
	if err != nil {
		return AssetContent{}, fmt.Errorf("load pdf template asset: %w", err)
	}
	return AssetContent{
		Asset: Asset{
			ID: row.ID, FileName: row.FileName, ContentType: row.ContentType, ByteSize: int(row.ByteSize),
			Width: int(row.Width), Height: int(row.Height), CreatedAt: row.CreatedAt,
		},
		Data: row.Data,
	}, nil
}

// UploadAsset stores a PNG, JPEG or SVG image. The type is sniffed from the content and the size and pixel limits
// are checked before anything is stored (422 pdf_template_asset_invalid). A PNG or JPEG is re-encoded, so metadata
// such as EXIF or GPS data is never stored.
func (s *Service) UploadAsset(
	ctx context.Context,
	p authorization.Principal,
	fileName string,
	data []byte,
	requestID *uuid.UUID,
) (Asset, error) {
	if err := requireManage(p); err != nil {
		return Asset{}, err
	}
	name, err := cleanFileName(fileName)
	if err != nil {
		return Asset{}, err
	}
	// Decoding an image is the expensive part, so it happens before the transaction opens.
	info, data, err := engine.PrepareAsset(data)
	if err != nil {
		return Asset{}, err
	}
	digest := sha256.Sum256(data)
	var created Asset
	err = s.inTx(ctx, []string{assetsLock}, func(q *db.Queries, tx pgx.Tx) error {
		count, err := q.CountAssets(ctx)
		if err != nil {
			return fmt.Errorf("count pdf template assets: %w", err)
		}
		if count >= MaxAssets {
			return apperror.Conflicting(CodeAssetLimit, fmt.Sprintf("At most %d images can be stored", MaxAssets))
		}
		row, err := q.InsertAsset(ctx, db.InsertAssetParams{
			ID: ids.New(), FileName: name, ContentType: info.ContentType, ByteSize: int32(len(data)),
			Sha256: digest[:], Data: data, Width: int32(info.Width), Height: int32(info.Height),
			CreatedByAccountID: &p.AccountID,
		})
		if err != nil {
			return fmt.Errorf("insert pdf template asset: %w", err)
		}
		created = Asset{
			ID: row.ID, FileName: row.FileName, ContentType: row.ContentType, ByteSize: int(row.ByteSize),
			Width: int(row.Width), Height: int(row.Height), CreatedAt: row.CreatedAt,
		}
		return audit.Write(ctx, tx, audit.Event{
			ActorAccountID: &p.AccountID,
			Action:         AuditAssetUploaded,
			ResourceType:   auditAsset,
			ResourceID:     &row.ID,
			RequestID:      requestID,
			Metadata:       map[string]any{"assetId": row.ID.String()},
		})
	})
	if err != nil {
		return Asset{}, err
	}
	return created, nil
}

// DeleteAsset removes an image that no draft or published template uses (409 pdf_template_asset_in_use
// otherwise). It holds the locks of every export, so a template cannot start using the image meanwhile.
func (s *Service) DeleteAsset(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) error {
	if err := requireManage(p); err != nil {
		return err
	}
	locks := make([]string, 0, len(engine.Kinds)+1)
	for _, kind := range engine.Kinds {
		locks = append(locks, string(kind))
	}
	locks = append(locks, assetsLock)
	return s.inTx(ctx, locks, func(q *db.Queries, tx pgx.Tx) error {
		if _, err := q.GetAssetMeta(ctx, id); errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		} else if err != nil {
			return fmt.Errorf("load pdf template asset: %w", err)
		}
		used, err := q.AssetIsReferenced(ctx, id.String())
		if err != nil {
			return fmt.Errorf("check pdf template asset use: %w", err)
		}
		if used {
			return apperror.Conflicting(CodeAssetInUse, "A draft or published template still uses the image")
		}
		if _, err := q.DeleteAsset(ctx, id); err != nil {
			return fmt.Errorf("delete pdf template asset: %w", err)
		}
		return audit.Write(ctx, tx, audit.Event{
			ActorAccountID: &p.AccountID,
			Action:         AuditAssetDeleted,
			ResourceType:   auditAsset,
			ResourceID:     &id,
			RequestID:      requestID,
			Metadata:       map[string]any{"assetId": id.String()},
		})
	})
}

// assetSource reads images for the renderer.
type assetSource struct{ q *db.Queries }

func (a assetSource) Asset(ctx context.Context, id string) (engine.Asset, error) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return engine.Asset{}, engine.ErrAssetNotFound
	}
	row, err := a.q.GetAsset(ctx, parsed)
	if errors.Is(err, pgx.ErrNoRows) {
		return engine.Asset{}, engine.ErrAssetNotFound
	}
	if err != nil {
		return engine.Asset{}, fmt.Errorf("load pdf template asset: %w", err)
	}
	return engine.Asset{Data: row.Data}, nil
}
