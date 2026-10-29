package configtransfer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/branding"
	configtransferdb "github.com/Basmatireis/Makerspace-Core/backend/internal/configtransfer/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Stored files travel as base64 next to their SHA-256. The fingerprint and comparisons use the digest only.

func readStoredFile(ctx context.Context, fileService *files.Service, id uuid.UUID) (string, error) {
	_, reader, err := fileService.Open(ctx, id)
	if err != nil {
		return "", err
	}
	defer func() { _ = reader.Close() }()
	data, err := io.ReadAll(io.LimitReader(reader, MaxFileBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > MaxFileBytes {
		return "", fileTooLarge()
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// decodeContent decodes base64 file content and checks it against its declared SHA-256.
func decodeContent(data *string, digest string) ([]byte, error) {
	if data == nil {
		return nil, errors.New("file content is missing")
	}
	content, err := base64.StdEncoding.DecodeString(*data)
	if err != nil {
		return nil, errors.New("file content is not valid base64")
	}
	sum := sha256.Sum256(content)
	if hex.EncodeToString(sum[:]) != strings.ToLower(digest) {
		return nil, errors.New("file content does not match its sha256")
	}
	return content, nil
}

// Branding: identity, colors and legal pages, plus one entry per asset slot (default, none or custom with content).

type brandingIdentity struct {
	LegalOrganizationName string  `json:"legalOrganizationName"`
	DisplayName           string  `json:"displayName"`
	ApplicationName       string  `json:"applicationName"`
	Tagline               *string `json:"tagline"`
	// Both greeting fields are optional so exports of older releases still import; nil keeps the current value.
	FunGreetings     *[]string `json:"funGreetings,omitempty"`
	FunGreetingShare *int      `json:"funGreetingShare,omitempty"`
}

type brandingColors struct {
	Primary    string `json:"primary"`
	Secondary  string `json:"secondary"`
	Accent     string `json:"accent"`
	Background string `json:"background"`
}

type brandingLegal struct {
	Mode        string `json:"mode"`
	Markdown    string `json:"markdown"`
	ExternalURL string `json:"externalUrl"`
}

type brandingAssetEntry struct {
	Slot        string  `json:"slot"`
	Mode        string  `json:"mode"`
	Filename    *string `json:"filename"`
	ContentType *string `json:"contentType"`
	SHA256      *string `json:"sha256"`
	Data        *string `json:"data"`
	fileID      *uuid.UUID
	content     []byte
}

type brandingEntry struct {
	Identity brandingIdentity     `json:"identity"`
	Colors   brandingColors       `json:"colors"`
	Imprint  brandingLegal        `json:"imprint"`
	Privacy  brandingLegal        `json:"privacy"`
	Assets   []brandingAssetEntry `json:"assets"`
}

const brandingItem = "Identity, colors and legal pages"

func brandingSection() section {
	definition := define(
		SectionBranding,
		permissions(authorization.BrandingManage),
		permissions(authorization.BrandingManage),
		exportBranding,
		validateBranding,
		applyBranding,
	)
	definition.attach = func(ctx context.Context, fileService *files.Service, value any) (any, error) {
		entry, ok := value.(brandingEntry)
		if !ok {
			return nil, fmt.Errorf("branding export is %T", value)
		}
		for i := range entry.Assets {
			if entry.Assets[i].fileID == nil {
				continue
			}
			data, err := readStoredFile(ctx, fileService, *entry.Assets[i].fileID)
			if err != nil {
				return nil, err
			}
			entry.Assets[i].Data = &data
		}
		return entry, nil
	}
	return definition
}

func exportBranding(ctx context.Context, q *configtransferdb.Queries) (brandingEntry, error) {
	row, err := q.GetBrandingConfiguration(ctx)
	if err != nil {
		return brandingEntry{}, err
	}
	overrides, err := q.ListBrandingAssetOverrides(ctx)
	if err != nil {
		return brandingEntry{}, err
	}
	bySlot := map[string]configtransferdb.ListBrandingAssetOverridesRow{}
	for _, override := range overrides {
		bySlot[override.Slot] = override
	}
	entry := brandingEntry{
		Identity: brandingIdentity{
			LegalOrganizationName: row.LegalOrganizationName,
			DisplayName:           row.DisplayName,
			ApplicationName:       row.ApplicationName,
			Tagline:               row.Tagline,
			FunGreetings:          ptr(append([]string{}, row.FunGreetings...)),
			FunGreetingShare:      ptr(int(row.FunGreetingShare)),
		},
		Colors: brandingColors{
			Primary:    row.PrimaryColor,
			Secondary:  row.SecondaryColor,
			Accent:     row.AccentColor,
			Background: row.BackgroundColor,
		},
		Imprint: brandingLegal{Mode: row.ImprintMode, Markdown: row.ImprintMarkdown, ExternalURL: row.ImprintExternalUrl},
		Privacy: brandingLegal{Mode: row.PrivacyMode, Markdown: row.PrivacyMarkdown, ExternalURL: row.PrivacyExternalUrl},
		Assets:  make([]brandingAssetEntry, 0, len(branding.Slots())),
	}
	for _, slot := range branding.Slots() {
		asset := brandingAssetEntry{Slot: string(slot), Mode: string(branding.AssetDefault)}
		if override, ok := bySlot[string(slot)]; ok {
			asset.Mode = override.Mode
			if override.FileID != nil {
				asset.Filename, asset.ContentType = override.OriginalFilename, override.ContentType
				asset.SHA256 = ptr(hex.EncodeToString(override.Sha256))
				asset.fileID = override.FileID
			}
		}
		entry.Assets = append(entry.Assets, asset)
	}
	return entry, nil
}

func validateBranding(entry *brandingEntry) error {
	seen := map[string]bool{}
	for i := range entry.Assets {
		asset := &entry.Assets[i]
		if _, err := branding.ParseSlot(asset.Slot); err != nil || seen[asset.Slot] {
			return errors.New("branding asset slots must be known and unique")
		}
		seen[asset.Slot] = true
		switch branding.AssetMode(asset.Mode) {
		case branding.AssetDefault, branding.AssetNone:
			asset.Filename, asset.ContentType, asset.SHA256, asset.Data = nil, nil, nil, nil
		case branding.AssetCustom:
			if asset.SHA256 == nil || asset.Filename == nil || strings.TrimSpace(*asset.Filename) == "" {
				return fmt.Errorf("the custom %s asset needs a filename and sha256", asset.Slot)
			}
			content, err := decodeContent(asset.Data, *asset.SHA256)
			if err != nil {
				return fmt.Errorf("the custom %s asset is invalid: %w", asset.Slot, err)
			}
			asset.content = content
			asset.SHA256 = ptr(strings.ToLower(*asset.SHA256))
		default:
			return fmt.Errorf("the %s asset mode is invalid", asset.Slot)
		}
	}
	return nil
}

func brandingInput(entry *brandingEntry) branding.ConfigurationInput {
	return branding.ConfigurationInput{
		Identity: branding.Identity{
			LegalOrganizationName: entry.Identity.LegalOrganizationName,
			DisplayName:           entry.Identity.DisplayName,
			ApplicationName:       entry.Identity.ApplicationName,
			Tagline:               entry.Identity.Tagline,
			FunGreetings:          derefSlice(entry.Identity.FunGreetings),
			FunGreetingShare:      derefInt(entry.Identity.FunGreetingShare),
		},
		Colors: branding.Colors{
			Primary:    entry.Colors.Primary,
			Secondary:  entry.Colors.Secondary,
			Accent:     entry.Colors.Accent,
			Background: entry.Colors.Background,
		},
		Imprint: branding.Legal{
			Mode:        branding.LegalMode(entry.Imprint.Mode),
			Markdown:    entry.Imprint.Markdown,
			ExternalURL: entry.Imprint.ExternalURL,
		},
		Privacy: branding.Legal{
			Mode:        branding.LegalMode(entry.Privacy.Mode),
			Markdown:    entry.Privacy.Markdown,
			ExternalURL: entry.Privacy.ExternalURL,
		},
	}
}

// brandingInputFrom fills the greeting fields an older export leaves out from the current configuration,
// so an import never wipes them.
func completeBrandingEntry(entry *brandingEntry, current brandingEntry) {
	if entry.Identity.FunGreetings == nil {
		entry.Identity.FunGreetings = current.Identity.FunGreetings
	}
	if entry.Identity.FunGreetingShare == nil {
		entry.Identity.FunGreetingShare = current.Identity.FunGreetingShare
	}
}

func derefSlice(value *[]string) []string {
	if value == nil {
		return nil
	}
	return *value
}

func derefInt(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

func sameBrandingConfiguration(current, desired brandingEntry) bool {
	a, b := current.Identity, desired.Identity
	identity := a.LegalOrganizationName == strings.TrimSpace(b.LegalOrganizationName) &&
		a.DisplayName == strings.TrimSpace(b.DisplayName) && a.ApplicationName == strings.TrimSpace(b.ApplicationName) &&
		sameText(a.Tagline, trimmed(b.Tagline)) &&
		(b.FunGreetings == nil || slices.Equal(derefSlice(a.FunGreetings), derefSlice(b.FunGreetings))) &&
		(b.FunGreetingShare == nil || derefInt(a.FunGreetingShare) == derefInt(b.FunGreetingShare))
	colors := strings.EqualFold(current.Colors.Primary, desired.Colors.Primary) &&
		strings.EqualFold(current.Colors.Secondary, desired.Colors.Secondary) &&
		strings.EqualFold(current.Colors.Accent, desired.Colors.Accent) &&
		strings.EqualFold(current.Colors.Background, desired.Colors.Background)
	return identity && colors && current.Imprint == desired.Imprint && current.Privacy == desired.Privacy
}

func brandingVersion(ctx context.Context, tx pgx.Tx) (int64, error) {
	row, err := configtransferdb.New(tx).GetBrandingConfiguration(ctx)
	return row.Version, err
}

func applyBranding(r *run, entry *brandingEntry) (func() error, error) {
	if r.mode == ModeInsert {
		r.skip(brandingItem, reasonSingleton)
		return nil, nil
	}
	current, err := exportBranding(r.ctx, r.q)
	if err != nil {
		return nil, err
	}
	completeBrandingEntry(entry, current)
	if sameBrandingConfiguration(current, *entry) {
		r.skip(brandingItem, reasonUnchanged)
	} else if _, err := r.attempt(brandingItem, ActionUpdate, "", func(tx pgx.Tx) error {
		input := brandingInput(entry)
		version, err := brandingVersion(r.ctx, tx)
		if err != nil {
			return err
		}
		input.ExpectedVersion = version
		_, err = r.svc.Branding.UpdateTx(r.ctx, tx, r.p, input, r.requestID)
		return err
	}); err != nil {
		return nil, err
	}
	stored := map[string]brandingAssetEntry{}
	for _, asset := range current.Assets {
		stored[asset.Slot] = asset
	}
	for _, asset := range entry.Assets {
		name := "Asset: " + asset.Slot
		now := stored[asset.Slot]
		if now.Mode == asset.Mode && sameText(now.SHA256, asset.SHA256) {
			r.skip(name, reasonUnchanged)
			continue
		}
		if _, err := r.attempt(name, ActionUpdate, "", func(tx pgx.Tx) error {
			return r.setBrandingAsset(tx, asset)
		}); err != nil {
			return nil, err
		}
	}
	return nil, nil
}

func (r *run) setBrandingAsset(tx pgx.Tx, asset brandingAssetEntry) error {
	slot := branding.Slot(asset.Slot)
	mode := branding.AssetMode(asset.Mode)
	var fileID *uuid.UUID
	if mode == branding.AssetCustom {
		data, contentType, err := branding.ValidateAsset(slot, bytes.NewReader(asset.content))
		if err != nil {
			return err
		}
		if r.dryRun {
			return nil // the preview validates assets without storing them
		}
		stored, cleanup, err := r.svc.Files.StoreReaderInTransaction(
			r.ctx, tx, r.p, *asset.Filename, contentType, bytes.NewReader(data),
			storage.Metadata{Size: int64(len(data)), SHA256: sha256.Sum256(data)}, r.requestID,
		)
		if err != nil {
			return err
		}
		r.cleanups = append(r.cleanups, cleanup)
		fileID = &stored.ID
	}
	version, err := brandingVersion(r.ctx, tx)
	if err != nil {
		return err
	}
	old, err := r.svc.Branding.SetAssetTx(r.ctx, tx, r.p, slot, version, mode, fileID, r.requestID)
	if err != nil {
		return err
	}
	if old != nil && (fileID == nil || *old != *fileID) {
		replaced := *old
		r.afterCommit = append(r.afterCommit, func(ctx context.Context) {
			_ = r.svc.Files.Delete(ctx, r.p, replaced, r.requestID)
		})
	}
	return nil
}

// Lab Rules (Laborordnung): published versions by revision, with their PDF. The export carries the version in force
// and later published ones. Versions are immutable evidence: existing ones are never changed or deleted.

type labRulesVersionEntry struct {
	Revision    string    `json:"revision"`
	EffectiveAt time.Time `json:"effectiveAt"`
	Filename    string    `json:"filename"`
	SHA256      string    `json:"sha256"`
	Data        *string   `json:"data"`
	fileID      uuid.UUID
	content     []byte
}

type labRulesData struct {
	Versions []labRulesVersionEntry `json:"versions"`
}

func labRulesSection() section {
	definition := define(
		SectionLabRules,
		permissions(authorization.LaborordnungRead),
		permissions(authorization.LaborordnungManage),
		exportLabRules,
		func(data *labRulesData) error {
			if data.Versions == nil {
				data.Versions = []labRulesVersionEntry{}
			}
			names := make([]*string, len(data.Versions))
			for i := range data.Versions {
				version := &data.Versions[i]
				names[i] = &version.Revision
				version.Filename = strings.TrimSpace(version.Filename)
				if version.Filename == "" || version.EffectiveAt.IsZero() {
					return fmt.Errorf("lab rules version %q needs a filename and effectiveAt", version.Revision)
				}
				content, err := decodeContent(version.Data, version.SHA256)
				if err != nil {
					return fmt.Errorf("lab rules version %q is invalid: %w", version.Revision, err)
				}
				version.content = content
				version.SHA256 = strings.ToLower(version.SHA256)
			}
			return checkNames("Lab Rules version", names, 100)
		},
		applyLabRules,
	)
	definition.attach = func(ctx context.Context, fileService *files.Service, value any) (any, error) {
		data, ok := value.(labRulesData)
		if !ok {
			return nil, fmt.Errorf("lab rules export is %T", value)
		}
		for i := range data.Versions {
			content, err := readStoredFile(ctx, fileService, data.Versions[i].fileID)
			if err != nil {
				return nil, err
			}
			data.Versions[i].Data = &content
		}
		return data, nil
	}
	return definition
}

func exportLabRules(ctx context.Context, q *configtransferdb.Queries) (labRulesData, error) {
	current, err := q.GetCurrentLabRulesEffectiveAt(ctx)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return labRulesData{}, err
	}
	rows, err := q.ListLabRulesVersions(ctx)
	if err != nil {
		return labRulesData{}, err
	}
	data := labRulesData{Versions: []labRulesVersionEntry{}}
	for _, row := range rows {
		if row.Status != string(laborordnung.VersionPublished) || !row.EffectiveAt.Valid ||
			(current.Valid && row.EffectiveAt.Time.Before(current.Time)) {
			continue
		}
		data.Versions = append(data.Versions, labRulesVersionEntry{
			Revision:    row.HumanRevision,
			EffectiveAt: row.EffectiveAt.Time.UTC(),
			Filename:    row.OriginalFilename,
			SHA256:      hex.EncodeToString(row.PdfSha256),
			fileID:      row.PdfFileID,
		})
	}
	return data, nil
}

func applyLabRules(r *run, data *labRulesData) (func() error, error) {
	rows, err := r.q.ListLabRulesVersions(r.ctx)
	if err != nil {
		return nil, err
	}
	existing := map[string]configtransferdb.ListLabRulesVersionsRow{}
	for _, row := range rows {
		existing[nameKey(row.HumanRevision)] = row
	}
	inFile := map[string]bool{}
	for _, version := range data.Versions {
		inFile[nameKey(version.Revision)] = true
		current, found := existing[nameKey(version.Revision)]
		switch {
		case found && hex.EncodeToString(current.PdfSha256) == version.SHA256:
			r.skip(version.Revision, reasonUnchanged)
		case found && r.mode == ModeInsert:
			r.skip(version.Revision, reasonExists)
		case found:
			r.conflict(version.Revision, "laborordnung_version_immutable",
				"A Lab Rules version with this revision and a different PDF exists; versions cannot be changed.")
		default:
			if _, err := r.attempt(version.Revision, ActionCreate, "Published for its effective time.", func(tx pgx.Tx) error {
				if r.dryRun {
					return laborordnung.ValidatePDF(version.content)
				}
				created, cleanup, err := r.svc.LabRules.CreateVersionTx(
					r.ctx, tx, r.p, version.Revision, version.Filename, version.content, r.requestID,
				)
				if err != nil {
					return err
				}
				r.cleanups = append(r.cleanups, cleanup)
				_, err = r.svc.LabRules.PublishTx(r.ctx, tx, r.p, created.ID, version.EffectiveAt, r.requestID)
				return err
			}); err != nil {
				return nil, err
			}
		}
	}
	return func() error {
		for _, row := range rows {
			if !inFile[nameKey(row.HumanRevision)] {
				r.keep(row.HumanRevision, "Lab Rules versions are immutable evidence and are never deleted.")
			}
		}
		return nil
	}, nil
}
