package printerconnectors

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

const bambuCodeList = `{"result":0,"data":{"device_hms":{"ver":1,"en":[
 {"ecode":"0700520000030001","intro":"Abnormal number or type of connected AMS units detected. Please refer to the Wiki for supported AMS combinations and adjust the current connection."},
 {"ecode":"0500060000020045","intro":""},
 {"ecode":"0300120000010002","intro":"The heatbed temperature is abnormal; the heater may have a short circuit.   Check the heater."},
 {"ecode":"bad","intro":"ignored"},
 {"ecode":"0700520000030001","intro":"duplicate"}
]},"device_error":{"ver":1,"en":[
 {"ecode":"18048012","intro":"Failed to get AMS mapping table; please select \"Resume\" to retry."},
 {"ecode":"07ff8003","intro":"Printing was paused because the print file was not found."}
]}}}`

func TestParseBambuErrorCodesUsesThePrinterForm(t *testing.T) {
	t.Parallel()
	codes, err := ParseBambuErrorCodes([]byte(bambuCodeList))
	if err != nil {
		t.Fatal(err)
	}
	if len(codes) != 4 {
		t.Fatalf("parsed %d codes, want 4: %+v", len(codes), codes)
	}
	ams := codes[0]
	if ams.SourceFamily != "hms" || ams.Code != "0700-5200-0003-0001" ||
		ams.Title != "Abnormal number or type of connected AMS units detected." ||
		!strings.HasSuffix(ams.Description, "adjust the current connection.") {
		t.Fatalf("first code = %+v", ams)
	}
	if codes[1].Code != "0300-1200-0001-0002" || codes[1].Title != "The heatbed temperature is abnormal; the heater may have a short circuit." ||
		strings.Contains(codes[1].Description, "   ") {
		t.Fatalf("second code = %+v", codes[1])
	}
	if codes[2].SourceFamily != "print" || codes[2].Code != "18048012" || codes[3].Code != "07FF8003" {
		t.Fatalf("print codes = %+v %+v", codes[2], codes[3])
	}
	if _, err := ParseBambuErrorCodes([]byte(`{"data":{}}`)); err == nil {
		t.Fatal("an empty list must be refused")
	}
	if _, err := ParseBambuErrorCodes([]byte(`not json`)); err == nil {
		t.Fatal("garbage must be refused")
	}
}

func TestSyncErrorCodesFillsTheCatalogWithoutTouchingManualMeanings(t *testing.T) {
	h := newIngestHarness(t)
	ctx := t.Context()
	document := bambuCodeList
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(document))
	}))
	t.Cleanup(source.Close)
	t.Cleanup(func() {
		_, _ = h.pool.Exec(context.Background(), `DELETE FROM printer_error_codes WHERE code IN ('0700-5200-0003-0001','0300-1200-0001-0002','18048012','07FF8003')`)
		_, _ = h.pool.Exec(context.Background(), `UPDATE printer_error_code_sync SET last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, imported_count = 0`)
	})
	// Off by default in tests: nothing to fetch from.
	if _, err := h.service.SyncErrorCodes(ctx); !apperror.IsCode(err, "sync_disabled") {
		t.Fatalf("sync without a source: %v", err)
	}
	h.service.SetErrorCodeSource(source.URL)
	// A meaning written here before the fetch stays.
	if _, err := h.service.PutErrorCode(ctx, h.principal, "hms", "0700-5200-0003-0001", ErrorCodeInput{Title: "Our own words"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := h.service.SyncErrorCodesNow(ctx, h.principalWith("viewer", authorization.MachinesRead), nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("sync without manage: %v", err)
	}
	if err := h.service.SyncErrorCodesNow(ctx, h.principal, nil); err != nil {
		t.Fatal(err)
	}
	codes, err := h.service.ListErrorCodes(ctx, h.principal)
	if err != nil {
		t.Fatal(err)
	}
	byCode := map[string]ErrorCode{}
	for _, code := range codes {
		byCode[code.Code] = code
	}
	if byCode["0700-5200-0003-0001"].Title != "Our own words" || byCode["0700-5200-0003-0001"].Source != "manual" {
		t.Fatalf("manual meaning overwritten: %+v", byCode["0700-5200-0003-0001"])
	}
	if byCode["07FF8003"].Source != "bambu" || byCode["07FF8003"].Title != "Printing was paused because the print file was not found." {
		t.Fatalf("fetched print error = %+v", byCode["07FF8003"])
	}
	status, err := h.service.ErrorCodeSyncStatus(ctx)
	if err != nil || !status.Enabled || status.LastSuccessAt == nil || status.LastError != nil || status.ImportedCount != 4 {
		t.Fatalf("status after success = %+v, %v", status, err)
	}
	// A changed published text refreshes a fetched row on the next sync.
	document = strings.Replace(bambuCodeList, "Printing was paused because the print file was not found.", "Print file missing; printing paused.", 1)
	if _, err := h.service.SyncErrorCodes(ctx); err != nil {
		t.Fatal(err)
	}
	codes, _ = h.service.ListErrorCodes(ctx, h.principal)
	for _, code := range codes {
		if code.Code == "07FF8003" && code.Title != "Print file missing; printing paused." {
			t.Fatalf("fetched meaning not refreshed: %+v", code)
		}
	}
	// A failing source is recorded, and the catalog keeps what it has.
	source.Close()
	if _, err := h.service.SyncErrorCodes(ctx); !apperror.IsCode(err, "sync_failed") {
		t.Fatalf("sync with a dead source: %v", err)
	}
	status, _ = h.service.ErrorCodeSyncStatus(ctx)
	if status.LastError == nil || status.LastSuccessAt == nil || status.ImportedCount != 4 {
		t.Fatalf("status after failure = %+v", status)
	}
	var audited int
	if err := h.pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = 'printer_error_codes.synced'`).Scan(&audited); err != nil || audited < 1 {
		t.Fatalf("sync audit events = %d, %v", audited, err)
	}
}
