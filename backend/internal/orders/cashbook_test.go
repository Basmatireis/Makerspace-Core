package orders

import (
	"bytes"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/pdftest"
	"github.com/google/uuid"
	"github.com/ledongthuc/pdf"
	"github.com/shopspring/decimal"
)

func sampleCashbook(n int, contents CashbookContents) cashbook {
	vienna, _ := time.LoadLocation("Europe/Vienna")
	b := cashbook{
		from:        time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC),
		to:          time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC),
		contents:    contents,
		location:    vienna,
		withBalance: contents == CashbookCashRegister,
		withOrders:  true,
		opening:     decimal.RequireFromString("1000"),
	}
	balance := b.opening
	for i := range n {
		line := cashbookLine{
			at:             time.Date(2026, 10, 1+i%28, 9, 0, 0, 0, vienna),
			reference:      "P-2026-0000" + string(rune('0'+i%10)),
			kind:           JournalReceipt,
			method:         PaymentCash,
			effect:         decimal.RequireFromString("234.5"),
			orderReference: "O-2026-000123",
			contents:       orderContents{processes: []string{"FDM 3D printing"}, materials: true},
			customer:       "Jürgen Weiß",
			recordedBy:     "Anna Kassierer",
		}
		if i%3 == 1 {
			line.kind, line.effect, line.movementReason, line.note = JournalWithdrawal, decimal.RequireFromString("-50"),
				CashReasonOther, "=cmd; \"quoted\""
		}
		if i%3 == 2 {
			line.kind, line.effect, line.countReference, line.countReason = JournalCorrection,
				decimal.RequireFromString("-1.2"), "K-2026-0001", CountReasonCountingError
			line.method = PaymentCash
		}
		balance = balance.Add(line.effect)
		line.balance = balance
		in, out := b.amounts(line)
		b.totalIn, b.totalOut = b.totalIn.Add(in), b.totalOut.Add(out)
		b.lines = append(b.lines, line)
	}
	b.closing = balance
	return b
}

func TestCashbookCSVFormat(t *testing.T) {
	data := string(sampleCashbook(3, CashbookCashRegister).csv())
	if !strings.HasPrefix(data, "\xef\xbb\xbf") {
		t.Fatal("no byte order mark")
	}
	rows := strings.Split(strings.TrimSuffix(strings.TrimPrefix(data, "\xef\xbb\xbf"), "\r\n"), "\r\n")
	want := []string{
		"Date;Reference;Description;In;Out;Balance",
		"01.10.2026;;Opening balance;;;1000,00",
		"01.10.2026;P-2026-00000;Receipt O-2026-000123 · FDM 3D printing and materials · Jürgen Weiß;234,50;;1234,50",
		`02.10.2026;P-2026-00001;"Withdrawal · Other · =cmd; ""quoted""";;50,00;1184,50`,
		"03.10.2026;P-2026-00002;Correction · Count difference K-2026-0001 · Counting error;;1,20;1183,30",
	}
	if len(rows) != len(want) {
		t.Fatalf("rows %q", rows)
	}
	for i := range want {
		if rows[i] != want[i] {
			t.Fatalf("row %d = %q, want %q", i, rows[i], want[i])
		}
	}
	all := string(sampleCashbook(1, CashbookAllPayments).csv())
	if !strings.Contains(all, "Date;Reference;Description;In;Out\r\n") ||
		!strings.Contains(all, "Jürgen Weiß (cash);234,50;\r\n") || strings.Contains(all, "Balance") {
		t.Fatalf("all payments %q", all)
	}
	if csvCell("-5,00") != "-5,00" || csvCell("@SUM(A1)") != "'@SUM(A1)" || csvCell("+1 phone") != "'+1 phone" {
		t.Fatal("formula guard")
	}
	if germanAmount(decimal.RequireFromString("1234567.5")) != "1.234.567,50" ||
		germanAmount(decimal.RequireFromString("-12")) != "-12,00" || germanAmount(decimal.Zero) != "0,00" {
		t.Fatal("german amounts")
	}
}

// renderCashbook renders a cashbook with the built-in cashbook template.
func renderCashbook(t *testing.T, b cashbook, can func(string) bool) []byte {
	t.Helper()
	data, _, err := pdftemplates.BuiltinRenderer{}.RenderEffective(
		t.Context(), engine.KindCashbook, b.pdfData(), can)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func allowAll(string) bool { return true }

func pdfPages(t *testing.T, data []byte) []string {
	t.Helper()
	reader, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	pages := []string{}
	for i := 1; i <= reader.NumPage(); i++ {
		text, err := reader.Page(i).GetPlainText(nil)
		if err != nil {
			t.Fatal(err)
		}
		pages = append(pages, text)
	}
	return pages
}

func requireTexts(t *testing.T, page string, texts ...string) {
	t.Helper()
	// Text extraction breaks lines and spaces where the layout does, so the comparison ignores white space.
	squash := func(text string) string { return strings.Join(strings.Fields(text), "") }
	for _, text := range texts {
		if !strings.Contains(squash(page), squash(text)) {
			t.Fatalf("page lacks %q: %s", text, page)
		}
	}
}

func TestCashbookPDFFollowsTheKassabuchSheets(t *testing.T) {
	finalTexts := []string{
		"Gesamtsumme (aller Einnahmen & Ausgaben)", "Anfangsbestand (Wirtschaftsjahr)", "Endbestand (Wirtschaftsjahr)",
		"Kostenstellenverantwortliche/r", "Wirtschaftsreferent/in", "Vorsitzende/r", "Name, Datum & Unterschrift",
	}
	for _, c := range []struct{ entries, pages int }{{0, 2}, {1, 2}, {14, 2}, {15, 3}, {40, 4}} {
		b := sampleCashbook(c.entries, CashbookCashRegister)
		pages := pdfPages(t, renderCashbook(t, b, allowAll))
		if len(pages) != c.pages {
			t.Fatalf("%d entries: %d pages", c.entries, len(pages))
		}
		requireTexts(t, pages[0], "Kassabuch", "Studienvertretung", "Makerspace (Studienlabor)", "Wirtschaftsjahr",
			"2026 · Zeitraum 01.10.2026 – 31.10.2026", "Bestand/Übertrag von", "vorheriger Seite", "Kassierer*in",
			"Einnahme", "Ausgabe", "1.000,00", "Summe/Bestand")
		if c.entries > 0 {
			requireTexts(t, pages[0], "Einnahme O-2026-000123 · FDM 3D printing\nund Material\n", "Anna Kassierer",
				"01.10.2026", "234,50")
			// The sheet leaves the customer out; the CSV keeps it.
			if strings.Contains(pages[0], "Jürgen Weiß") {
				t.Fatalf("customer on the sheet: %s", pages[0])
			}
		}
		// The first sheet closes with the balance after its last entry, which the next sheet carries over.
		firstClose := b.opening
		if c.entries > 0 {
			firstClose = b.lines[min(c.entries, 14)-1].balance
		}
		requireTexts(t, pages[0], germanAmount(firstClose))
		for i, page := range pages[1 : len(pages)-1] {
			requireTexts(t, page, "Bestand/Übertrag von", "Summe/Bestand", "Nr.", "Kassierer*in",
				strconv.Itoa(14+i*17+1))
			if strings.Contains(page, "Wirtschaftsjahr") || strings.Contains(page, "Gesamtsumme") {
				t.Fatalf("%d entries: head block or totals on sheet %d", c.entries, i+2)
			}
		}
		if c.entries > 14 {
			requireTexts(t, pages[1], germanAmount(firstClose), strconv.Itoa(min(c.entries, 31)))
		}
		final := pages[len(pages)-1]
		requireTexts(t, final, finalTexts...)
		requireTexts(t, final, germanAmount(b.totalIn), germanAmount(b.totalOut), "1.000,00", germanAmount(b.closing))
		if strings.Contains(final, "Summe/Bestand") || strings.Contains(final, "Kassierer*in") {
			t.Fatalf("%d entries: entry table on the final sheet", c.entries)
		}
	}

	b := sampleCashbook(2, CashbookAllPayments)
	pages := pdfPages(t, renderCashbook(t, b, allowAll))
	if len(pages) != 2 {
		t.Fatalf("all payments: %d pages", len(pages))
	}
	// Without a balance the sheet sums both columns and no opening or closing balance appears anywhere.
	requireTexts(t, pages[0], "alle Zahlungen", "(Bar)", "Summe/Bestand", "234,50", "50,00")
	requireTexts(t, pages[1], finalTexts...)
	requireTexts(t, pages[1], "234,50", "50,00")
	if strings.Contains(pages[0]+pages[1], "1.000,00") || strings.Contains(pages[0]+pages[1], "1.184,50") {
		t.Fatalf("balance without the cash register: %q", pages)
	}
}

func TestCashbookExportFromTheRegister(t *testing.T) {
	f, _ := journalFixture(t)
	ctx := t.Context()
	query := CashbookExportQuery{
		From:     time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC),
		To:       time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC),
		Contents: CashbookCashRegister,
		Format:   CashbookCSV,
	}
	file, err := f.s.ExportCashbook(ctx, f.p, query)
	if err != nil || file.Filename != "cashbook-cash-register-2026-10-31-2026-10-31.csv" {
		t.Fatalf("%v %s", err, file.Filename)
	}
	rows := strings.Split(strings.TrimSpace(string(file.Data)), "\r\n")
	// Opening 50; withdrawal 5, correction 1, receipt 20, refund 20; the count itself moves nothing.
	if len(rows) != 6 || !strings.HasSuffix(rows[1], ";50,00") || !strings.HasSuffix(rows[2], ";;5,00;45,00") ||
		!strings.Contains(rows[3], "Count difference K-") || !strings.HasSuffix(rows[5], ";;20,00;44,00") ||
		!strings.Contains(rows[4], " · Service · Example institute") || !strings.Contains(rows[5], " · Service · returned") {
		t.Fatalf("%q", rows)
	}
	cashier := f.principal(t, authorization.PaymentsRead, authorization.CashMovementsRead)
	file, err = f.s.ExportCashbook(ctx, cashier, query)
	// Without orders.read the lines keep their references but neither customer nor what the order charged.
	if err != nil || strings.Contains(string(file.Data), "Example institute") || strings.Contains(string(file.Data), "Service") {
		t.Fatalf("customer without orders.read: %v %s", err, file.Data)
	}
	_, err = f.s.ExportCashbook(ctx, f.principal(t, authorization.PaymentsRead), query)
	denied(t, err)

	query.Contents, query.Format = CashbookAllPayments, CashbookPDF
	query.From = time.Date(2026, 10, 30, 0, 0, 0, 0, time.UTC)
	file, err = f.s.ExportCashbook(ctx, f.p, query)
	if err != nil || file.ContentType != "application/pdf" {
		t.Fatalf("%v %s", err, file.ContentType)
	}
	pages := pdfPages(t, file.Data)
	// One entry sheet and the final sheet with the totals and signatures.
	if len(pages) != 2 || !strings.Contains(pages[0], "Entnahme · Bankeinzahlung (Bar)") ||
		!strings.Contains(pages[0], "Rückzahlung O-") || !strings.Contains(pages[1], "Gesamtsumme") {
		t.Fatalf("%q", pages)
	}
	query.From = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	_, err = f.s.ExportCashbook(ctx, f.p, query)
	wantCode(t, err, "validation_failed")
}

func TestCashbookSummarySaysWhatAnOrderCharged(t *testing.T) {
	cases := []struct {
		name     string
		contents orderContents
		english  string
		german   string
	}{
		{"nothing", orderContents{}, "", ""},
		{"single kind", orderContents{processes: []string{"FDM 3D printing"}, materials: true},
			"FDM 3D printing and materials", "FDM 3D printing und Material"},
		{"several kinds", orderContents{processes: []string{"Laser cutting", "FDM 3D printing"}, materials: true},
			"Laser cutting, FDM 3D printing and materials", "Laser cutting, FDM 3D printing und Material"},
		{"machine time only", orderContents{processes: []string{"Laser cutting"}}, "Laser cutting", "Laser cutting"},
		{"stock sale", orderContents{goods: []string{"Filament", "Parts"}}, "Filament, Parts", "Filament, Parts"},
		{"jobs and stock", orderContents{processes: []string{"FDM 3D printing"}, materials: true, goods: []string{"Parts"}},
			"FDM 3D printing and materials, Parts", "FDM 3D printing und Material, Parts"},
		{"no process name", orderContents{materials: true}, "Machine use and materials", "Maschinennutzung und Material"},
		{"truncated", orderContents{processes: []string{"Laser cutting", "FDM 3D printing", "Embroidery"},
			materials: true, goods: []string{"Filament"}},
			"Laser cutting, FDM 3D printing, Embroidery and…", "Laser cutting, FDM 3D printing, Embroidery und…"},
		{"no dangling comma", orderContents{goods: []string{"Laser cutting service", "Filament spools in bulk", "Parts"}},
			"Laser cutting service, Filament spools in bulk…", "Laser cutting service, Filament spools in bulk…"},
	}
	for _, c := range cases {
		english, german := englishWords.summary(c.contents, MaxCashbookSummaryLength), germanWords.summary(c.contents, MaxCashbookSummaryLength)
		if english != c.english || german != c.german {
			t.Fatalf("%s: %q / %q", c.name, english, german)
		}
		if utf8.RuneCountInString(english) > MaxCashbookSummaryLength {
			t.Fatalf("%s: %d characters", c.name, utf8.RuneCountInString(english))
		}
	}
	got := collectOrderContents([]db.ListCashbookOrderContentsRow{
		{OrderID: uuid.Max, Kind: "machine_job", ProcessName: "Laser cutting"},
		{OrderID: uuid.Max, Kind: "inventory_item", ArticleCategory: "Filament"},
		{OrderID: uuid.Max, Kind: "machine_job", ProcessName: "FDM 3D printing", UsedMaterials: true},
		{OrderID: uuid.Max, Kind: "machine_job", ProcessName: "laser cutting"},
		{OrderID: uuid.Max, Kind: "inventory_item", ArticleCategory: "filament"},
		{OrderID: uuid.Max, Kind: "manual", Description: " Consulting "},
		{OrderID: uuid.Nil, Kind: "inventory_item", ArticleCategory: "Parts"},
	})
	if s := englishWords.summary(got[uuid.Max], MaxCashbookSummaryLength); s != "Laser cutting, FDM 3D printing and materials, F…" {
		t.Fatalf("collected %q", s)
	}
	if s := englishWords.summary(got[uuid.Nil], MaxCashbookSummaryLength); s != "Parts" {
		t.Fatalf("second order %q", s)
	}
}

func TestCashbookLinesNameTheOrderContents(t *testing.T) {
	printing := orderContents{processes: []string{"FDM 3D printing"}, materials: true}
	cases := []struct {
		line          cashbookLine
		english, more string
	}{
		{cashbookLine{kind: JournalReceipt, orderReference: "O-1", contents: printing, customer: "Ada"},
			"Receipt O-1 · FDM 3D printing and materials · Ada", "Einnahme O-1 · FDM 3D printing und Material · Ada"},
		{cashbookLine{kind: JournalRefund, orderReference: "O-1", contents: printing, paymentReason: "returned"},
			"Refund O-1 · FDM 3D printing and materials · returned",
			"Rückzahlung O-1 · FDM 3D printing und Material · returned"},
		{cashbookLine{kind: JournalCorrection, orderReference: "O-1", contents: printing, paymentReason: "typo"},
			"Correction O-1 · FDM 3D printing and materials · typo",
			"Korrektur O-1 · FDM 3D printing und Material · typo"},
		{cashbookLine{kind: JournalReceipt, orderReference: "O-2", customer: "Ada"}, "Receipt O-2 · Ada", "Einnahme O-2 · Ada"},
	}
	for _, c := range cases {
		if got := englishWords.describe(c.line, false, MaxCashbookSummaryLength); got != c.english {
			t.Fatalf("english %q, want %q", got, c.english)
		}
		if got := germanWords.describe(c.line, false, MaxCashbookSummaryLength); got != c.more {
			t.Fatalf("german %q, want %q", got, c.more)
		}
	}
}

func TestCashbookOrderContentsFromTheItems(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	material := f.stockedMaterial(t, "PLA cashbook")
	start := time.Now().UTC().Add(-3 * time.Hour).Truncate(time.Second)
	job, e := f.jobs.CreateManualJob(ctx, f.p, machinelogbook.JobInput{
		MachineID:        f.machine,
		StartsAt:         start,
		EndsAt:           start.Add(time.Hour),
		Customer:         machinelogbook.PartyReference{Kind: "organization", ID: f.organization},
		OperatorPersonID: f.person,
		Outcome:          "successful",
		Usages:           []machinelogbook.UsageInput{f.use(t, material, "20")},
	}, nil)
	if e != nil {
		t.Fatal(e)
	}
	o := f.draft(t, true, "1")
	o, e = f.s.ChangeItem(ctx, f.p, o.ID, uuid.Nil, OrderItemInput{
		Kind:               ItemMachineJob,
		MachineJobID:       job.ID,
		ExpectedJobVersion: job.Version,
		ExpectedVersion:    o.Version,
	}, ItemActionAdd, nil)
	if e != nil {
		t.Fatal(e)
	}
	process := ""
	for _, item := range o.Items {
		if item.Snapshot != nil {
			process = item.Snapshot.ProcessName
		}
	}
	price := "2"
	o = f.addArticle(t, o, f.article(t, &price, "10", "5"), "1", "")
	removed := f.addArticle(t, f.emptyDraft(t), f.article(t, &price, "10", "5"), "1", "")
	removed, e = f.s.ChangeItem(ctx, f.p, removed.ID, removed.Items[0].ID, OrderItemInput{ExpectedVersion: removed.Version},
		ItemActionRemove, nil)
	if e != nil {
		t.Fatal(e)
	}
	rows, e := db.New(f.pool).ListCashbookOrderContents(ctx, []string{o.ID.String(), removed.ID.String()})
	if e != nil {
		t.Fatal(e)
	}
	contents := collectOrderContents(rows)
	got := contents[o.ID]
	if len(got.processes) != 1 || process == "" || got.processes[0] != process || !got.materials || len(got.goods) != 2 ||
		got.goods[0] != "Service" || !strings.HasPrefix(got.goods[1], "Parts ") {
		t.Fatalf("contents %+v", got)
	}
	if _, ok := contents[removed.ID]; ok {
		t.Fatalf("removed item counted: %+v", contents[removed.ID])
	}
}

func TestCashbookPDFDataMatchesTheSchema(t *testing.T) {
	pdftest.AssertData(t, engine.KindCashbook, sampleCashbook(3, CashbookCashRegister).pdfData())
	pdftest.AssertData(t, engine.KindCashbook, sampleCashbook(3, CashbookAllPayments).pdfData())
}

func TestCashbookPDFDataKeepsOrderDataToReadersWhoMaySeeIt(t *testing.T) {
	b := sampleCashbook(3, CashbookCashRegister)
	b.withOrders = true
	lines := b.pdfData()["lines"].([]map[string]any)
	receipt, withdrawal, correction := lines[0], lines[1], lines[2]
	if receipt["text"] != "Einnahme O-2026-000123" || receipt["orderSummary"] != "FDM 3D printing und Material" ||
		receipt["customer"] != "Jürgen Weiß" || receipt["kind"] != "Einnahme" || receipt["method"] != "Bar" {
		t.Fatalf("receipt %+v", receipt)
	}
	if withdrawal["text"] != "Entnahme · Sonstiges · =cmd; \"quoted\"" || withdrawal["orderSummary"] != "" ||
		correction["text"] != "Korrektur · Zählungsdifferenz K-2026-0001 · Zählfehler" || correction["orderSummary"] != "" {
		t.Fatalf("movements %+v / %+v", withdrawal, correction)
	}
	b.withOrders = false
	receipt = b.pdfData()["lines"].([]map[string]any)[0]
	if receipt["orderSummary"] != "" || receipt["customer"] != "" || receipt["text"] != "Einnahme O-2026-000123" {
		t.Fatalf("order data without orders.read: %+v", receipt)
	}
}

func TestCashbookPDFDataLeavesTheBalanceOutWithoutTheCashRegister(t *testing.T) {
	data := sampleCashbook(2, CashbookAllPayments).pdfData()
	totals, period := data["totals"].(map[string]any), data["period"].(map[string]any)
	if totals["opening"] != nil || totals["closing"] != nil || period["contents"] != "alle Zahlungen" {
		t.Fatalf("totals %+v period %+v", totals, period)
	}
	register := sampleCashbook(2, CashbookCashRegister).pdfData()
	if register["totals"].(map[string]any)["opening"] == nil || register["period"].(map[string]any)["contents"] != "" {
		t.Fatalf("register %+v", register)
	}
	spanning := sampleCashbook(0, CashbookCashRegister)
	spanning.from, spanning.to = time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC), time.Date(2027, 1, 31, 0, 0, 0, 0, time.UTC)
	if year := spanning.pdfData()["period"].(map[string]any)["businessYear"]; year != "2026/27" {
		t.Fatalf("business year %v", year)
	}
}

func TestCashbookPDFHidesOrderDataFromReadersWithoutPermission(t *testing.T) {
	b := sampleCashbook(1, CashbookCashRegister)
	b.withOrders = false
	pages := pdfPages(t, renderCashbook(t, b, func(string) bool { return false }))
	if strings.Contains(pages[0], "Jürgen Weiß") || strings.Contains(pages[0], "FDM 3D printing") {
		t.Fatalf("order data on the sheet: %s", pages[0])
	}
}
