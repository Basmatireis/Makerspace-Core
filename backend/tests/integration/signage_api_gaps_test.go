package integration_test

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
)

func TestSignageAssetCreatedByNameAndEncodedFileNames(t *testing.T) {
	e := newSignageEnv(t)
	editor := e.staff("gaps-editor", authorization.SignageRead, authorization.SignageContentManage)
	if _, err := e.pool.Exec(testContext(t), `UPDATE people SET first_name = 'Ada', last_name = 'Lovelace' WHERE id = $1`, editor.account.personID); err != nil {
		t.Fatal(err)
	}
	image := signageJPEG(t, 32, 32)
	upload := func(name string) *http.Response {
		return e.doRaw(
			editor.client,
			editor.csrf,
			http.MethodPost,
			"/signage/assets",
			image,
			"X-File-Name",
			name,
			"X-File-Content-Type",
			"image/jpeg",
		)
	}

	// Percent-encoded UTF-8 is decoded; ASCII names keep working.
	created := e.expect(upload(url.PathEscape("Übersicht – Plakat 100%.jpg")), http.StatusCreated)
	if created["name"] != "Übersicht – Plakat 100%.jpg" || created["createdByName"] != "Ada Lovelace" {
		t.Fatalf("created = %v", created)
	}
	e.expect(upload("plain-name.jpg"), http.StatusCreated)
	e.expect(upload("with%20space.jpg"), http.StatusCreated)

	// Invalid encodings, control characters and oversized names are 400s.
	for name, header := range map[string]string{
		"bad hex":         "broken%ZZ.jpg",
		"truncated":       "broken%",
		"invalid utf-8":   "%FF%FE.jpg",
		"newline":         "a%0Ab.jpg",
		"nul":             "a%00b.jpg",
		"escape":          "a%1Bb.jpg",
		"overlong":        strings.Repeat("a", 700) + ".jpg",
		"c1 control char": "a%C2%85b.jpg",
	} {
		t.Run(name, func(t *testing.T) { e.expectCode(upload(header), http.StatusBadRequest, "invalid_request") })
	}
	// A decoded name longer than 150 characters still fails the service validation.
	e.expectCode(upload(url.PathEscape(strings.Repeat("ä", 151))), http.StatusUnprocessableEntity, "validation_failed")

	// createdByName is part of list and detail responses and null once the account link is gone.
	id := created["id"].(string)
	if detail := e.expect(e.as(editor, http.MethodGet, "/signage/assets/"+id, nil), http.StatusOK); detail["createdByName"] != "Ada Lovelace" {
		t.Fatalf("detail = %v", detail)
	}
	listed := e.expect(e.as(editor, http.MethodGet, "/signage/assets", nil), http.StatusOK)["items"].([]any)
	if listed[len(listed)-1].(map[string]any)["createdByName"] != "Ada Lovelace" {
		t.Fatalf("list = %v", listed)
	}
	if _, err := e.pool.Exec(testContext(t), `UPDATE signage_assets SET created_by_account_id = NULL`); err != nil {
		t.Fatal(err)
	}
	detail := e.expect(e.as(editor, http.MethodGet, "/signage/assets/"+id, nil), http.StatusOK)
	if name, present := detail["createdByName"]; !present || name != nil {
		t.Fatalf("createdByName after account removal = %v (present %v)", name, present)
	}
}

func TestSignageMachinesPickerPermissions(t *testing.T) {
	e := newSignageEnv(t)
	laser := e.fixture.machine(t, "Laser")
	e.fixture.machine(t, "Bambu")
	for _, permission := range []authorization.Permission{authorization.SignageRead, authorization.SignageManage, authorization.SignageContentManage} {
		staff := e.staff("machines-"+string(permission), permission)
		items := e.expect(e.as(staff, http.MethodGet, "/signage/machines", nil), http.StatusOK)["items"].([]any)
		if len(items) != 2 {
			t.Fatalf("%s: machines = %v", permission, items)
		}
		first := items[0].(map[string]any)
		if first["name"] != "Bambu" || first["kind"] != "Bambu type" || first["hasCamera"] != false || len(first) != 4 {
			t.Fatalf("%s: first machine = %v", permission, first)
		}
		if items[1].(map[string]any)["id"] != laser.String() {
			t.Fatalf("%s: order = %v", permission, items)
		}
	}
	for _, permission := range []authorization.Permission{authorization.SignagePublish, authorization.SignageOverride, authorization.MachinesRead} {
		staff := e.staff("machines-denied-"+string(permission), permission)
		e.expect(e.as(staff, http.MethodGet, "/signage/machines", nil), http.StatusForbidden)
	}
	e.expect(e.do(e.newPlayer(), "", http.MethodGet, "/signage/machines", nil), http.StatusUnauthorized)
}

func TestSignageAssetContentCacheHeaders(t *testing.T) {
	e := newSignageEnv(t)
	viewer := e.staff("cache-viewer", authorization.SignageRead)
	asset := e.fixture.uploadImage(t, "cache.jpg")
	get := func(query string) *http.Response {
		response := e.as(viewer, http.MethodGet, "/signage/assets/"+asset.ID.String()+"/content"+query, nil)
		if response.StatusCode != http.StatusOK {
			t.Fatalf("status = %d", response.StatusCode)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
		return response
	}
	if cache := get("?v=" + asset.SHA256).Header.Get("Cache-Control"); cache != "private, max-age=31536000, immutable" {
		t.Fatalf("matching v: Cache-Control = %q", cache)
	}
	for _, query := range []string{"", "?v=" + strings.Repeat("0", 64)} {
		if cache := get(query).Header.Get("Cache-Control"); cache != "private, no-store" {
			t.Fatalf("%q: Cache-Control = %q", query, cache)
		}
	}
	e.expect(
		e.as(viewer, http.MethodGet, "/signage/assets/"+asset.ID.String()+"/content?v=nothex", nil),
		http.StatusBadRequest,
	)
	// Permissions are unchanged: a matching digest never bypasses authorization.
	nobody := e.staff("cache-nobody", authorization.SignageContentManage)
	e.expect(
		e.as(nobody, http.MethodGet, "/signage/assets/"+asset.ID.String()+"/content?v="+asset.SHA256, nil),
		http.StatusForbidden,
	)
}

func TestPublicConfigurationExposesMakerspaceTimeZone(t *testing.T) {
	e := newSignageEnv(t)
	configuration := e.expect(e.do(e.newPlayer(), "", http.MethodGet, "/public/config", nil), http.StatusOK)
	if configuration["timeZone"] != "Europe/Vienna" {
		t.Fatalf("timeZone = %v", configuration["timeZone"])
	}
}
