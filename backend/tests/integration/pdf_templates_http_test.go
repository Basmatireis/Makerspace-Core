package integration_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	pdfread "github.com/ledongthuc/pdf"
)

const pdfTemplatesOrigin = "http://makerspace.example.test"

type pdfTemplatesHTTP struct {
	t      *testing.T
	pool   *pgxpool.Pool
	server *httptest.Server
	cfg    config.Config
	master apiSession
	seq    int
}

// apiSession is a signed-in client of the test server.
type apiSession struct {
	h      *pdfTemplatesHTTP
	client *http.Client
	csrf   string
}

func newPDFTemplatesHTTP(t *testing.T) *pdfTemplatesHTTP {
	t.Helper()
	// jsonb documents are sent as byte slices, which the simple protocol of the default test pool cannot encode.
	pool := migratedPoolMode(t, pgx.QueryExecModeCacheStatement)
	const (
		adminLogin    = "pdf-templates-admin@example.test"
		adminPassword = "PDF templates workshop password 64"
	)
	if _, err := admin.NewService(pool).BootstrapMaster(testContext(t), admin.BootstrapInput{
		FirstName: "Template", LastName: "Admin", LoginEmail: adminLogin, Password: adminPassword,
	}); err != nil {
		t.Fatal(err)
	}
	baseURL, err := url.Parse(pdfTemplatesOrigin)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		PublicBaseURL: baseURL, SessionCookieName: "makerspace_session", CSRFCookieName: "makerspace_csrf",
		SessionIdleTTL: 6 * time.Hour, SessionAbsoluteTTL: 72 * time.Hour, PasswordResetTTL: 30 * time.Minute,
		MakerspaceTimeZone: "Europe/Vienna",
	}
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	h := &pdfTemplatesHTTP{t: t, pool: pool, server: server, cfg: cfg}
	h.master = h.login(adminLogin, adminPassword)
	return h
}

func (h *pdfTemplatesHTTP) login(email, password string) apiSession {
	h.t.Helper()
	client := newCookieClient(h.t)
	response := doJSON(h.t, client, http.MethodPost, h.server.URL+"/api/v1/auth/login", pdfTemplatesOrigin, "",
		map[string]any{"email": email, "password": password})
	assertStatus(h.t, response, http.StatusNoContent)
	response.Body.Close()
	return apiSession{h: h, client: client, csrf: cookieValue(h.t, client, h.server.URL, h.cfg.CSRFCookieName)}
}

// member signs in as a new person whose role grants exactly the given permissions (and signing in).
func (h *pdfTemplatesHTTP) member(permissions ...string) apiSession {
	h.t.Helper()
	h.seq++
	suffix := string(rune('a'+h.seq)) + "-" + ids.New().String()[:8]
	email, password := "pdf-"+suffix+"@example.test", "PDF member "+suffix+" workshop password 77"
	var person openapi.Person
	response := h.master.call(http.MethodPost, "/people", map[string]any{
		"firstName": "Pdf", "lastName": suffix, "email": "contact-" + email,
	})
	assertStatus(h.t, response, http.StatusCreated)
	decodeResponse(h.t, response, &person)
	var account openapi.Account
	response = h.master.call(http.MethodPost, "/people/"+person.Id.String()+"/account",
		map[string]any{"loginEmail": email, "expectedVersion": person.Version})
	assertStatus(h.t, response, http.StatusCreated)
	decodeResponse(h.t, response, &account)
	response = h.master.call(http.MethodPut, "/accounts/"+account.Id.String()+"/password",
		map[string]any{"newPassword": password, "expectedVersion": account.Version})
	assertStatus(h.t, response, http.StatusOK)
	decodeResponse(h.t, response, &account)
	response = h.master.call(http.MethodPost, "/accounts/"+account.Id.String()+"/enable",
		map[string]any{"expectedVersion": account.Version})
	assertStatus(h.t, response, http.StatusOK)
	response.Body.Close()
	grants := []map[string]any{}
	for _, permission := range append([]string{"web.sign_in"}, permissions...) {
		grants = append(grants, map[string]any{
			"permissionId": permission, "scope": "everywhere", "deviceTypeIds": []string{}, "minimumAssurance": "low",
		})
	}
	var role openapi.Role
	response = h.master.call(http.MethodPost, "/roles",
		map[string]any{"name": "PDF " + suffix, "description": "Test role", "permissionGrants": grants})
	assertStatus(h.t, response, http.StatusCreated)
	decodeResponse(h.t, response, &role)
	response = h.master.call(http.MethodGet, "/people/"+person.Id.String(), nil)
	assertStatus(h.t, response, http.StatusOK)
	decodeResponse(h.t, response, &person)
	response = h.master.call(http.MethodPut, "/people/"+person.Id.String()+"/roles/"+role.Id.String(),
		map[string]any{"expectedVersion": person.Version})
	assertStatus(h.t, response, http.StatusOK)
	response.Body.Close()
	return h.login(email, password)
}

// call sends a JSON request below /api/v1.
func (s apiSession) call(method, path string, body any) *http.Response {
	s.h.t.Helper()
	return doJSON(s.h.t, s.client, method, s.h.server.URL+"/api/v1"+path, pdfTemplatesOrigin, s.csrf, body)
}

// callRaw sends a binary request body below /api/v1.
func (s apiSession) callRaw(method, path, contentType string, data []byte) *http.Response {
	s.h.t.Helper()
	request, err := http.NewRequestWithContext(testContext(s.h.t), method, s.h.server.URL+"/api/v1"+path, bytes.NewReader(data))
	if err != nil {
		s.h.t.Fatal(err)
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Origin", pdfTemplatesOrigin)
	request.Header.Set("X-CSRF-Token", s.csrf)
	response, err := s.client.Do(request)
	if err != nil {
		s.h.t.Fatal(err)
	}
	return response
}

func errorCodeOf(t *testing.T, response *http.Response) string {
	t.Helper()
	var refused openapi.Error
	decodeResponse(t, response, &refused)
	return refused.Code
}

func (s apiSession) expectError(method, path string, body any, status int, code string) {
	s.h.t.Helper()
	response := s.call(method, path, body)
	assertStatus(s.h.t, response, status)
	if got := errorCodeOf(s.h.t, response); got != code {
		s.h.t.Fatalf("%s %s: code %q, want %q", method, path, got, code)
	}
}

// builtinDocument is the built-in default of an export as the editor receives it.
func (s apiSession) builtinDocument(kind string) map[string]any {
	s.h.t.Helper()
	response := s.call(http.MethodGet, "/pdf-templates/"+kind, nil)
	assertStatus(s.h.t, response, http.StatusOK)
	var detail openapi.PdfTemplateDetail
	decodeResponse(s.h.t, response, &detail)
	return detail.Builtin
}

// documentWith is the built-in template of an export with its content replaced by the given body blocks.
func (s apiSession) documentWith(kind, name string, body ...map[string]any) map[string]any {
	s.h.t.Helper()
	doc := s.builtinDocument(kind)
	doc["name"] = name
	doc["layers"], doc["header"], doc["footer"] = []any{}, []any{}, []any{}
	if body == nil {
		body = []map[string]any{}
	}
	doc["body"] = body
	return doc
}

func textBlock(id, text string) map[string]any {
	return map[string]any{"id": id, "type": "text", "text": text}
}

func pdfText(t *testing.T, data []byte) string {
	t.Helper()
	reader, err := pdfread.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("read pdf: %v", err)
	}
	var out strings.Builder
	for i := 1; i <= reader.NumPage(); i++ {
		for _, c := range reader.Page(i).Content().Text {
			out.WriteString(c.S)
		}
	}
	return strings.Join(strings.Fields(out.String()), "")
}

func squash(text string) string { return strings.Join(strings.Fields(text), "") }

func (s apiSession) saveDraft(kind string, doc map[string]any, revision *int) openapi.PdfTemplateDraftResult {
	s.h.t.Helper()
	body := map[string]any{"document": doc}
	if revision != nil {
		body["expectedRevision"] = *revision
	}
	response := s.call(http.MethodPut, "/pdf-templates/"+kind+"/draft", body)
	assertStatus(s.h.t, response, http.StatusOK)
	var result openapi.PdfTemplateDraftResult
	decodeResponse(s.h.t, response, &result)
	return result
}

func (s apiSession) publish(kind string, revision int) openapi.PdfTemplateVersion {
	s.h.t.Helper()
	response := s.call(http.MethodPost, "/pdf-templates/"+kind+"/publish", map[string]any{"expectedRevision": revision})
	assertStatus(s.h.t, response, http.StatusOK)
	var version openapi.PdfTemplateVersion
	decodeResponse(s.h.t, response, &version)
	return version
}

func TestPDFTemplateVersionLifecycleOverHTTP(t *testing.T) {
	h := newPDFTemplatesHTTP(t)
	admin := h.master

	response := admin.call(http.MethodGet, "/pdf-templates", nil)
	assertStatus(t, response, http.StatusOK)
	assertNoStoreAndRequestID(t, response)
	var summaries []openapi.PdfTemplateSummary
	decodeResponse(t, response, &summaries)
	if len(summaries) != 3 || summaries[0].Export != "wiref" || !summaries[0].Draft.IsNull() || !summaries[0].Published.IsNull() {
		t.Fatalf("summaries = %+v", summaries)
	}

	response = admin.call(http.MethodGet, "/pdf-templates/wiref", nil)
	assertStatus(t, response, http.StatusOK)
	var detail openapi.PdfTemplateDetail
	decodeResponse(t, response, &detail)
	if !detail.Draft.IsNull() || !detail.Published.IsNull() || detail.Builtin["export"] != "wiref" ||
		len(detail.Schema.Groups) == 0 || len(detail.Schema.Filters) == 0 || len(detail.PreviewSources) != 0 {
		t.Fatalf("detail = %+v", detail)
	}
	admin.expectError(http.MethodGet, "/pdf-templates/letter", nil, http.StatusBadRequest, "invalid_request")

	// A first draft needs no revision, a later save needs the current one.
	doc := detail.Builtin
	first := admin.saveDraft("wiref", doc, nil)
	if first.Version.Version != 1 || first.Version.Revision != 1 || first.Version.State != "draft" ||
		len(first.Problems) != 0 {
		t.Fatalf("first draft = %+v", first)
	}
	admin.expectError(http.MethodPut, "/pdf-templates/wiref/draft", map[string]any{"document": doc},
		http.StatusConflict, "stale_write")
	admin.expectError(http.MethodPut, "/pdf-templates/wiref/draft", map[string]any{"document": doc, "expectedRevision": 7},
		http.StatusConflict, "stale_write")
	revision := first.Version.Revision
	second := admin.saveDraft("wiref", doc, &revision)
	if second.Version.Revision != 2 || second.Version.Id != first.Version.Id {
		t.Fatalf("second save = %+v", second)
	}

	// Structurally invalid documents are refused with their violations; problems only come back with the draft.
	response = admin.call(http.MethodPut, "/pdf-templates/wiref/draft",
		map[string]any{"document": map[string]any{"schemaVersion": 1, "bogus": true}, "expectedRevision": 2})
	assertStatus(t, response, http.StatusUnprocessableEntity)
	var refused openapi.Error
	decodeResponse(t, response, &refused)
	if refused.Code != "pdf_template_invalid" || refused.Details == nil {
		t.Fatalf("refusal = %+v", refused)
	}
	admin.expectError(http.MethodPut, "/pdf-templates/wiref/draft",
		map[string]any{"document": admin.documentWith("receipt", "Foreign"), "expectedRevision": 2},
		http.StatusUnprocessableEntity, "pdf_template_export_mismatch")

	broken := admin.documentWith("wiref", "Broken", textBlock("b1", "Hello {{no.such.variable}}"))
	revision = 2
	saved := admin.saveDraft("wiref", broken, &revision)
	if len(saved.Problems) != 1 || saved.Problems[0].NodeId != "b1" || saved.Problems[0].Severity != "error" {
		t.Fatalf("problems = %+v", saved.Problems)
	}
	admin.expectError(http.MethodPost, "/pdf-templates/wiref/publish", map[string]any{"expectedRevision": saved.Version.Revision},
		http.StatusUnprocessableEntity, "pdf_template_has_problems")

	good := admin.documentWith("wiref", "Version one", textBlock("g1", "First {{request.number}}"))
	revision = saved.Version.Revision
	saved = admin.saveDraft("wiref", good, &revision)
	if len(saved.Problems) != 0 {
		t.Fatalf("problems = %+v", saved.Problems)
	}
	admin.expectError(http.MethodPost, "/pdf-templates/wiref/publish", map[string]any{"expectedRevision": saved.Version.Revision - 1},
		http.StatusConflict, "stale_write")
	published := admin.publish("wiref", saved.Version.Revision)
	if published.State != "published" || published.Version != 1 || published.PublishedAt.IsNull() {
		t.Fatalf("published = %+v", published)
	}
	admin.expectError(http.MethodPost, "/pdf-templates/wiref/publish", map[string]any{"expectedRevision": 1},
		http.StatusNotFound, "not_found")

	// A new draft gets the next number; publishing it archives the previous version.
	next := admin.documentWith("wiref", "Version two", textBlock("g2", "Second {{request.number}}"))
	secondDraft := admin.saveDraft("wiref", next, nil)
	if secondDraft.Version.Version != 2 {
		t.Fatalf("second draft = %+v", secondDraft.Version)
	}
	response = admin.call(http.MethodGet, "/pdf-templates/wiref", nil)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &detail)
	publishedNow, err := detail.Published.Get()
	if err != nil || publishedNow.Version != 1 || publishedNow.Document["name"] != "Version one" || detail.Draft.IsNull() {
		t.Fatalf("detail = %+v", detail)
	}
	admin.publish("wiref", secondDraft.Version.Revision)
	response = admin.call(http.MethodGet, "/pdf-templates/wiref/versions", nil)
	assertStatus(t, response, http.StatusOK)
	var versions []openapi.PdfTemplateVersionMeta
	decodeResponse(t, response, &versions)
	if len(versions) != 2 || versions[0].Version != 2 || versions[0].State != "published" ||
		versions[1].Version != 1 || versions[1].State != "archived" {
		t.Fatalf("versions = %+v", versions)
	}
	response = admin.call(http.MethodGet, "/pdf-templates", nil)
	decodeResponse(t, response, &summaries)
	if name := summaries[0].Name; name != "Version two" || summaries[0].Published.IsNull() || !summaries[0].Draft.IsNull() {
		t.Fatalf("summary = %+v", summaries[0])
	}

	// Restoring copies an old version into the draft; the draft itself cannot be restored.
	response = admin.call(http.MethodPost, "/pdf-templates/wiref/versions/"+versions[1].Id.String()+"/restore", nil)
	assertStatus(t, response, http.StatusOK)
	var restored openapi.PdfTemplateVersion
	decodeResponse(t, response, &restored)
	if restored.State != "draft" || restored.Version != 3 || restored.Document["name"] != "Version one" {
		t.Fatalf("restored = %+v", restored)
	}
	admin.expectError(http.MethodPost, "/pdf-templates/wiref/versions/"+restored.Id.String()+"/restore", nil,
		http.StatusConflict, "pdf_template_version_is_draft")
	admin.expectError(http.MethodPost, "/pdf-templates/wiref/versions/"+ids.New().String()+"/restore", nil,
		http.StatusNotFound, "not_found")
	response = admin.call(http.MethodGet, "/pdf-templates/wiref/versions/"+versions[1].Id.String(), nil)
	assertStatus(t, response, http.StatusOK)
	var archived openapi.PdfTemplateVersion
	decodeResponse(t, response, &archived)
	if archived.Document["name"] != "Version one" || archived.State != "archived" {
		t.Fatalf("archived = %+v", archived)
	}
	admin.expectError(http.MethodGet, "/pdf-templates/cashbook/versions/"+versions[1].Id.String(), nil,
		http.StatusNotFound, "not_found")

	response = admin.call(http.MethodDelete, "/pdf-templates/wiref/draft", nil)
	assertStatus(t, response, http.StatusNoContent)
	admin.expectError(http.MethodDelete, "/pdf-templates/wiref/draft", nil, http.StatusNotFound, "not_found")

	// Every mutation left an audit event that names the export and the version but never the document.
	rows, err := h.pool.Query(testContext(t), `SELECT action, metadata::text FROM audit_events WHERE action LIKE 'pdf_template%'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	actions := map[string]int{}
	for rows.Next() {
		var action, metadata string
		if err := rows.Scan(&action, &metadata); err != nil {
			t.Fatal(err)
		}
		actions[action]++
		var details map[string]string
		if err := json.Unmarshal([]byte(metadata), &details); err != nil || details["exportKind"] != "wiref" ||
			details["templateVersion"] == "" || len(details) != 2 {
			t.Fatalf("%s metadata = %s", action, metadata)
		}
		if strings.Contains(metadata, "First") || strings.Contains(metadata, "Version one") {
			t.Fatalf("%s metadata carries document content: %s", action, metadata)
		}
	}
	if actions["pdf_template.draft_saved"] != 5 || actions["pdf_template.published"] != 2 ||
		actions["pdf_template.restored"] != 1 || actions["pdf_template.draft_discarded"] != 1 {
		t.Fatalf("audit actions = %v", actions)
	}
}

func TestPDFTemplatesNeedThePermissionAndRealRecordsNeedTheExportPermission(t *testing.T) {
	h := newPDFTemplatesHTTP(t)
	nobody := h.member()
	manager := h.member("pdf_templates.manage")
	doc := h.master.builtinDocument("receipt")

	for _, call := range []struct{ method, path string }{
		{http.MethodGet, "/pdf-templates"},
		{http.MethodGet, "/pdf-templates/receipt"},
		{http.MethodGet, "/pdf-templates/receipt/versions"},
		{http.MethodGet, "/pdf-templates/assets"},
	} {
		nobody.expectError(call.method, call.path, nil, http.StatusForbidden, "permission_denied")
	}
	nobody.expectError(http.MethodPut, "/pdf-templates/receipt/draft", map[string]any{"document": doc},
		http.StatusForbidden, "permission_denied")
	nobody.expectError(http.MethodPost, "/pdf-templates/receipt/preview",
		map[string]any{"document": doc, "source": map[string]any{"kind": "sample"}},
		http.StatusForbidden, "permission_denied")

	// With the sample the manager sees every field; with a real record the export's own permission is needed too.
	response := manager.call(http.MethodPost, "/pdf-templates/receipt/preview",
		map[string]any{"document": doc, "source": map[string]any{"kind": "sample"}})
	assertStatus(t, response, http.StatusOK)
	assertNoStoreAndRequestID(t, response)
	var preview openapi.PdfTemplatePreview
	decodeResponse(t, response, &preview)
	if !bytes.HasPrefix(preview.Pdf, []byte("%PDF-")) || len(preview.Pages) == 0 || len(preview.Boxes) == 0 ||
		len(preview.Redacted) != 0 {
		t.Fatalf("sample preview = %d bytes, %d pages, %d boxes, redacted %v",
			len(preview.Pdf), len(preview.Pages), len(preview.Boxes), preview.Redacted)
	}
	// Pages of boxes count from 1, as the editor numbers them; the receipt of a whole order has no payment note.
	for _, box := range preview.Boxes {
		if box.Page < 1 || box.Page > len(preview.Pages) {
			t.Fatalf("box %+v is on page %d of %d", box, box.Page, len(preview.Pages))
		}
	}
	if preview.Inactive == nil {
		t.Fatal("inactive is missing")
	}
	for kind, source := range map[string]string{"wiref": ids.New().String(), "cashbook": "2026-10", "receipt": ids.New().String()} {
		manager.expectError(http.MethodPost, "/pdf-templates/"+kind+"/preview",
			map[string]any{"document": h.master.builtinDocument(kind), "source": map[string]any{"kind": "record", "id": source}},
			http.StatusForbidden, "permission_denied")
		response = manager.call(http.MethodGet, "/pdf-templates/"+kind, nil)
		assertStatus(t, response, http.StatusOK)
		var detail openapi.PdfTemplateDetail
		decodeResponse(t, response, &detail)
		if len(detail.PreviewSources) != 0 {
			t.Fatalf("%s: a manager without the export permission is offered records: %+v", kind, detail.PreviewSources)
		}
	}
	// Payments alone do not open the cashbook either: it needs the cash movements as well.
	partial := h.member("pdf_templates.manage", "payments.read")
	partial.expectError(http.MethodPost, "/pdf-templates/cashbook/preview",
		map[string]any{"document": h.master.builtinDocument("cashbook"), "source": map[string]any{"kind": "record", "id": "2026-10"}},
		http.StatusForbidden, "permission_denied")
	h.master.expectError(http.MethodPost, "/pdf-templates/receipt/preview",
		map[string]any{"document": doc, "source": map[string]any{"kind": "record", "id": ids.New().String()}},
		http.StatusNotFound, "not_found")
	h.master.expectError(http.MethodPost, "/pdf-templates/receipt/preview",
		map[string]any{"document": doc, "source": map[string]any{"kind": "record"}},
		http.StatusUnprocessableEntity, "validation_failed")
}

func pngBytes(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for x := range 8 {
		img.Set(x, x, color.RGBA{R: 200, A: 255})
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestPDFTemplateAssetsOverHTTP(t *testing.T) {
	h := newPDFTemplatesHTTP(t)
	admin, manager, nobody := h.master, h.member("pdf_templates.manage"), h.member()

	nobody.expectError(http.MethodPost, "/pdf-templates/assets?fileName=logo.png", nil, http.StatusForbidden, "permission_denied")
	response := nobody.callRaw(http.MethodPost, "/pdf-templates/assets?fileName=logo.png", "image/png", pngBytes(t))
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()

	response = manager.callRaw(http.MethodPost, "/pdf-templates/assets?fileName=logo.png", "image/png", pngBytes(t))
	assertStatus(t, response, http.StatusCreated)
	var asset openapi.PdfTemplateAsset
	decodeResponse(t, response, &asset)
	if asset.ContentType != "image/png" || asset.Width != 8 || asset.Height != 8 || asset.FileName != "logo.png" {
		t.Fatalf("asset = %+v", asset)
	}
	// The type comes from the content, never from the declared type or the name.
	response = manager.callRaw(http.MethodPost, "/pdf-templates/assets?fileName=notes.png", "image/png", []byte("not an image"))
	assertStatus(t, response, http.StatusUnprocessableEntity)
	if code := errorCodeOf(t, response); code != "pdf_template_asset_invalid" {
		t.Fatalf("code = %s", code)
	}
	response = manager.callRaw(http.MethodPost, "/pdf-templates/assets?fileName=",
		"image/png", pngBytes(t))
	assertStatus(t, response, http.StatusBadRequest)
	response.Body.Close()
	svg := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0H10V10H0Z"/></svg>`
	response = manager.callRaw(http.MethodPost, "/pdf-templates/assets?fileName=mark.svg", "image/svg+xml", []byte(svg))
	assertStatus(t, response, http.StatusCreated)
	var vector openapi.PdfTemplateAsset
	decodeResponse(t, response, &vector)
	if vector.ContentType != "image/svg+xml" {
		t.Fatalf("svg asset = %+v", vector)
	}

	response = manager.call(http.MethodGet, "/pdf-templates/assets", nil)
	assertStatus(t, response, http.StatusOK)
	var assets []openapi.PdfTemplateAsset
	decodeResponse(t, response, &assets)
	if len(assets) != 2 {
		t.Fatalf("assets = %+v", assets)
	}
	response = manager.call(http.MethodGet, "/pdf-templates/assets/"+asset.Id.String(), nil)
	assertStatus(t, response, http.StatusOK)
	// The stored image is a re-encoding of the upload, so it is compared by its pixels.
	stored, err := png.Decode(bytes.NewReader(readResponse(t, response)))
	if response.Header.Get("Content-Type") != "image/png" || response.Header.Get("X-Content-Type-Options") != "nosniff" ||
		!strings.Contains(response.Header.Get("Content-Security-Policy"), "default-src 'none'") ||
		err != nil || stored.Bounds().Dx() != 8 || stored.Bounds().Dy() != 8 {
		t.Fatalf("asset download headers = %v, decode error %v", response.Header, err)
	}
	nobody.expectError(http.MethodGet, "/pdf-templates/assets/"+asset.Id.String(), nil, http.StatusForbidden, "permission_denied")
	manager.expectError(http.MethodGet, "/pdf-templates/assets/"+ids.New().String(), nil, http.StatusNotFound, "not_found")

	// An image a draft uses cannot be deleted; once the draft is gone it can.
	doc := admin.documentWith("receipt", "With a picture",
		map[string]any{"id": "pic", "type": "picture", "asset": asset.Id.String(), "w": 20, "h": 20})
	draft := admin.saveDraft("receipt", doc, nil)
	if len(draft.Problems) != 0 {
		t.Fatalf("problems = %+v", draft.Problems)
	}
	manager.expectError(http.MethodDelete, "/pdf-templates/assets/"+asset.Id.String(), nil, http.StatusConflict, "pdf_template_asset_in_use")
	nobody.expectError(http.MethodDelete, "/pdf-templates/assets/"+asset.Id.String(), nil, http.StatusForbidden, "permission_denied")
	published := admin.publish("receipt", draft.Version.Revision)
	response = admin.call(http.MethodDelete, "/pdf-templates/receipt/draft", nil)
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("publishing consumed the draft, discard = %d", response.StatusCode)
	}
	response.Body.Close()
	manager.expectError(http.MethodDelete, "/pdf-templates/assets/"+asset.Id.String(), nil, http.StatusConflict, "pdf_template_asset_in_use")
	response = manager.call(http.MethodDelete, "/pdf-templates/assets/"+vector.Id.String(), nil)
	assertStatus(t, response, http.StatusNoContent)
	manager.expectError(http.MethodDelete, "/pdf-templates/assets/"+vector.Id.String(), nil, http.StatusNotFound, "not_found")

	// Archived versions do not count: after a newer version without the picture is published, it can go.
	newer := admin.saveDraft("receipt", admin.documentWith("receipt", "No picture", textBlock("t", "Plain")), nil)
	admin.publish("receipt", newer.Version.Revision)
	response = manager.call(http.MethodDelete, "/pdf-templates/assets/"+asset.Id.String(), nil)
	assertStatus(t, response, http.StatusNoContent)
	if published.State != "published" {
		t.Fatalf("published = %+v", published)
	}

	var uploaded, deleted int
	if err := h.pool.QueryRow(testContext(t), `
		SELECT count(*) FILTER (WHERE action = 'pdf_template_asset.uploaded'),
		       count(*) FILTER (WHERE action = 'pdf_template_asset.deleted')
		FROM audit_events`).Scan(&uploaded, &deleted); err != nil {
		t.Fatal(err)
	}
	if uploaded != 2 || deleted != 2 {
		t.Fatalf("asset audit events: %d uploaded, %d deleted", uploaded, deleted)
	}
}

func TestPDFTemplateUploadsDropMetadata(t *testing.T) {
	h := newPDFTemplatesHTTP(t)
	var source bytes.Buffer
	if err := jpeg.Encode(&source, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil); err != nil {
		t.Fatal(err)
	}
	payload := []byte("Exif\x00\x00GPSLatitude=47.07 camera-serial-4711")
	withEXIF := append([]byte{0xff, 0xd8, 0xff, 0xe1, byte((len(payload) + 2) >> 8), byte(len(payload) + 2)}, payload...)
	withEXIF = append(withEXIF, source.Bytes()[2:]...)
	response := h.master.callRaw(http.MethodPost, "/pdf-templates/assets?fileName=photo.jpg", "image/jpeg", withEXIF)
	assertStatus(t, response, http.StatusCreated)
	var asset openapi.PdfTemplateAsset
	decodeResponse(t, response, &asset)
	status, contentType, stored := h.master.download("/pdf-templates/assets/" + asset.Id.String())
	if status != http.StatusOK || contentType != "image/jpeg" || bytes.Contains(stored, []byte("camera-serial")) ||
		bytes.Contains(stored, []byte("GPSLatitude")) || bytes.Contains(stored, []byte("Exif")) {
		t.Fatalf("download: %d %s, metadata left in the stored image: %v", status, contentType, bytes.Contains(stored, []byte("Exif")))
	}
	if asset.ByteSize != len(stored) {
		t.Fatalf("recorded size %d, stored %d bytes", asset.ByteSize, len(stored))
	}
	var inDatabase int
	if err := h.pool.QueryRow(testContext(t),
		`SELECT count(*) FROM pdf_template_assets WHERE position('\x47505354'::bytea IN data) > 0 OR position('camera-serial'::bytea IN data) > 0`,
	).Scan(&inDatabase); err != nil || inDatabase != 0 {
		t.Fatalf("metadata in the database: %d, %v", inDatabase, err)
	}
}

func TestPublishRefusesATemplateWhoseImageIsGone(t *testing.T) {
	h := newPDFTemplatesHTTP(t)
	admin := h.master
	response := admin.callRaw(http.MethodPost, "/pdf-templates/assets?fileName=logo.png", "image/png", pngBytes(t))
	assertStatus(t, response, http.StatusCreated)
	var asset openapi.PdfTemplateAsset
	decodeResponse(t, response, &asset)
	doc := admin.documentWith("receipt", "With a picture",
		map[string]any{"id": "pic", "type": "picture", "asset": asset.Id.String(), "w": 20, "h": 20})
	draft := admin.saveDraft("receipt", doc, nil)
	// An image cannot be deleted through the API while a draft uses it; a row removed behind its back is caught at publication.
	if _, err := h.pool.Exec(testContext(t), `DELETE FROM pdf_template_assets WHERE id = $1`, asset.Id); err != nil {
		t.Fatal(err)
	}
	admin.expectError(http.MethodPost, "/pdf-templates/receipt/publish",
		map[string]any{"expectedRevision": draft.Version.Revision}, http.StatusUnprocessableEntity, "pdf_template_has_problems")
	// A canonical id of an image that never existed is refused the same way, and a draft that does not use one publishes.
	ghost := admin.documentWith("receipt", "Ghost",
		map[string]any{"id": "pic", "type": "picture", "asset": ids.New().String(), "w": 20, "h": 20})
	saved := admin.saveDraft("receipt", ghost, &draft.Version.Revision)
	admin.expectError(http.MethodPost, "/pdf-templates/receipt/publish",
		map[string]any{"expectedRevision": saved.Version.Revision}, http.StatusUnprocessableEntity, "pdf_template_has_problems")
	plain := admin.saveDraft("receipt", admin.documentWith("receipt", "Plain", textBlock("t", "Plain")), &saved.Version.Revision)
	admin.publish("receipt", plain.Version.Revision)

	// A spelling of the id other than the canonical one cannot even be saved.
	upper := admin.documentWith("receipt", "Upper",
		map[string]any{"id": "pic", "type": "picture", "asset": strings.ToUpper(asset.Id.String()), "w": 20, "h": 20})
	admin.expectError(http.MethodPut, "/pdf-templates/receipt/draft", map[string]any{"document": upper},
		http.StatusUnprocessableEntity, "pdf_template_invalid")
}

func TestPDFTemplateAssetCountIsBounded(t *testing.T) {
	h := newPDFTemplatesHTTP(t)
	if _, err := h.pool.Exec(testContext(t), `
		INSERT INTO pdf_template_assets (id, file_name, content_type, byte_size, sha256, data, width, height)
		SELECT gen_random_uuid(), 'filler-' || n, 'image/png', 1, sha256('\x00'::bytea), '\x00', 1, 1 FROM generate_series(1, 100) n`); err != nil {
		t.Fatal(err)
	}
	response := h.master.callRaw(http.MethodPost, "/pdf-templates/assets?fileName=one-too-many.png", "image/png", pngBytes(t))
	assertStatus(t, response, http.StatusConflict)
	if code := errorCodeOf(t, response); code != "pdf_template_asset_limit" {
		t.Fatalf("code = %s", code)
	}
}

func jsonString(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func (s apiSession) download(path string) (status int, contentType string, data []byte) {
	s.h.t.Helper()
	response := s.call(http.MethodGet, path, nil)
	return response.StatusCode, response.Header.Get("Content-Type"), readResponse(s.h.t, response)
}

func TestPublishedTemplatesShapeTheRealExportsAndRedactByPermission(t *testing.T) {
	h := newPDFTemplatesHTTP(t)
	admin := h.master
	cashier := h.member("pdf_templates.manage", "payments.read", "cash_movements.read")
	clerk := h.member("orders.read")
	viewer := h.member("pdf_templates.manage", "payments.read", "cash_movements.read", "orders.read")

	// A customer with a matriculation number, one finalized order paid in cash and one draft order.
	response := admin.call(http.MethodPost, "/people", map[string]any{
		"firstName": "Marie", "lastName": "Hofer", "email": "marie-hofer@example.test", "matriculationNumber": "12034567",
	})
	assertStatus(t, response, http.StatusCreated)
	var customer openapi.Person
	decodeResponse(t, response, &customer)
	newOrder := func() openapi.Order {
		response := admin.call(http.MethodPost, "/orders", map[string]any{
			"customer": map[string]any{"kind": "person", "id": customer.Id.String()},
		})
		assertStatus(t, response, http.StatusCreated)
		var order openapi.Order
		decodeResponse(t, response, &order)
		response = admin.call(http.MethodPost, "/orders/"+order.Id.String()+"/items", map[string]any{
			"kind": "manual", "description": "Laser engraving", "quantity": "1", "unit": "pc", "unitPrice": "10",
			"expectedVersion": order.Version,
		})
		assertStatus(t, response, http.StatusCreated)
		decodeResponse(t, response, &order)
		return order
	}
	paid := newOrder()
	response = admin.call(http.MethodPost, "/orders/"+paid.Id.String()+"/checkout", map[string]any{
		"operationKey": ids.New().String(), "expectedVersion": paid.Version,
		"payments": []map[string]any{{"method": "cash", "amount": "10", "occurredAt": time.Now().UTC()}},
	})
	assertStatus(t, response, http.StatusCreated)
	draft := newOrder()

	// Receipt PDF: orders.read only; finalized orders with a settled amount only; the payment must belong to the order.
	nobody := h.member()
	nobody.expectError(http.MethodGet, "/orders/"+paid.Id.String()+"/receipt.pdf", nil, http.StatusForbidden, "permission_denied")
	clerk.expectError(http.MethodGet, "/orders/"+draft.Id.String()+"/receipt.pdf", nil, http.StatusConflict, "receipt_not_available")
	clerk.expectError(http.MethodGet, "/orders/"+ids.New().String()+"/receipt.pdf", nil, http.StatusNotFound, "not_found")
	clerk.expectError(http.MethodGet, "/orders/"+paid.Id.String()+"/receipt.pdf?paymentId="+ids.New().String(), nil,
		http.StatusNotFound, "not_found")
	status, contentType, receipt := clerk.download("/orders/" + paid.Id.String() + "/receipt.pdf")
	text := pdfText(t, receipt)
	if status != http.StatusOK || contentType != "application/pdf" || !strings.Contains(text, squash(paid.Reference)) ||
		!strings.Contains(text, "Laserengraving") || !strings.Contains(text, "MarieHofer") {
		t.Fatalf("receipt: status %d, %s, text %q", status, contentType, text)
	}
	var payment struct{ ID string }
	if err := h.pool.QueryRow(testContext(t), `SELECT id::text FROM payments LIMIT 1`).Scan(&payment.ID); err != nil {
		t.Fatal(err)
	}
	status, _, single := clerk.download("/orders/" + paid.Id.String() + "/receipt.pdf?paymentId=" + payment.ID)
	if status != http.StatusOK || !strings.Contains(pdfText(t, single), "Receiptforpayment") {
		t.Fatalf("single payment receipt: %d %q", status, pdfText(t, single))
	}

	// A published receipt template that prints the matriculation number: only a reader with the permission gets it.
	numbered := admin.documentWith("receipt", "Numbered receipt",
		textBlock("m", "Matriculation {{order.customer.matriculationNumber}} end"))
	draftVersion := admin.saveDraft("receipt", numbered, nil)
	admin.publish("receipt", draftVersion.Version.Revision)
	_, _, withNumber := admin.download("/orders/" + paid.Id.String() + "/receipt.pdf")
	_, _, withoutNumber := clerk.download("/orders/" + paid.Id.String() + "/receipt.pdf")
	if got := pdfText(t, withNumber); !strings.Contains(got, "Matriculation12034567end") {
		t.Fatalf("receipt with permission: %q", got)
	}
	if got := pdfText(t, withoutNumber); !strings.Contains(got, "Matriculationend") || strings.Contains(got, "12034567") {
		t.Fatalf("receipt without people.read.matriculation: %q", got)
	}
	// The same document previewed with the real order is redacted the same way and says so.
	response = viewer.call(http.MethodPost, "/pdf-templates/receipt/preview", map[string]any{
		"document": numbered, "source": map[string]any{"kind": "record", "id": paid.Id.String()},
	})
	assertStatus(t, response, http.StatusOK)
	var preview openapi.PdfTemplatePreview
	decodeResponse(t, response, &preview)
	if got := pdfText(t, preview.Pdf); strings.Contains(got, "12034567") ||
		strings.Join(preview.Redacted, ",") != "order.customer.matriculationNumber" {
		t.Fatalf("receipt preview: redacted %v, text %q", preview.Redacted, got)
	}

	// A published cashbook template is what the real export renders, with the order data only for orders.read.
	lines := admin.documentWith("cashbook", "Custom cashbook",
		textBlock("head", "Cashbook {{lines | count}} lines"),
		map[string]any{"id": "each", "type": "repeat", "source": "lines", "as": "line",
			"blocks": []map[string]any{textBlock("row", "Line {{line.orderReference}} for {{line.customer}} end")}})
	lineDraft := admin.saveDraft("cashbook", lines, nil)
	if len(lineDraft.Problems) != 0 {
		t.Fatalf("cashbook problems: %+v", lineDraft.Problems)
	}
	admin.publish("cashbook", lineDraft.Version.Revision)
	today := time.Now().In(mustVienna(t)).Format("2006-01-02")
	exportPath := "/payments/cashbook-export?from=" + today + "&to=" + today
	status, contentType, full := admin.download(exportPath)
	if got := pdfText(t, full); status != http.StatusOK || contentType != "application/pdf" ||
		!strings.Contains(got, "Cashbook1lines") || !strings.Contains(got, "Line"+squash(paid.Reference)+"forMarieHoferend") {
		t.Fatalf("export with orders.read: %d %s %q", status, contentType, got)
	}
	status, _, bare := cashier.download(exportPath)
	if got := pdfText(t, bare); status != http.StatusOK || !strings.Contains(got, "Line"+squash(paid.Reference)+"forend") ||
		strings.Contains(got, "MarieHofer") {
		t.Fatalf("export without orders.read: %d %q", status, got)
	}

	// The preview of a month of the cash register redacts lines[].customer for a reader without orders.read.
	response = cashier.call(http.MethodGet, "/pdf-templates/cashbook", nil)
	assertStatus(t, response, http.StatusOK)
	var detail openapi.PdfTemplateDetail
	decodeResponse(t, response, &detail)
	if len(detail.PreviewSources) != 3 {
		t.Fatalf("preview sources = %+v", detail.PreviewSources)
	}
	month := detail.PreviewSources[0].Id
	for _, c := range []struct {
		who      apiSession
		customer bool
	}{{cashier, false}, {viewer, true}} {
		response = c.who.call(http.MethodPost, "/pdf-templates/cashbook/preview", map[string]any{
			"document": lines, "source": map[string]any{"kind": "record", "id": month},
		})
		assertStatus(t, response, http.StatusOK)
		decodeResponse(t, response, &preview)
		got := pdfText(t, preview.Pdf)
		if c.customer != strings.Contains(got, "MarieHofer") || (len(preview.Redacted) == 0) != c.customer {
			t.Fatalf("cashbook preview (customer visible: %v): redacted %v, text %q", c.customer, preview.Redacted, got)
		}
		if !c.customer && jsonString(t, preview.Redacted) != `["lines[].customer"]` {
			t.Fatalf("redacted = %v", preview.Redacted)
		}
	}
	cashier.expectError(http.MethodPost, "/pdf-templates/cashbook/preview", map[string]any{
		"document": lines, "source": map[string]any{"kind": "record", "id": "not-a-month"}}, http.StatusNotFound, "not_found")

	// The receipt sources list the finalized order with a receipt, not the draft.
	response = viewer.call(http.MethodGet, "/pdf-templates/receipt", nil)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &detail)
	if len(detail.PreviewSources) != 1 || detail.PreviewSources[0].Id != paid.Id.String() ||
		detail.PreviewSources[0].Label != paid.Reference {
		t.Fatalf("receipt sources = %+v, want the reference %q only", detail.PreviewSources, paid.Reference)
	}
}

func TestPDFTemplateRoutesDistinguishAssetsFromExports(t *testing.T) {
	h := newPDFTemplatesHTTP(t)
	response := h.master.call(http.MethodGet, "/pdf-templates/assets", nil)
	assertStatus(t, response, http.StatusOK)
	var assets []openapi.PdfTemplateAsset
	decodeResponse(t, response, &assets)
	if assets == nil || len(assets) != 0 {
		t.Fatalf("assets = %#v", assets)
	}
	response = h.master.call(http.MethodGet, "/pdf-templates/cashbook", nil)
	assertStatus(t, response, http.StatusOK)
	var detail openapi.PdfTemplateDetail
	decodeResponse(t, response, &detail)
	if detail.Export != "cashbook" {
		t.Fatalf("detail = %+v", detail.Export)
	}
}

// finalizedOrder creates an order of one manual item for a person and finalizes it, still unpaid.
func (s apiSession) finalizedOrder(customerID, description, price string) openapi.Order {
	s.h.t.Helper()
	response := s.call(http.MethodPost, "/orders", map[string]any{
		"customer": map[string]any{"kind": "person", "id": customerID},
	})
	assertStatus(s.h.t, response, http.StatusCreated)
	var order openapi.Order
	decodeResponse(s.h.t, response, &order)
	response = s.call(http.MethodPost, "/orders/"+order.Id.String()+"/items", map[string]any{
		"kind": "manual", "description": description, "quantity": "1", "unit": "pc", "unitPrice": price,
		"expectedVersion": order.Version,
	})
	assertStatus(s.h.t, response, http.StatusCreated)
	decodeResponse(s.h.t, response, &order)
	response = s.call(http.MethodPost, "/orders/"+order.Id.String()+"/finalize",
		map[string]any{"operationKey": ids.New().String(), "expectedVersion": order.Version})
	assertStatus(s.h.t, response, http.StatusCreated)
	decodeResponse(s.h.t, response, &order)
	return order
}

func (s apiSession) newPerson(first, last string) openapi.Person {
	s.h.t.Helper()
	response := s.call(http.MethodPost, "/people", map[string]any{
		"firstName": first, "lastName": last, "email": strings.ToLower(first+"-"+last) + "@example.test",
	})
	assertStatus(s.h.t, response, http.StatusCreated)
	var person openapi.Person
	decodeResponse(s.h.t, response, &person)
	return person
}

// invoiceRequest creates a request for the order and, when forward is set, submits and forwards it to wiRef.
func (s apiSession) invoiceRequest(order openapi.Order, forward bool) openapi.ExternalInvoiceRequest {
	s.h.t.Helper()
	response := s.call(http.MethodPost, "/orders/"+order.Id.String()+"/external-invoice-requests", map[string]any{
		"operationKey": ids.New().String(), "expectedVersion": order.Version,
		"details": map[string]any{
			"recipientName": "Billing Recipient GmbH", "addressLine1": "Street 1", "postalCode": "8010",
			"locality": "Graz", "countryCode": "AT", "contactName": "Contact Person",
			"serviceStartsOn": "2026-10-01", "serviceEndsOn": "2026-10-06", "serviceDescription": "Machine service",
		},
	})
	assertStatus(s.h.t, response, http.StatusCreated)
	var request openapi.ExternalInvoiceRequest
	decodeResponse(s.h.t, response, &request)
	if !forward {
		return request
	}
	for _, action := range []string{"submit", "forward"} {
		response = s.call(http.MethodPost, "/external-invoice-requests/"+request.Id.String()+"/"+action,
			map[string]any{"operationKey": ids.New().String(), "expectedVersion": request.Version})
		assertStatus(s.h.t, response, http.StatusCreated)
		decodeResponse(s.h.t, response, &request)
	}
	return request
}

func TestWiRefRecordPreviewsNeedOrdersReadAndOnlyOfferForwardedRequests(t *testing.T) {
	h := newPDFTemplatesHTTP(t)
	admin := h.master
	customer := admin.newPerson("Marie", "Hofer")

	// An order paid in part in cash, whose open rest goes to wiRef, so the document lists payments.
	order := admin.finalizedOrder(customer.Id.String(), "Laser engraving", "10")
	response := admin.call(http.MethodPost, "/orders/"+order.Id.String()+"/payments", map[string]any{
		"operationKey": ids.New().String(), "expectedVersion": order.Version,
		"payment": map[string]any{"method": "cash", "amount": "4", "occurredAt": time.Now().UTC()},
	})
	assertStatus(t, response, http.StatusCreated)
	decodeResponse(t, response, &order)
	forwarded := admin.invoiceRequest(order, true)
	draftOnly := admin.invoiceRequest(admin.finalizedOrder(customer.Id.String(), "Vinyl cutting", "5"), false)

	document := admin.documentWith("wiref", "Payments",
		map[string]any{"id": "each", "type": "repeat", "source": "payments", "as": "pay",
			"blocks": []map[string]any{textBlock("row", "Paid {{pay.method}} {{pay.amount}} end")}})
	previewOf := func(who apiSession, id string) *http.Response {
		return who.call(http.MethodPost, "/pdf-templates/wiref/preview", map[string]any{
			"document": document, "source": map[string]any{"kind": "record", "id": id},
		})
	}

	// external_invoice_requests.read alone shows neither the sources nor the document: the payments need orders.read.
	requestsOnly := h.member("pdf_templates.manage", "external_invoice_requests.read")
	response = requestsOnly.call(http.MethodGet, "/pdf-templates/wiref", nil)
	assertStatus(t, response, http.StatusOK)
	var detail openapi.PdfTemplateDetail
	decodeResponse(t, response, &detail)
	if len(detail.PreviewSources) != 0 {
		t.Fatalf("a reader without orders.read is offered %+v", detail.PreviewSources)
	}
	response = previewOf(requestsOnly, forwarded.Id.String())
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	ordersOnly := h.member("pdf_templates.manage", "orders.read")
	response = previewOf(ordersOnly, forwarded.Id.String())
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()

	// With both permissions the forwarded request is offered by its number only, and renders with its payments.
	reader := h.member("pdf_templates.manage", "external_invoice_requests.read", "orders.read")
	response = reader.call(http.MethodGet, "/pdf-templates/wiref", nil)
	assertStatus(t, response, http.StatusOK)
	decodeResponse(t, response, &detail)
	if len(detail.PreviewSources) != 1 || detail.PreviewSources[0].Id != forwarded.Id.String() ||
		detail.PreviewSources[0].Label != forwarded.Reference {
		t.Fatalf("sources = %+v, want the forwarded request %q alone", detail.PreviewSources, forwarded.Reference)
	}
	response = previewOf(reader, forwarded.Id.String())
	assertStatus(t, response, http.StatusOK)
	var preview openapi.PdfTemplatePreview
	decodeResponse(t, response, &preview)
	if got := pdfText(t, preview.Pdf); !strings.Contains(got, "PaidCash4.00end") || !strings.Contains(got, "PaidwiRefinvoice6.00end") {
		t.Fatalf("wiRef preview text %q", got)
	}

	// A request that was not forwarded has no PDF, and an unknown one is just as absent.
	reader.expectError(http.MethodPost, "/pdf-templates/wiref/preview", map[string]any{
		"document": document, "source": map[string]any{"kind": "record", "id": draftOnly.Id.String()}},
		http.StatusNotFound, "not_found")
	reader.expectError(http.MethodPost, "/pdf-templates/wiref/preview", map[string]any{
		"document": document, "source": map[string]any{"kind": "record", "id": ids.New().String()}},
		http.StatusNotFound, "not_found")
}

func TestCashbookOrderSummaryIsRedactedWithoutOrdersRead(t *testing.T) {
	h := newPDFTemplatesHTTP(t)
	admin := h.master
	cashier := h.member("pdf_templates.manage", "payments.read", "cash_movements.read")
	viewer := h.member("pdf_templates.manage", "payments.read", "cash_movements.read", "orders.read")

	customer := admin.newPerson("Marie", "Hofer")
	order := admin.finalizedOrder(customer.Id.String(), "Laser engraving", "10")
	response := admin.call(http.MethodPost, "/orders/"+order.Id.String()+"/payments", map[string]any{
		"operationKey": ids.New().String(), "expectedVersion": order.Version,
		"payment": map[string]any{"method": "cash", "amount": "10", "occurredAt": time.Now().UTC()},
	})
	assertStatus(t, response, http.StatusCreated)
	response.Body.Close()

	document := admin.documentWith("cashbook", "Summaries",
		map[string]any{"id": "each", "type": "repeat", "source": "lines", "as": "line",
			"blocks": []map[string]any{textBlock("row", "Summary [{{line.orderSummary}}] end")}})
	draft := admin.saveDraft("cashbook", document, nil)
	admin.publish("cashbook", draft.Version.Revision)

	today := time.Now().In(mustVienna(t)).Format("2006-01-02")
	exportPath := "/payments/cashbook-export?from=" + today + "&to=" + today
	_, _, full := admin.download(exportPath)
	if got := pdfText(t, full); !strings.Contains(got, "Summary[Laserengraving]end") {
		t.Fatalf("export with orders.read: %q", got)
	}
	status, _, bare := cashier.download(exportPath)
	if got := pdfText(t, bare); status != http.StatusOK || !strings.Contains(got, "Summary[]end") ||
		strings.Contains(got, "Laserengraving") {
		t.Fatalf("export without orders.read: %d %q", status, got)
	}

	response = cashier.call(http.MethodGet, "/pdf-templates/cashbook", nil)
	assertStatus(t, response, http.StatusOK)
	var detail openapi.PdfTemplateDetail
	decodeResponse(t, response, &detail)
	month := detail.PreviewSources[0].Id
	for _, c := range []struct {
		who     apiSession
		visible bool
	}{{cashier, false}, {viewer, true}} {
		response = c.who.call(http.MethodPost, "/pdf-templates/cashbook/preview", map[string]any{
			"document": document, "source": map[string]any{"kind": "record", "id": month},
		})
		assertStatus(t, response, http.StatusOK)
		var preview openapi.PdfTemplatePreview
		decodeResponse(t, response, &preview)
		got := pdfText(t, preview.Pdf)
		if c.visible != strings.Contains(got, "Laserengraving") {
			t.Fatalf("preview (summary visible: %v): %q", c.visible, got)
		}
		if !c.visible && jsonString(t, preview.Redacted) != `["lines[].orderSummary"]` {
			t.Fatalf("redacted = %v", preview.Redacted)
		}
		if c.visible && len(preview.Redacted) != 0 {
			t.Fatalf("redacted = %v for a reader with orders.read", preview.Redacted)
		}
	}
}
