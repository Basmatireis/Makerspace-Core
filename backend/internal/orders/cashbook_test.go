package orders

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/ledongthuc/pdf"
	"github.com/shopspring/decimal"
)

func TestCashbookLayoutPutsTwentyRowsOnASheet(t *testing.T) {
	type sheet struct {
		first, last, padding int
		header, carry, sum   bool
	}
	cases := []struct {
		name         string
		rows         int
		cashRegister bool
		want         []sheet
	}{
		{"empty", 0, true, []sheet{{0, 0, 6, true, true, true}}},
		{"short", 5, false, []sheet{{0, 5, 1, true, false, true}}},
		{"one full sheet moves the totals on", 20, true, []sheet{
			{0, 20, 0, true, true, false}, {20, 20, 0, false, true, true},
		}},
		{"full sheet without balance", 20, false, []sheet{
			{0, 20, 0, true, false, false}, {20, 20, 0, false, true, true},
		}},
		{"totals below the last rows", 25, true, []sheet{
			{0, 20, 0, true, true, false}, {20, 25, 0, false, true, true},
		}},
		{"three sheets", 45, true, []sheet{
			{0, 20, 0, true, true, false}, {20, 40, 0, false, true, false}, {40, 45, 0, false, true, true},
		}},
		{"full continuation sheet keeps the totals", 40, true, []sheet{
			{0, 20, 0, true, true, false}, {20, 40, 0, false, true, true},
		}},
	}
	for _, c := range cases {
		pages := layoutCashbook(c.rows, c.cashRegister)
		if len(pages) != len(c.want) {
			t.Fatalf("%s: %d sheets %+v", c.name, len(pages), pages)
		}
		for i, want := range c.want {
			got := sheet{pages[i].first, pages[i].last, pages[i].padding, pages[i].header, pages[i].carry, pages[i].summary}
			if got != want {
				t.Fatalf("%s sheet %d = %+v, want %+v", c.name, i, got, want)
			}
		}
		for _, page := range pages {
			if page.bottom() > kbContentBottom {
				t.Fatalf("%s: rows run into the footer: %+v", c.name, page)
			}
		}
	}
}

func sampleCashbook(n int, contents CashbookContents) cashbook {
	vienna, _ := time.LoadLocation("Europe/Vienna")
	b := cashbook{
		from:        time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC),
		to:          time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC),
		contents:    contents,
		location:    vienna,
		withBalance: contents == CashbookCashRegister,
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
		"01.10.2026;P-2026-00000;Receipt O-2026-000123 · Jürgen Weiß;234,50;;1234,50",
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

func TestCashbookPDFCarriesTheBalanceOverTwoSheets(t *testing.T) {
	data, err := renderCashbookPDF(sampleCashbook(25, CashbookCashRegister))
	if err != nil {
		t.Fatal(err)
	}
	pages := pdfPages(t, data)
	if len(pages) != 2 {
		t.Fatalf("%d pages", len(pages))
	}
	first, second := pages[0], pages[1]
	for _, want := range []string{"Kassabuch", "Makerspace (Studienlabor)", "Wirtschaftsjahr", "2026 · Zeitraum 01.10.2026",
		"vorheriger Seite", "1.000,00", "Kassierer*in", "Einnahme O-2026-000123", "Anna Kassierer", "HTU Graz"} {
		if !strings.Contains(first, want) {
			t.Fatalf("page 1 lacks %q: %s", want, first)
		}
	}
	if strings.Contains(first, "Summe") || strings.Contains(second, "Wirtschaftsjahr") {
		t.Fatal("totals on the first sheet or header block on the second")
	}
	for _, want := range []string{"vorheriger Seite", "Summe/Bestand", "Datum, Unterschrift Kassier*in",
		"Datum, Unterschrift Finanzreferat", "Körperschaft öffentlichen Rechts", "21", "25"} {
		if !strings.Contains(second, want) {
			t.Fatalf("page 2 lacks %q: %s", want, second)
		}
	}
	short, err := renderCashbookPDF(sampleCashbook(2, CashbookAllPayments))
	if err != nil {
		t.Fatal(err)
	}
	pages = pdfPages(t, short)
	if len(pages) != 1 || !strings.Contains(pages[0], "alle Zahlungen") || !strings.Contains(pages[0], "(Bar)") ||
		strings.Contains(pages[0], "Summe/Bestand") || !strings.Contains(pages[0], "Summe") {
		t.Fatalf("all payments %q", pages)
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
		!strings.Contains(rows[4], "Example institute") {
		t.Fatalf("%q", rows)
	}
	cashier := f.principal(t, authorization.PaymentsRead, authorization.CashMovementsRead)
	file, err = f.s.ExportCashbook(ctx, cashier, query)
	if err != nil || strings.Contains(string(file.Data), "Example institute") {
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
	if len(pages) != 1 || !strings.Contains(pages[0], "Entnahme · Bankeinzahlung (Bar)") ||
		!strings.Contains(pages[0], "Rückzahlung O-") {
		t.Fatalf("%q", pages)
	}
	query.From = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	_, err = f.s.ExportCashbook(ctx, f.p, query)
	wantCode(t, err, "validation_failed")
}
