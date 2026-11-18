package engine

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

func TestBuiltinsRenderWithoutProblems(t *testing.T) {
	logo := testPNG(t, 40, 40)
	for _, kind := range Kinds {
		res := render(t, RenderInput{
			Doc: Builtin(kind), Data: SampleData(kind), Can: allowAll, Logo: &Logo{Data: logo},
			Branding: SampleBranding(),
		})
		if len(res.Problems) > 0 || len(res.Redacted) > 0 {
			t.Fatalf("%s: problems %+v redacted %v", kind, res.Problems, res.Redacted)
		}
		if !bytes.HasPrefix(res.PDF, []byte("%PDF-")) || len(res.Pages) == 0 || len(res.Boxes) == 0 {
			t.Fatalf("%s: empty result", kind)
		}
		if !strings.HasSuffix(res.Filename, ".pdf") || strings.ContainsAny(res.Filename, " /{}") {
			t.Fatalf("%s: filename %q", kind, res.Filename)
		}
	}
}

func TestWiRefDefaultShowsTheSettingsTexts(t *testing.T) {
	data := SampleData(KindWiRef)
	// The data builder blanks what the wiRef settings switch off (invoicing.Document.PDFData).
	recipient := data["recipient"].(map[string]any)
	recipient["contactName"], recipient["contactChannel"], recipient["purchaseOrderReference"] = "", "", ""
	data["amounts"] = map[string]any{
		"total": decimal.RequireFromString("145"), "alreadyPaid": decimal.RequireFromString("20"),
		"toInvoice": decimal.RequireFromString("125"),
	}
	res := render(t, RenderInput{Doc: Builtin(KindWiRef), Data: data, Branding: SampleBranding()})
	text := pageTexts(t, res.PDF)[0]
	for _, want := range []string{
		"InvoicerequestW-2026-000123", "Pleaseinvoice", "Ordertotal", "-EUR20.00", "AmounttoinvoiceEUR125.00",
		"ApprovedbySamApprover", "Page1/1", "STUDIENLABORMAKERSPACE",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in %q", want, text)
		}
	}
	if strings.Contains(text, "Contactperson") || strings.Contains(text, "PurchaseOrder") {
		t.Errorf("switched-off parts are shown: %q", text)
	}
}

func TestCashbookDefaultRedactsOrderDataWithoutPermission(t *testing.T) {
	data := SampleData(KindCashbook)
	without := render(t, RenderInput{Doc: Builtin(KindCashbook), Data: data})
	if strings.Join(without.Redacted, ",") != "lines[].orderSummary" {
		t.Fatalf("redacted %v", without.Redacted)
	}
	page := pageTexts(t, without.PDF)[0]
	if strings.Contains(page, "FDM3Dprinting") || !strings.Contains(page, "EinnahmeO-2026-000301") {
		t.Fatalf("order summary leaked or text missing: %q", page)
	}
	with := render(t, RenderInput{Doc: Builtin(KindCashbook), Data: data, Can: func(p string) bool {
		return p == permissionOrdersRead
	}})
	if len(with.Redacted) != 0 || !strings.Contains(pageTexts(t, with.PDF)[0], "FDM3Dprinting") {
		t.Fatalf("with orders.read: %v", with.Redacted)
	}
	// 22 lines: a first sheet of 14 rows, a second sheet and the closing sheet.
	if len(with.Pages) != 3 || len(pagesOf(with, "sheets-cash-register")) != 2 || fmt.Sprint(pagesOf(with, "totals")) != "[2]" {
		t.Fatalf("pages %d, sheet %v, totals %v", len(with.Pages), pagesOf(with, "sheets-cash-register"), pagesOf(with, "totals"))
	}
	texts := pageTexts(t, with.PDF)
	// Carried balance of sheet two is the balance at the end of sheet one.
	if !strings.Contains(texts[0], "384,50") || !strings.Contains(texts[1], "384,50") || !strings.Contains(texts[2], "427,50") {
		t.Fatalf("sheet balances: %q / %q / %q", texts[0], texts[1], texts[2])
	}
}

func TestCashbookDefaultWithAllPayments(t *testing.T) {
	data := SampleData(KindCashbook)
	data["period"].(map[string]any)["contents"] = "alle Zahlungen"
	data["totals"] = map[string]any{"in": decimal.RequireFromString("10"), "out": decimal.Zero}
	res := render(t, RenderInput{Doc: Builtin(KindCashbook), Data: data})
	if len(pagesOf(res, "sheets-all-payments")) != 2 || len(pagesOf(res, "sheets-cash-register")) != 0 {
		t.Fatalf("sheets %v %v", pagesOf(res, "sheets-all-payments"), pagesOf(res, "sheets-cash-register"))
	}
	if !slices.Contains(res.Inactive, "sheets-cash-register") || slices.Contains(res.Inactive, "sheets-all-payments") {
		t.Fatalf("inactive %v", res.Inactive)
	}
	if first := pageTexts(t, res.PDF)[0]; !strings.Contains(first, "alleZahlungen") || !strings.Contains(first, "(Bar)") {
		t.Fatalf("first page %q", first)
	}
}

func itemsData(n int) Data {
	items := make([]map[string]any, n)
	for i := range items {
		items[i] = map[string]any{"description": fmt.Sprintf("Row %d", i+1), "amount": decimal.NewFromInt(int64(i))}
	}
	return Data{"items": items}
}

func itemTable(id string) Block {
	return Block{ID: id, Type: BlockTable, Source: "items", As: "item", RepeatHeader: true, Columns: []Column{
		{Header: "HEAD", Value: "{{item.description}}", Width: ptr(3.0)},
		{Header: "Amount", Value: "{{item.amount | amount}}", Width: ptr(1.0), Align: "right"},
	}}
}

func TestTableHeaderRepeatsOnEveryPage(t *testing.T) {
	res := render(t, RenderInput{Doc: testDoc(KindReceipt, itemTable("t")), Data: itemsData(80)})
	texts := pageTexts(t, res.PDF)
	if len(texts) < 2 {
		t.Fatalf("expected several pages, got %d", len(texts))
	}
	for i, text := range texts {
		if !strings.HasPrefix(text, "HEAD") {
			t.Errorf("page %d does not start with the header: %.40q", i+1, text)
		}
	}
	if !strings.Contains(texts[len(texts)-1], "Row80") {
		t.Fatal("last row missing")
	}
	without := itemTable("t")
	without.RepeatHeader = false
	res = render(t, RenderInput{Doc: testDoc(KindReceipt, without), Data: itemsData(80)})
	if strings.HasPrefix(pageTexts(t, res.PDF)[1], "HEAD") {
		t.Fatal("header repeated although repeatHeader is off")
	}
}

func TestTableMaxRowsBreakPages(t *testing.T) {
	table := itemTable("t")
	table.MaxRowsFirst, table.MaxRows = 2, 3
	res := render(t, RenderInput{Doc: testDoc(KindReceipt, table), Data: itemsData(8)})
	texts := pageTexts(t, res.PDF)
	if len(texts) != 3 {
		t.Fatalf("pages %d", len(texts))
	}
	if !strings.Contains(texts[0], "Row2") || strings.Contains(texts[0], "Row3") ||
		!strings.Contains(texts[1], "Row5") || strings.Contains(texts[1], "Row6") || !strings.Contains(texts[2], "Row8") {
		t.Fatalf("rows per page: %q", texts)
	}
}

func TestTableHeaderKeepsWithItsFirstRow(t *testing.T) {
	// The spacer leaves room for the header but not for header and first row.
	doc := testDoc(KindReceipt, Block{ID: "space", Type: BlockSpacer, Height: Num(237)}, itemTable("t"))
	res := render(t, RenderInput{Doc: doc, Data: itemsData(1)})
	if fmt.Sprint(pagesOf(res, "t")) != "[1]" {
		t.Fatalf("table pages %v", pagesOf(res, "t"))
	}
}

func TestPageBreakKeepWithNextAndOversizedItems(t *testing.T) {
	doc := testDoc(KindReceipt,
		Block{ID: "a", Type: BlockText, Text: "First"},
		Block{ID: "break", Type: BlockPageBreak},
		Block{ID: "b", Type: BlockText, Text: "Second"},
		Block{ID: "break2", Type: BlockPageBreak},
		Block{ID: "space", Type: BlockSpacer, Height: Num(238)},
		Block{ID: "heading", Type: BlockHeading, Text: "Heading"},
		Block{ID: "after", Type: BlockText, Text: "Body"},
		Block{ID: "huge", Type: BlockSpacer, Height: Num(400)},
	)
	res := render(t, RenderInput{Doc: doc})
	if fmt.Sprint(pagesOf(res, "a"), pagesOf(res, "b")) != "[0] [1]" {
		t.Fatalf("page break: %v %v", pagesOf(res, "a"), pagesOf(res, "b"))
	}
	if fmt.Sprint(pagesOf(res, "space"), pagesOf(res, "heading"), pagesOf(res, "after")) != "[2] [3] [3]" {
		t.Fatalf("keep with next: %v %v %v", pagesOf(res, "space"), pagesOf(res, "heading"), pagesOf(res, "after"))
	}
	if !hasProblem(res.Problems, "huge", SeverityWarning, "taller than the page") || fmt.Sprint(pagesOf(res, "huge")) != "[4]" {
		t.Fatalf("oversized: %+v %v", res.Problems, pagesOf(res, "huge"))
	}
}

func TestLayersFollowTheirPageSelector(t *testing.T) {
	rect := func(id string) Block {
		return Block{ID: id, Type: BlockRect, X: ptr(10.0), Y: ptr(10.0), W: ptr(5.0), H: ptr(5.0)}
	}
	doc := testDoc(KindReceipt, Block{ID: "x", Type: BlockText, Text: "1"}, Block{ID: "p1", Type: BlockPageBreak},
		Block{ID: "y", Type: BlockText, Text: "2"}, Block{ID: "p2", Type: BlockPageBreak},
		Block{ID: "z", Type: BlockText, Text: "3"})
	for _, pages := range []string{LayerAllPages, LayerFirstPage, LayerNextPages, LayerLastPage} {
		doc.Layers = append(doc.Layers, Layer{ID: "layer-" + pages, Type: "layer", Pages: pages, Elements: []Block{rect("r-" + pages)}})
	}
	doc.Layers = append(doc.Layers, Layer{ID: "hidden", Type: "layer", Pages: LayerAllPages, Hidden: true,
		Elements: []Block{rect("r-hidden")}})
	doc.Layers = append(doc.Layers, Layer{ID: "flowing", Type: "layer", Pages: LayerFirstPage, Elements: []Block{
		{ID: "flow-text", Type: BlockText, Text: "In a layer", X: ptr(100.0), Y: ptr(200.0), W: ptr(50.0)},
	}})
	res := render(t, RenderInput{Doc: doc})
	want := map[string]string{
		"r-all": "[0 1 2]", "r-first": "[0]", "r-next": "[1 2]", "r-last": "[2]", "r-hidden": "[]",
	}
	for _, layer := range doc.Layers {
		if len(boxesOf(res, layer.ID)) > 0 {
			t.Errorf("layer %s has a box of its own", layer.ID)
		}
	}
	if slices.Contains(res.Inactive, "r-hidden") || slices.Contains(res.Inactive, "r-next") {
		t.Errorf("inactive %v", res.Inactive)
	}
	for id, pages := range want {
		if got := fmt.Sprint(pagesOf(res, id)); got != pages {
			t.Errorf("%s on %s, want %s", id, got, pages)
		}
	}
	box := boxesOf(res, "flow-text")
	if len(box) != 1 || box[0].X != 100 || box[0].Y != 200 || box[0].W != 50 {
		t.Fatalf("flow block in a layer: %+v", box)
	}
}

func TestHeaderFooterAndBoxesUseTheBands(t *testing.T) {
	doc := testDoc(KindReceipt, Block{ID: "body", Type: BlockText, Text: "Body"})
	doc.Header = []Block{{ID: "head", Type: BlockText, Text: "Header {{page}}"}}
	doc.Footer = []Block{{ID: "foot", Type: BlockText, Text: "Page {{page}} of {{pages}}"}}
	res := render(t, RenderInput{Doc: doc})
	head, foot, body := boxesOf(res, "head")[0], boxesOf(res, "foot")[0], boxesOf(res, "body")[0]
	if head.Y != 10 || body.Y != 30 || math.Abs(foot.Y+foot.H-287) > 0.01 || body.X != 20 || body.W != 170 {
		t.Fatalf("head %+v body %+v foot %+v", head, body, foot)
	}
	if !strings.Contains(pageTexts(t, res.PDF)[0], "Page1of1") {
		t.Fatal("page locals missing")
	}
}

func TestStylesResolveReferences(t *testing.T) {
	doc := testDoc(KindReceipt)
	doc.Styles = Styles{
		Colors: []ColorStyle{{ID: "brand", Name: "Brand", Value: "#112233"}},
		Text: []TextStyle{{ID: "big", Name: "Big", Font: FontPlexSans, Size: Length{Ref: "pt"}, Weight: 600,
			LineHeight: 1.5, Color: "$c:brand"}},
		Sizes: []SizeStyle{{ID: "pt", Name: "Pt", Value: 14, Unit: "pt"}, {ID: "mm", Name: "Mm", Value: 7, Unit: "mm"}},
	}
	r := newRenderer(context.Background(), RenderInput{Doc: doc})
	own := Block{Size: Num(9), Weight: 400, Color: "#ff0000", LineHeight: 1.1}
	if st := r.blockStyle(&own, textDefaults{}); st.size != 9 || st.color != mustHex("#ff0000") || st.font != FontHelvetica {
		t.Fatalf("own values %+v", st)
	}
	own.TextStyle = "big"
	st := r.blockStyle(&own, textDefaults{})
	if st.size != 14 || st.weight != 600 || st.lineHeight != 1.5 || st.font != FontPlexSans || st.color != mustHex("#112233") {
		t.Fatalf("a text style overrides the node: %+v", st)
	}
	if got := r.pt(SizeRef("mm"), 0); math.Abs(got-7/ptToMM) > 1e-9 {
		t.Fatalf("mm style as points = %v", got)
	}
	if got := r.mm(SizeRef("pt"), 0); math.Abs(got-14*ptToMM) > 1e-9 {
		t.Fatalf("pt style as millimetres = %v", got)
	}
	if got := r.color("$c:missing", mustHex("#000001")); got != mustHex("#000001") {
		t.Fatal("unknown colour falls back")
	}
	if got := r.color(ColorTransparent, mustHex("#000001")); !got.none {
		t.Fatal("transparent draws nothing")
	}
}

func TestPaperFormatsAndOrientation(t *testing.T) {
	cases := []struct {
		page Page
		want PageSize
	}{
		{Page{Size: "A4", Orientation: "portrait"}, PageSize{210, 297}},
		{Page{Size: "A5", Orientation: "landscape"}, PageSize{210, 148}},
		{Page{Size: "L54", Orientation: "portrait"}, PageSize{54, 85.6}},
		{Page{Size: "DL", Orientation: "landscape"}, PageSize{210, 99}},
		{Page{Size: PaperCustom, Width: ptr(300.0), Height: ptr(100.0), Orientation: "portrait"}, PageSize{100, 300}},
	}
	for _, tc := range cases {
		if got := pageSize(tc.page); got != tc.want {
			t.Errorf("%+v = %+v", tc.page, got)
		}
	}
	doc := testDoc(KindReceipt, Block{ID: "t", Type: BlockText, Text: "Label"})
	doc.Page.Size, doc.Page.Orientation, doc.Page.Margins = "L62", "landscape", [4]float64{4, 4, 4, 4}
	res := render(t, RenderInput{Doc: doc})
	if len(res.Pages) != 1 || res.Pages[0] != (PageSize{100, 62}) {
		t.Fatalf("pages %+v", res.Pages)
	}
	if !bytes.Contains(res.PDF, []byte("/MediaBox [0 0 283.46 175.75]")) {
		t.Fatal("media box does not match the label size")
	}
}

func TestRenderStopsAtTheDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Render(ctx, RenderInput{Doc: Builtin(KindWiRef), Data: SampleData(KindWiRef)})
	if errorCode(err) != CodeRenderLimit {
		t.Fatalf("err %v", err)
	}
	expired, stop := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer stop()
	if _, err := Render(expired, RenderInput{Doc: Builtin(KindCashbook), Data: SampleData(KindCashbook)}); errorCode(err) != CodeRenderLimit {
		t.Fatalf("expired: %v", err)
	}
}

func TestRenderStopsAtThePageLimit(t *testing.T) {
	var body []Block
	for i := range MaxPages + 1 {
		body = append(body, Block{ID: fmt.Sprintf("b%d", i), Type: BlockText, Text: "x"},
			Block{ID: fmt.Sprintf("p%d", i), Type: BlockPageBreak})
	}
	_, err := Render(context.Background(), RenderInput{Doc: testDoc(KindReceipt, body...)})
	if errorCode(err) != CodeRenderLimit {
		t.Fatalf("err %v", err)
	}
}

func TestNestedLoopsHitTheItemLimit(t *testing.T) {
	data := itemsData(5000)
	doc := testDoc(KindReceipt, Block{ID: "outer", Type: BlockRepeat, Source: "items", As: "outer",
		Blocks: []Block{itemTable("inner")}})
	started := time.Now()
	_, err := Render(context.Background(), RenderInput{Doc: doc, Data: data})
	if errorCode(err) != CodeRenderLimit || time.Since(started) > RenderTimeout {
		t.Fatalf("err %v after %v", err, time.Since(started))
	}
}

func TestPlexFacesEmbed(t *testing.T) {
	doc := testDoc(KindReceipt,
		Block{ID: "r", Type: BlockText, Text: "Regular ÄÖÜ ß € ☃ 😀"},
		Block{ID: "m", Type: BlockText, Text: "Medium", Weight: 500},
		Block{ID: "s", Type: BlockText, Text: "SemiBold", Weight: 600},
	)
	doc.Page.Font = FontPlexSans
	res := render(t, RenderInput{Doc: doc})
	for _, face := range []string{"/utf8plexsans\n", "/utf8plexsansmedium\n", "/utf8plexsansB\n"} {
		if !bytes.Contains(res.PDF, []byte("/BaseFont "+face)) {
			t.Errorf("font %s not embedded", face)
		}
	}
	if !strings.Contains(pageTexts(t, res.PDF)[0], "ÄÖÜß") {
		t.Fatalf("text %q", pageTexts(t, res.PDF)[0])
	}
}

func testPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := range w {
		img.Set(x, x%h, color.RGBA{R: 200, A: 255})
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func testJPEG(t *testing.T) []byte {
	t.Helper()
	var out bytes.Buffer
	if err := jpeg.Encode(&out, image.NewGray(image.Rect(0, 0, 8, 4)), nil); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

const testSVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" width="20mm">` +
	`<script>alert(1)</script><g transform="scale(2)"><path d="M0 0 L20 0 L20 10 Z"/><path d="M2 2 h4 v4 h-4 z"/>` +
	`<path d="M1 1 A 1 1 0 0 0 2 2"/></g><text>ignored</text></svg>`

func TestInspectAssetSniffsAndBoundsUploads(t *testing.T) {
	if info, err := InspectAsset(testPNG(t, 30, 20)); err != nil || info != (AssetInfo{ContentTypePNG, 30, 20}) {
		t.Fatalf("png %+v %v", info, err)
	}
	if info, err := InspectAsset(testJPEG(t)); err != nil || info != (AssetInfo{ContentTypeJPEG, 8, 4}) {
		t.Fatalf("jpeg %+v %v", info, err)
	}
	if info, err := InspectAsset([]byte(testSVG)); err != nil || info.ContentType != ContentTypeSVG || info.Width != 20 {
		t.Fatalf("svg %+v %v", info, err)
	}
	var gifData bytes.Buffer
	_ = gif.Encode(&gifData, image.NewPaletted(image.Rect(0, 0, 2, 2), color.Palette{color.Black}), nil)
	rejected := map[string][]byte{
		"too many pixels": testPNG(t, MaxAssetPixels+1, 1),
		"too large":       append(testPNG(t, 2, 2), make([]byte, MaxAssetBytes)...),
		"gif":             gifData.Bytes(),
		"svg without paths": []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
			`<rect width="10" height="10"/></svg>`),
		"html":           []byte("<html><svg></svg></html>"),
		"truncated png":  testPNG(t, 4, 4)[:20],
		"svg with xxe":   []byte(`<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 1 1"><path d="&x;"/></svg>`),
		"plain text":     []byte("hello"),
		"empty":          nil,
		"svg wrong root": []byte(`<?xml version="1.0"?><html><svg viewBox="0 0 1 1"><path d="M0 0 L1 1"/></svg></html>`),
	}
	for name, data := range rejected {
		if _, err := InspectAsset(data); errorCode(err) != CodeAssetInvalid {
			t.Errorf("%s: err %v", name, err)
		}
	}
}

type testAssets map[string][]byte

func (a testAssets) Asset(_ context.Context, id string) (Asset, error) {
	data, ok := a[id]
	if !ok {
		return Asset{}, ErrAssetNotFound
	}
	return Asset{Data: data}, nil
}

func TestPicturesGraphicsAndCodes(t *testing.T) {
	const (
		pngID = "01934d6e-0000-7000-8000-000000000001"
		svgID = "01934d6e-0000-7000-8000-000000000002"
		gone  = "01934d6e-0000-7000-8000-000000000003"
	)
	doc := testDoc(KindReceipt,
		Block{ID: "picture", Type: BlockPicture, Asset: pngID, W: ptr(30.0), H: ptr(20.0)},
		Block{ID: "svg", Type: BlockGraphic, Art: artAssetPrefix + svgID, W: ptr(40.0), H: ptr(20.0), Color: "#ff0000"},
		Block{ID: "missing", Type: BlockPicture, Asset: gone, W: ptr(10.0), H: ptr(10.0)},
		Block{ID: "svg-as-picture", Type: BlockPicture, Asset: svgID, W: ptr(10.0), H: ptr(10.0)},
		Block{ID: "letterhead", Type: BlockGraphic, Art: ArtLetterhead, W: ptr(42.0), H: ptr(59.4)},
		Block{ID: "qr", Type: BlockQR, Value: "{{order.number}}", W: ptr(20.0), H: ptr(20.0)},
		Block{ID: "barcode", Type: BlockBarcode, Value: "{{order.number}}", W: ptr(60.0), H: ptr(15.0)},
		Block{ID: "qr-long", Type: BlockQR, Value: strings.Repeat("x", 3000), W: ptr(20.0), H: ptr(20.0)},
		Block{ID: "barcode-umlaut", Type: BlockBarcode, Value: "ÄÖÜ", W: ptr(60.0), H: ptr(15.0), ShowText: ptr(false)},
	)
	res := render(t, RenderInput{
		Doc: doc, Data: SampleData(KindReceipt), Can: allowAll,
		Assets: testAssets{pngID: testPNG(t, 30, 20), svgID: []byte(testSVG)},
	})
	for _, id := range []string{"picture", "svg", "letterhead", "qr", "barcode"} {
		if len(boxesOf(res, id)) != 1 || hasProblem(res.Problems, id, SeverityWarning, "") {
			t.Errorf("%s: boxes %v problems %+v", id, boxesOf(res, id), res.Problems)
		}
	}
	for _, id := range []string{"missing", "svg-as-picture", "qr-long", "barcode-umlaut"} {
		if !hasProblem(res.Problems, id, SeverityWarning, "") {
			t.Errorf("%s: no warning in %+v", id, res.Problems)
		}
	}
	if !strings.Contains(pageTexts(t, res.PDF)[0], "O-2026-000311") {
		t.Fatal("barcode text missing")
	}
	noAssets := render(t, RenderInput{Doc: testDoc(KindReceipt, doc.Body[0])})
	if !hasProblem(noAssets.Problems, "picture", SeverityWarning, "not available") {
		t.Fatalf("without an asset source: %+v", noAssets.Problems)
	}
}

func TestInterlacedOrBrokenImagesDoNotBreakTheDocument(t *testing.T) {
	const id = "01934d6e-0000-7000-8000-000000000009"
	broken := testPNG(t, 4, 4)
	// Corrupt the image data but keep the header that InspectAsset reads.
	broken = append(broken[:40:40], bytes.Repeat([]byte{1}, 40)...)
	doc := testDoc(KindReceipt, Block{ID: "p", Type: BlockPicture, Asset: id, W: ptr(10.0), H: ptr(10.0)},
		Block{ID: "after", Type: BlockText, Text: "Still here"})
	res := render(t, RenderInput{Doc: doc, Assets: testAssets{id: broken}})
	if !hasProblem(res.Problems, "p", SeverityWarning, "") || !strings.Contains(pageTexts(t, res.PDF)[0], "Stillhere") {
		t.Fatalf("problems %+v", res.Problems)
	}
}

func TestFlowBlocksRender(t *testing.T) {
	doc := testDoc(KindReceipt,
		Block{ID: "value", Type: BlockValue, Label: "Total", Value: "{{order.total | currency}}"},
		Block{ID: "list", Type: BlockList, Source: "items", As: "item", Text: "{{item.description}}", Style: "number"},
		Block{ID: "empty-list", Type: BlockList, Source: "payments", As: "p", Text: "{{p.reference}}", EmptyText: "Nothing"},
		Block{ID: "fields", Type: BlockFields, Boxed: true, Rows: []FieldRow{{Label: "A", Value: "1", Bold: true}}},
		Block{ID: "switch", Type: BlockSwitch, Path: "order.number", Cases: []SwitchCase{
			{Value: "O-2026-000311", Blocks: []Block{{ID: "hit", Type: BlockText, Text: "Matched"}}},
		}, Else: []Block{{ID: "miss", Type: BlockText, Text: "Missed"}}},
		Block{ID: "repeat", Type: BlockRepeat, Source: "items", As: "item", Blocks: []Block{
			{ID: "repeat-text", Type: BlockText, Text: "{{index}}:{{item.unit}}"},
		}},
		Block{ID: "box", Type: BlockBox, Stroke: Num(0.3), Blocks: []Block{{ID: "in-box", Type: BlockText, Text: "Boxed"}}},
		Block{ID: "signatures", Type: BlockSignatures, Labels: []string{"Cashier", "Auditor"}},
		Block{ID: "checkbox", Type: BlockCheckbox, Label: "Paid", When: &Condition{Path: "order.paid", Op: OpGt, Value: "0"}},
		Block{ID: "input", Type: BlockInputLine, Label: "Signature"},
		Block{ID: "divider", Type: BlockDivider},
		Block{ID: "line", Type: BlockLine, W: ptr(50.0)},
		Block{ID: "ellipse", Type: BlockEllipse, W: ptr(20.0), H: ptr(10.0), Fill: "#eeeeee"},
	)
	data := SampleData(KindReceipt)
	data["payments"] = []map[string]any{}
	res := render(t, RenderInput{Doc: doc, Data: data, Can: allowAll})
	if len(res.Problems) > 0 {
		t.Fatalf("problems %+v", res.Problems)
	}
	text := pageTexts(t, res.PDF)[0]
	for _, want := range []string{"TotalEUR31.20", "1.FDM3Dprinting", "Nothing", "Matched", "1:h", "4:pc", "Boxed",
		"Cashier", "Auditor", "Paid", "Signature"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in %q", want, text)
		}
	}
	if strings.Contains(text, "Missed") {
		t.Error("switch took both branches")
	}
	if len(boxesOf(res, "repeat")) != 1 || len(boxesOf(res, "switch")) != 1 || len(boxesOf(res, "miss")) != 0 {
		t.Fatalf("container boxes %v %v", boxesOf(res, "repeat"), boxesOf(res, "switch"))
	}
}

func TestColumnsWithContentWidth(t *testing.T) {
	doc := testDoc(KindReceipt, Block{ID: "cols", Type: BlockColumns, Gap: Num(4), Columns: []Column{
		{Width: ptr(0.0), Blocks: []Block{{ID: "narrow", Type: BlockText, Text: "Hi"}}},
		{Width: ptr(1.0), Blocks: []Block{{ID: "wide", Type: BlockText, Text: "Rest"}}},
		{Width: ptr(0.0), Blocks: []Block{{ID: "empty", Type: BlockImage}}},
	}})
	res := render(t, RenderInput{Doc: doc})
	narrow, wide, logo := boxesOf(res, "narrow")[0], boxesOf(res, "wide")[0], boxesOf(res, "empty")
	// Without a logo the image keeps a square of its height (12 mm).
	if len(logo) != 1 || logo[0].W != 12 || logo[0].X != 178 {
		t.Fatalf("logo %+v", logo)
	}
	if narrow.X != 20 || narrow.W > 10 || math.Abs(wide.X-(narrow.X+narrow.W+4)) > 0.01 || math.Abs(wide.X+wide.W-174) > 0.01 {
		t.Fatalf("narrow %+v wide %+v", narrow, wide)
	}
}
