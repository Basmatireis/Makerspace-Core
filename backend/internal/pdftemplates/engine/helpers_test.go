package engine

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	pdfread "github.com/ledongthuc/pdf"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func allowAll(string) bool { return true }

// testDoc is a plain A4 template of an export with the given body.
func testDoc(kind Kind, body ...Block) Document {
	doc := Document{
		SchemaVersion: SchemaVersion,
		Name:          "Test",
		Export:        kind,
		Page: Page{
			Size: "A4", Orientation: "portrait", Margins: [4]float64{30, 20, 22, 20}, Font: FontHelvetica,
			BaseSize: 10, Locale: "en",
		},
		Body: body,
	}
	normalize(&doc)
	return doc
}

func ptr[T any](v T) *T { return &v }

func render(t *testing.T, in RenderInput) Result {
	t.Helper()
	if in.Now.IsZero() {
		in.Now = SampleNow()
	}
	res, err := Render(context.Background(), in)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	return res
}

// pageTexts extracts the text of every page with all spaces removed, which keeps the assertions independent of
// how the PDF reader splits runs.
func pageTexts(t *testing.T, data []byte) []string {
	t.Helper()
	reader, err := pdfread.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("read pdf: %v", err)
	}
	var out []string
	for i := 1; i <= reader.NumPage(); i++ {
		var b strings.Builder
		for _, c := range reader.Page(i).Content().Text {
			b.WriteString(c.S)
		}
		out = append(out, strings.ReplaceAll(b.String(), " ", ""))
	}
	return out
}

func boxesOf(res Result, id string) []Box {
	var out []Box
	for _, b := range res.Boxes {
		if b.NodeID == id {
			out = append(out, b)
		}
	}
	return out
}

func pagesOf(res Result, id string) []int {
	var out []int
	for _, b := range boxesOf(res, id) {
		out = append(out, b.Page)
	}
	return out
}

func hasProblem(problems []Problem, nodeID, severity, fragment string) bool {
	for _, p := range problems {
		if p.NodeID == nodeID && p.Severity == severity && strings.Contains(p.Message, fragment) {
			return true
		}
	}
	return false
}

func errorCode(err error) string {
	var appErr *apperror.Error
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}
