package integration_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/branding"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
)

func TestBrandingConfigurationAssetsAndAuditLifecycle(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	account := seedAccount(t, pool, "branding-admin", false)
	admin := authorization.Principal{AccountID: account.accountID, PersonID: account.personID, Master: true}
	unauthorized := authorization.Principal{AccountID: account.accountID, PersonID: account.personID}
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fileService := files.NewService(pool, store)
	service := branding.NewService(pool, fileService)

	initial, err := service.GetPublic(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if initial.Version != 1 || initial.Identity.ApplicationName != "HTU Graz Makerspace" || initial.Assets[branding.Logo].Mode != "default" || initial.Assets[branding.Logo].URL == nil {
		t.Fatalf("unexpected defaults: %#v", initial)
	}
	if initial.Imprint.Mode != "internal" || initial.Imprint.Markdown != "" || initial.Privacy.Mode != "internal" || initial.Privacy.Markdown != "" {
		t.Fatalf("unexpected legal defaults: imprint=%#v privacy=%#v", initial.Imprint, initial.Privacy)
	}
	if _, err := service.Get(ctx, unauthorized); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("unprivileged configuration read: %v", err)
	}

	input := branding.ConfigurationInput{
		Identity:        branding.Identity{LegalOrganizationName: "Example Association", DisplayName: "Open Workshop", ApplicationName: "Workshop Portal"},
		Colors:          branding.Colors{Primary: "#123456", Secondary: "#abcdef", Accent: "#fedcba", Background: "#101820"},
		Imprint:         branding.Legal{Mode: "internal", Markdown: "# Internal imprint", ExternalURL: "https://draft.example.test/imprint"},
		Privacy:         branding.Legal{Mode: "external", Markdown: "# Private inactive draft", ExternalURL: "https://example.test/privacy"},
		ExpectedVersion: initial.Version,
	}
	updated, err := service.Update(ctx, admin, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != 2 || updated.Identity.ApplicationName != "Workshop Portal" {
		t.Fatalf("unexpected update: %#v", updated)
	}
	if _, err := service.Update(ctx, admin, input, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale update: %v", err)
	}
	imprint, err := service.PublicLegal(ctx, "imprint")
	if err != nil {
		t.Fatal(err)
	}
	privacy, err := service.PublicLegal(ctx, "privacy")
	if err != nil {
		t.Fatal(err)
	}
	if imprint.Markdown == nil || imprint.ExternalURL != nil || privacy.Markdown != nil || privacy.ExternalURL == nil {
		t.Fatalf("inactive legal representation leaked: imprint=%#v privacy=%#v", imprint, privacy)
	}

	var changedFields []string
	var metadata string
	if err := pool.QueryRow(ctx, `SELECT changed_fields, metadata::text FROM audit_events WHERE action='branding.configuration_updated' ORDER BY occurred_at DESC LIMIT 1`).Scan(&changedFields, &metadata); err != nil {
		t.Fatal(err)
	}
	if len(changedFields) != 4 || metadata != "{}" || strings.Contains(metadata, "example.test") || strings.Contains(metadata, "Internal imprint") {
		t.Fatalf("unsafe audit payload: fields=%v metadata=%s", changedFields, metadata)
	}

	imageBytes := encodeBrandingPNG(t, 32, 24)
	custom, err := service.PutAsset(ctx, admin, branding.Logo, updated.Version, "private-logo-name.png", bytes.NewReader(imageBytes), nil)
	if err != nil {
		t.Fatal(err)
	}
	asset := custom.Assets[branding.Logo]
	if custom.Version != 3 || asset.Mode != "custom" || asset.URL == nil || asset.ContentType == nil || *asset.ContentType != "image/png" {
		t.Fatalf("unexpected custom asset: configuration=%#v asset=%#v", custom, asset)
	}
	digest := (*asset.URL)[strings.LastIndex(*asset.URL, "/")+1:]
	publicAsset, err := service.OpenPublicAsset(ctx, branding.Logo, digest)
	if err != nil {
		t.Fatal(err)
	}
	served, err := io.ReadAll(publicAsset.Reader)
	publicAsset.Reader.Close()
	if err != nil || !bytes.Equal(served, imageBytes) {
		t.Fatal("public asset bytes do not match the linked upload")
	}
	storageKey := publicAsset.File.StorageKey

	removed, err := service.RemoveAsset(ctx, admin, branding.Logo, custom.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	if removed.Version != 4 || removed.Assets[branding.Logo].Mode != "none" || removed.Assets[branding.Logo].URL != nil {
		t.Fatalf("unexpected removed asset: %#v", removed.Assets[branding.Logo])
	}
	if _, err := service.OpenPublicAsset(ctx, branding.Logo, digest); !apperror.IsCode(err, "not_found") {
		t.Fatalf("former digest remains public: %v", err)
	}
	if _, err := store.Metadata(ctx, storageKey); err == nil {
		t.Fatal("replaced file blob was not hard-deleted")
	}
	assertCount(t, pool, `SELECT count(*) FROM files WHERE id=$1`, 0, publicAsset.File.ID)

	restored, err := service.RestoreDefaultAsset(ctx, admin, branding.Logo, removed.Version, nil)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Version != 5 || restored.Assets[branding.Logo].Mode != "default" || restored.Assets[branding.Logo].URL == nil {
		t.Fatalf("default was not restored: %#v", restored.Assets[branding.Logo])
	}

	if _, err := pool.Exec(ctx, `CREATE FUNCTION reject_branding_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='branding.configuration_updated' THEN RAISE EXCEPTION 'forced branding audit failure'; END IF; RETURN NEW; END; $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER reject_branding_audit_insert BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_branding_audit()`); err != nil {
		t.Fatal(err)
	}
	input.ExpectedVersion = restored.Version
	input.Identity.DisplayName = "Must roll back"
	if _, err := service.Update(ctx, admin, input, nil); err == nil {
		t.Fatal("configuration committed despite audit failure")
	}
	afterFailure, err := service.GetPublic(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if afterFailure.Version != restored.Version || afterFailure.Identity.DisplayName == "Must roll back" {
		t.Fatalf("audit failure did not roll back configuration: %#v", afterFailure)
	}
}

func TestBrandingPublicHTTPAndAdministrativeAuthentication(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	cfg.LocalStorageRoot = t.TempDir()
	account := seedAccount(t, pool, "branding-http", false)
	principal := authorization.Principal{AccountID: account.accountID, PersonID: account.personID, Master: true}
	sharedStore, err := storage.NewLocal(cfg.LocalStorageRoot)
	if err != nil {
		t.Fatal(err)
	}
	service := branding.NewService(pool, files.NewService(pool, sharedStore))
	linked, err := service.PutAsset(ctx, principal, branding.Favicon, 1, "favicon.png", bytes.NewReader(encodeBrandingPNG(t, 16, 16)), nil)
	if err != nil {
		t.Fatal(err)
	}
	faviconURL := *linked.Assets[branding.Favicon].URL
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	response, err := http.Get(server.URL + "/api/v1/public/config") // #nosec G107 -- local integration server
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, response, http.StatusOK)
	if response.Header.Get("Cache-Control") != "no-cache" {
		t.Fatalf("public configuration cache header = %q", response.Header.Get("Cache-Control"))
	}
	var public map[string]any
	decodeResponse(t, response, &public)
	if public["version"] != float64(2) || public["updatedAt"] != nil || public["imprint"] != nil || public["privacy"] != nil {
		t.Fatalf("administrative fields leaked publicly: %#v", public)
	}
	if _, ok := public["identity"].(map[string]any); !ok {
		t.Fatalf("public identity missing: %#v", public)
	}

	response, err = http.Get(server.URL + faviconURL) // #nosec G107 -- local integration server
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, response, http.StatusOK)
	if response.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" || response.Header.Get("ETag") == "" || response.Header.Get("X-Content-Type-Options") != "nosniff" || response.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("immutable asset headers missing: %#v", response.Header)
	}
	response.Body.Close()

	response, err = http.Get(server.URL + "/api/v1/public/legal/imprint") // #nosec G107 -- local integration server
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, response, http.StatusOK)
	var legal map[string]any
	decodeResponse(t, response, &legal)
	if legal["mode"] != "internal" || legal["markdown"] != "" || legal["externalUrl"] != nil {
		t.Fatalf("unexpected default public legal response: %#v", legal)
	}

	response, err = http.Get(server.URL + "/api/v1/branding/configuration") // #nosec G107 -- local integration server
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, response, http.StatusUnauthorized)
	response.Body.Close()
}

func encodeBrandingPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	var result bytes.Buffer
	if err := png.Encode(&result, image.NewRGBA(image.Rect(0, 0, width, height))); err != nil {
		t.Fatal(err)
	}
	return result.Bytes()
}

func decodeJSONBody(t *testing.T, body io.Reader) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.NewDecoder(body).Decode(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
