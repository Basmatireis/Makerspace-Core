package orders

import (
	"bytes"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/ledongthuc/pdf"
	"github.com/shopspring/decimal"
)

func TestCashbookLayoutFillsFourteenThenSeventeenRows(t *testing.T) {
	cases := []struct {
		rows int
		want []cashbookSheet
	}{
		{0, []cashbookSheet{{0, 0}}},
		{1, []cashbookSheet{{0, 1}}},
		{14, []cashbookSheet{{0, 14}}},
		{15, []cashbookSheet{{0, 14}, {14, 15}}},
		{31, []cashbookSheet{{0, 14}, {14, 31}}},
		{40, []cashbookSheet{{0, 14}, {14, 31}, {31, 40}}},
	}
	for _, c := range cases {
		got := layoutCashbook(c.rows)
		if len(got) != len(c.want) {
			t.Fatalf("%d rows: sheets %+v", c.rows, got)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("%d rows: sheet %d = %+v, want %+v", c.rows, i, got[i], c.want[i])
			}
		}
	}
	// Both sheet kinds end where the form ends, above the footer.
	for _, g := range []kbSheet{kbFirstSheet, kbNextSheet} {
		top := kbTop + kbTitleRow + kbOrgRow + kbYearRow
		if g.rows == CashbookSheetRows {
			top = kbTop
		}
		bottom := top + g.carry + g.head + float64(g.rows)*g.body + g.sum
		if bottom < 240.5 || bottom > 241.5 {
			t.Fatalf("sheet with %d rows ends at %.2f mm", g.rows, bottom)
		}
	}
	if ops, err := parseLetterhead(kassabuchLetterhead); err != nil || len(ops) < 1000 {
		t.Fatalf("letterhead: %d ops, %v", len(ops), err)
	}
	if _, err := parseLetterhead("#12345\nF"); err == nil {
		t.Fatal("bad colour accepted")
	}
	if _, err := parseLetterhead("M 1"); err == nil {
		t.Fatal("short operator accepted")
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

func requireTexts(t *testing.T, page string, texts ...string) {
	t.Helper()
	for _, text := range texts {
		if !strings.Contains(page, text) {
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
		data, err := renderCashbookPDF(b)
		if err != nil {
			t.Fatal(err)
		}
		pages := pdfPages(t, data)
		if len(pages) != c.pages {
			t.Fatalf("%d entries: %d pages", c.entries, len(pages))
		}
		requireTexts(t, pages[0], "Kassabuch", "Studienvertretung", "Makerspace (Studienlabor)", "Wirtschaftsjahr",
			"2026 · Zeitraum 01.10.2026 – 31.10.2026", "Bestand/Übertrag von", "vorheriger Seite", "Kassierer*in",
			"Einnahme", "Ausgabe", "1.000,00", "Summe/Bestand")
		if c.entries > 0 {
			requireTexts(t, pages[0], "Einnahme O-2026-000123 · Jürgen Weiß", "Anna Kassierer", "01.10.2026", "234,50")
		}
		// The first sheet closes with the balance after its last entry, which the next sheet carries over.
		firstClose := b.opening
		if c.entries > 0 {
			firstClose = b.lines[min(c.entries, CashbookFirstSheetRows)-1].balance
		}
		requireTexts(t, pages[0], germanAmount(firstClose))
		for i, page := range pages[1 : len(pages)-1] {
			requireTexts(t, page, "Bestand/Übertrag von", "Summe/Bestand", "Nr.", "Kassierer*in",
				strconv.Itoa(CashbookFirstSheetRows+i*CashbookSheetRows+1))
			if strings.Contains(page, "Wirtschaftsjahr") || strings.Contains(page, "Gesamtsumme") {
				t.Fatalf("%d entries: head block or totals on sheet %d", c.entries, i+2)
			}
		}
		if c.entries > CashbookFirstSheetRows {
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
	data, err := renderCashbookPDF(b)
	if err != nil {
		t.Fatal(err)
	}
	pages := pdfPages(t, data)
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
	// One entry sheet and the final sheet with the totals and signatures.
	if len(pages) != 2 || !strings.Contains(pages[0], "Entnahme · Bankeinzahlung (Bar)") ||
		!strings.Contains(pages[0], "Rückzahlung O-") || !strings.Contains(pages[1], "Gesamtsumme") {
		t.Fatalf("%q", pages)
	}
	query.From = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	_, err = f.s.ExportCashbook(ctx, f.p, query)
	wantCode(t, err, "validation_failed")
}
