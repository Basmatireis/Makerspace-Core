package pdftemplates

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// These tests need no database: every check they cover happens before the service touches it.

func codeOf(err error) string {
	var appErr *apperror.Error
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}

func builtinJSON(t *testing.T, kind engine.Kind) []byte {
	t.Helper()
	raw, err := engine.Encode(engine.Builtin(kind))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestEveryOperationNeedsThePDFTemplatesManagePermission(t *testing.T) {
	s := NewService(nil, nil, Records{})
	nobody := authorization.Principal{}
	id := uuid.New()
	revision := 1
	operations := map[string]func() error{
		"List": func() error { _, err := s.List(t.Context(), nobody); return err },
		"Get":  func() error { _, err := s.Get(t.Context(), nobody, engine.KindWiRef); return err },
		"ListVersions": func() error {
			_, err := s.ListVersions(t.Context(), nobody, engine.KindWiRef)
			return err
		},
		"GetVersion": func() error { _, err := s.GetVersion(t.Context(), nobody, engine.KindWiRef, id); return err },
		"SaveDraft": func() error {
			_, err := s.SaveDraft(t.Context(), nobody, engine.KindWiRef, builtinJSON(t, engine.KindWiRef), &revision, nil)
			return err
		},
		"DiscardDraft": func() error { return s.DiscardDraft(t.Context(), nobody, engine.KindWiRef, nil) },
		"Publish": func() error {
			_, err := s.Publish(t.Context(), nobody, engine.KindWiRef, 1, nil)
			return err
		},
		"Restore": func() error { _, err := s.Restore(t.Context(), nobody, engine.KindWiRef, id, nil); return err },
		"Preview": func() error {
			_, err := s.Preview(t.Context(), nobody, engine.KindWiRef, builtinJSON(t, engine.KindWiRef),
				PreviewSource{Kind: SourceSample})
			return err
		},
		"ListAssets":  func() error { _, err := s.ListAssets(t.Context(), nobody); return err },
		"GetAsset":    func() error { _, err := s.GetAsset(t.Context(), nobody, id); return err },
		"UploadAsset": func() error { _, err := s.UploadAsset(t.Context(), nobody, "logo.png", []byte("x"), nil); return err },
		"DeleteAsset": func() error { return s.DeleteAsset(t.Context(), nobody, id, nil) },
	}
	for name, call := range operations {
		if err := call(); !errors.Is(err, apperror.PermissionDenied) {
			t.Errorf("%s: err = %v, want permission denied", name, err)
		}
	}
}

func TestUnknownExportIsNotFound(t *testing.T) {
	s := NewService(nil, nil, Records{})
	master := authorization.Principal{Master: true}
	if _, err := s.Get(t.Context(), master, "letter"); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("err = %v", err)
	}
	if _, err := s.Effective(t.Context(), "letter"); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("effective err = %v", err)
	}
}

func TestSaveDraftRefusesAnInvalidOrForeignDocumentBeforeStoring(t *testing.T) {
	s := NewService(nil, nil, Records{})
	master := authorization.Principal{Master: true}
	_, err := s.SaveDraft(t.Context(), master, engine.KindWiRef, []byte(`{"schemaVersion":1,"bogus":true}`), nil, nil)
	if codeOf(err) != engine.CodeInvalid {
		t.Fatalf("invalid document: %v", err)
	}
	_, err = s.SaveDraft(t.Context(), master, engine.KindWiRef, builtinJSON(t, engine.KindReceipt), nil, nil)
	if codeOf(err) != CodeExportMismatch {
		t.Fatalf("foreign document: %v", err)
	}
}

func TestPreviewWithSampleDataRendersEveryBuiltinTemplate(t *testing.T) {
	s := NewService(nil, nil, Records{})
	master := authorization.Principal{Master: true}
	for _, kind := range engine.Kinds {
		preview, err := s.Preview(t.Context(), master, kind, builtinJSON(t, kind), PreviewSource{Kind: SourceSample})
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if !strings.HasPrefix(string(preview.PDF), "%PDF-") || len(preview.Pages) == 0 || len(preview.Boxes) == 0 {
			t.Errorf("%s: pdf %d bytes, %d pages, %d boxes", kind, len(preview.PDF), len(preview.Pages), len(preview.Boxes))
		}
		if engine.HasErrors(preview.Problems) {
			t.Errorf("%s: the built-in template has problems: %+v", kind, preview.Problems)
		}
	}
}

func TestPreviewRefusesBadSources(t *testing.T) {
	s := NewService(nil, nil, Records{})
	master := authorization.Principal{Master: true}
	raw := builtinJSON(t, engine.KindReceipt)
	if _, err := s.Preview(t.Context(), master, engine.KindReceipt, raw, PreviewSource{Kind: "live"}); codeOf(err) != "validation_failed" {
		t.Errorf("unknown source kind: %v", err)
	}
	if _, err := s.Preview(t.Context(), master, engine.KindReceipt, raw, PreviewSource{Kind: SourceRecord}); codeOf(err) != "validation_failed" {
		t.Errorf("record without id: %v", err)
	}
	// Without a record source for the export a record preview has nothing to read.
	err := func() error {
		_, err := s.Preview(t.Context(), master, engine.KindReceipt, raw, PreviewSource{Kind: SourceRecord, ID: "x"})
		return err
	}()
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || appErr.HTTPStatus != http.StatusNotFound || appErr.Code != CodeSourceUnavailable {
		t.Errorf("no record source: %v", err)
	}
	if _, err := s.Preview(t.Context(), master, engine.KindWiRef, raw, PreviewSource{Kind: SourceSample}); codeOf(err) != CodeExportMismatch {
		t.Errorf("document of another export: %v", err)
	}
}

func TestBuiltinRendererRendersEveryExportWithItsSampleData(t *testing.T) {
	for _, kind := range engine.Kinds {
		pdf, filename, err := BuiltinRenderer{}.RenderEffective(t.Context(), kind, engine.SampleData(kind), nil)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if !strings.HasPrefix(string(pdf), "%PDF-") || !strings.HasSuffix(filename, ".pdf") {
			t.Errorf("%s: %q, %d bytes", kind, filename, len(pdf))
		}
	}
	if _, _, err := (BuiltinRenderer{}).RenderEffective(t.Context(), "letter", nil, nil); !errors.Is(err, apperror.NotFound) {
		t.Errorf("unknown export: %v", err)
	}
}

func TestSetAccentChangesOnlyTheAccentColourOfTheTemplate(t *testing.T) {
	doc := engine.Builtin(engine.KindWiRef)
	SetAccent(&doc, "#C0FFEE")
	var accent, other engine.Color
	for _, c := range doc.Styles.Colors {
		switch c.ID {
		case accentColorID:
			accent = c.Value
		case "text":
			other = c.Value
		}
	}
	if accent != "#c0ffee" || other != engine.Builtin(engine.KindWiRef).Styles.Colors[0].Value {
		t.Fatalf("accent %q, text %q", accent, other)
	}
	for _, bad := range []string{"", "red", "#12345", "#12345g", "url(x)"} {
		doc := engine.Builtin(engine.KindWiRef)
		SetAccent(&doc, bad)
		if doc.Styles.Colors[3].Value != engine.Builtin(engine.KindWiRef).Styles.Colors[3].Value {
			t.Errorf("accent changed for %q", bad)
		}
	}
}

func TestAssetFileNamesAreChecked(t *testing.T) {
	if name, err := cleanFileName("  logo.png "); err != nil || name != "logo.png" {
		t.Fatalf("%q %v", name, err)
	}
	for _, bad := range []string{"", "   ", "a\x00b", "a\nb", strings.Repeat("x", maxFileNameLength+1), "\xff"} {
		if _, err := cleanFileName(bad); codeOf(err) != CodeInvalidFileName {
			t.Errorf("%q accepted: %v", bad, err)
		}
	}
}

func TestPublishRefusalListsOnlyTheErrors(t *testing.T) {
	err := hasProblems([]engine.Problem{
		{NodeID: "a", Severity: engine.SeverityError, Message: "unknown variable"},
		{NodeID: "b", Severity: engine.SeverityWarning, Message: "ignored"},
	})
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || appErr.HTTPStatus != http.StatusUnprocessableEntity || appErr.Code != CodeHasProblems {
		t.Fatalf("err = %v", err)
	}
	listed := appErr.Details["problems"].([]map[string]any)
	if len(listed) != 1 || listed[0]["nodeId"] != "a" {
		t.Fatalf("problems = %+v", listed)
	}
}
