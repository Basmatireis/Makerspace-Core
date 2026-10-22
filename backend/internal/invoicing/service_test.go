package invoicing

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifications"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/testdb"
	"github.com/jackc/pgx/v5/pgxpool"
)

type sentMail struct {
	To, Subject string
	Cc          []string
	ReplyTo     string
	Content     notifications.Content
	Attachments []mailservice.Attachment
}

// fakeNotifier records what would have been mailed.
type fakeNotifier struct {
	mu   sync.Mutex
	sent []sentMail
	err  error
}

func (f *fakeNotifier) SendBrandedCC(
	_ context.Context,
	to string,
	cc []string,
	replyTo string,
	subject string,
	content notifications.Content,
	attachments ...mailservice.Attachment,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, sentMail{To: to, Cc: cc, ReplyTo: replyTo, Subject: subject, Content: content, Attachments: attachments})
	return nil
}

func (f *fakeNotifier) RenderBranded(_ context.Context, content notifications.Content) (string, string) {
	return notifications.RenderBranded(f.brand(), content)
}

func (f *fakeNotifier) Branding(context.Context) notifications.Branding { return f.brand() }

func (f *fakeNotifier) brand() notifications.Branding {
	return notifications.Branding{ApplicationName: "Test Makerspace", PrimaryColor: "#0f62fe"}
}

func (f *fakeNotifier) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

type settingsFixture struct {
	s        *Service
	pool     *pgxpool.Pool
	notifier *fakeNotifier
	admin    authorization.Principal
}

// principalWith returns a non-master principal holding exactly the given permissions through a role grant.
func principalWith(t *testing.T, pool *pgxpool.Pool, permissions ...authorization.Permission) authorization.Principal {
	t.Helper()
	person, account, role := ids.New(), ids.New(), ids.New()
	for _, step := range []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO people(id,first_name,last_name,phone) VALUES($1,'Settings','Test','test')", []any{person}},
		{"INSERT INTO accounts(id,person_id,status) VALUES($1,$2,'enabled')", []any{account, person}},
		{"INSERT INTO roles(id,name) VALUES($1,$2)", []any{role, "role-" + role.String()}},
		{"INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)", []any{person, role}},
	} {
		if _, err := pool.Exec(t.Context(), step.sql, step.args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, permission := range permissions {
		if _, err := pool.Exec(
			t.Context(),
			"INSERT INTO role_permission_grants(id,role_id,permission_id) VALUES($1,$2,$3)",
			ids.New(), role, string(permission),
		); err != nil {
			t.Fatal(err)
		}
	}
	principal, err := authorization.LoadPermissionsFrom(
		t.Context(), pool, authorization.Principal{AccountID: account, PersonID: person},
	)
	if err != nil {
		t.Fatal(err)
	}
	return principal
}

func newSettingsFixture(t *testing.T) *settingsFixture {
	t.Helper()
	pool := testdb.Pool(t)
	notifier := &fakeNotifier{}
	return &settingsFixture{
		s:        NewService(pool, notifier, nil),
		pool:     pool,
		notifier: notifier,
		admin:    principalWith(t, pool, authorization.InvoicingSettingsManage),
	}
}

func (f *settingsFixture) input(t *testing.T) SettingsInput {
	t.Helper()
	current, err := f.s.GetSettings(t.Context(), f.admin)
	if err != nil {
		t.Fatal(err)
	}
	return SettingsInput{
		Templates:       current.Templates,
		Enabled:         true,
		RecipientEmail:  "wiref@example.org",
		CCEmails:        []string{"office@example.org"},
		ReplyToEmail:    " lab@example.org ",
		ExpectedVersion: current.Version,
	}
}

func TestSettingsStartWithSendingSwitchedOffAndDocumentedDefaults(t *testing.T) {
	f := newSettingsFixture(t)
	got, err := f.s.GetSettings(t.Context(), f.admin)
	if err != nil {
		t.Fatal(err)
	}
	if got.Enabled || got.RecipientEmail != "" || got.ReplyToEmail != "" || got.Version != 1 || !got.ShowApprover {
		t.Fatalf("defaults %+v", got)
	}
	if err = ValidateTemplates(got.Templates); err != nil {
		t.Fatalf("shipped defaults are invalid: %v", err)
	}
}

func TestSettingsNeedTheirOwnPermission(t *testing.T) {
	f := newSettingsFixture(t)
	other := principalWith(t, f.pool, authorization.MailManage, authorization.ExternalInvoiceRequestsApprove)
	for name, call := range map[string]func() error{
		"get":     func() error { _, err := f.s.GetSettings(t.Context(), other); return err },
		"update":  func() error { _, err := f.s.UpdateSettings(t.Context(), other, f.input(t), nil); return err },
		"preview": func() error { _, err := f.s.PreviewMail(t.Context(), other, defaultSettings().Templates); return err },
		"pdf":     func() error { _, err := f.s.PreviewPDF(t.Context(), other, defaultSettings().Templates); return err },
		"test":    func() error { _, err := f.s.SendTestMail(t.Context(), other); return err },
	} {
		if err := call(); !apperror.IsCode(err, "permission_denied") {
			t.Errorf("%s: expected permission_denied, got %v", name, err)
		}
	}
	if f.notifier.count() != 0 {
		t.Fatal("a denied test mail was sent")
	}
}

func TestSettingsUpdateValidatesAndAudits(t *testing.T) {
	f := newSettingsFixture(t)
	in := f.input(t)
	saved, err := f.s.UpdateSettings(t.Context(), f.admin, in, nil)
	if err != nil || !saved.Enabled || saved.Version != 2 || saved.RecipientEmail != "wiref@example.org" ||
		len(saved.CCEmails) != 1 || saved.ReplyToEmail != "lab@example.org" {
		t.Fatalf("update %v %+v", err, saved)
	}
	var audits int
	if err = f.pool.QueryRow(
		t.Context(), "SELECT count(*) FROM audit_events WHERE action='invoicing.wiref_settings_updated'",
	).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("audit events %d %v", audits, err)
	}
	// A stale version is a conflict.
	if _, err = f.s.UpdateSettings(t.Context(), f.admin, in, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("expected stale_write: %v", err)
	}
	in = f.input(t)
	cases := map[string]func(*SettingsInput){
		"unknown placeholder":   func(i *SettingsInput) { i.MailIntro = "Hello {{nobody}}" },
		"template syntax":       func(i *SettingsInput) { i.PDFClosing = "{{template \"x\"}}" },
		"empty subject":         func(i *SettingsInput) { i.MailSubject = "  " },
		"empty pdf title":       func(i *SettingsInput) { i.PDFTitle = "" },
		"overlong text":         func(i *SettingsInput) { i.PDFIntro = strings.Repeat("x", MaxText+1) },
		"invalid recipient":     func(i *SettingsInput) { i.RecipientEmail = "not an address" },
		"display name":          func(i *SettingsInput) { i.RecipientEmail = "WiRef <wiref@example.org>" },
		"enabled w/o recipient": func(i *SettingsInput) { i.RecipientEmail = "" },
		"too many cc": func(i *SettingsInput) {
			i.CCEmails = []string{"a@example.org", "b@example.org", "c@example.org", "d@example.org", "e@example.org", "f@example.org"}
		},
		"invalid cc":             func(i *SettingsInput) { i.CCEmails = []string{"nope"} },
		"header inject":          func(i *SettingsInput) { i.CCEmails = []string{"a@example.org\r\nBcc: x@example.org"} },
		"invalid reply-to":       func(i *SettingsInput) { i.ReplyToEmail = "nope" },
		"reply-to display name":  func(i *SettingsInput) { i.ReplyToEmail = "Lab <lab@example.org>" },
		"reply-to header inject": func(i *SettingsInput) { i.ReplyToEmail = "lab@example.org\r\nBcc: x@example.org" },
	}
	for name, mutate := range cases {
		bad := in
		mutate(&bad)
		_, err = f.s.UpdateSettings(t.Context(), f.admin, bad, nil)
		var appErr *apperror.Error
		if !errors.As(err, &appErr) || appErr.HTTPStatus != 422 {
			t.Errorf("%s: expected a 422, got %v", name, err)
		}
	}
	// Disabled settings may keep an empty recipient; duplicate and primary-equal CC addresses are dropped; an empty
	// Reply-To clears it.
	in.Enabled, in.RecipientEmail, in.ReplyToEmail = false, "", " "
	in.CCEmails = []string{"x@example.org", "X@example.org"}
	saved, err = f.s.UpdateSettings(t.Context(), f.admin, in, nil)
	if err != nil || len(saved.CCEmails) != 1 || saved.ReplyToEmail != "" {
		t.Fatalf("disabled update %v %+v", err, saved)
	}
}

func TestDeliverMailsRecipientAndCCWithPDFAttachment(t *testing.T) {
	f := newSettingsFixture(t)
	if _, err := f.s.UpdateSettings(t.Context(), f.admin, f.input(t), nil); err != nil {
		t.Fatal(err)
	}
	outcome := f.s.Deliver(t.Context(), SampleDocument(sampleTime()))
	if outcome.Status != DeliverySent || outcome.FailureCode != "" || f.notifier.count() != 1 {
		t.Fatalf("outcome %+v, mails %d", outcome, f.notifier.count())
	}
	mail := f.notifier.sent[0]
	if mail.To != "wiref@example.org" || len(mail.Cc) != 1 || mail.Cc[0] != "office@example.org" ||
		mail.ReplyTo != "lab@example.org" {
		t.Fatalf("recipients %+v", mail)
	}
	if mail.Subject != "Invoice request W-2026-000123 for Example University, Institute of Sample Studies" {
		t.Fatalf("subject %q", mail.Subject)
	}
	if len(mail.Attachments) != 1 || mail.Attachments[0].ContentType != "application/pdf" ||
		mail.Attachments[0].Name != "invoice-request-W-2026-000123.pdf" ||
		!bytes.HasPrefix(mail.Attachments[0].Data, []byte("%PDF-")) {
		t.Fatalf("attachment %+v", mail.Attachments)
	}
	if !strings.Contains(pdfText(t, mail.Attachments[0].Data), "EUR 81.50") {
		t.Fatal("PDF lacks the total")
	}
}

func TestDeliverReportsMissingConfigurationAndFailureCodes(t *testing.T) {
	f := newSettingsFixture(t)
	if got := f.s.Deliver(t.Context(), SampleDocument(sampleTime())); got.Status != DeliveryNotConfigured {
		t.Fatalf("unconfigured: %+v", got)
	}
	// Enabled with a recipient is configured; disabled with a recipient is not.
	in := f.input(t)
	in.Enabled = false
	saved, err := f.s.UpdateSettings(t.Context(), f.admin, in, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := f.s.Deliver(t.Context(), SampleDocument(sampleTime())); got.Status != DeliveryNotConfigured ||
		f.notifier.count() != 0 {
		t.Fatalf("disabled: %+v", got)
	}
	in.Enabled, in.ExpectedVersion = true, saved.Version
	if _, err = f.s.UpdateSettings(t.Context(), f.admin, in, nil); err != nil {
		t.Fatal(err)
	}
	for name, test := range map[string]struct {
		err  error
		code string
	}{
		"mail disabled": {mailservice.ErrDisabled, FailureMailDisabled},
		"smtp error":    {errors.New("550 rejected wiref@example.org"), FailureSendFailed},
	} {
		f.notifier.err = test.err
		got := f.s.Deliver(t.Context(), SampleDocument(sampleTime()))
		if got.Status != DeliveryFailed || got.FailureCode != test.code || strings.Contains(got.FailureCode, "@") {
			t.Errorf("%s: %+v", name, got)
		}
	}
}

func TestPreviewRendersUnsavedTemplatesAndTestMailMarksItself(t *testing.T) {
	f := newSettingsFixture(t)
	templates := defaultSettings().Templates
	templates.MailIntro = "Draft text for {{organisation}}."
	preview, err := f.s.PreviewMail(t.Context(), f.admin, templates)
	if err != nil || !strings.Contains(preview.HTML, "Draft text for Example University") ||
		!strings.Contains(preview.Subject, "W-2026-000123") || strings.Contains(preview.HTML, "<script") {
		t.Fatalf("preview %v %+v", err, preview)
	}
	templates.MailIntro = "{{nobody}}"
	if _, err = f.s.PreviewMail(t.Context(), f.admin, templates); err == nil {
		t.Fatal("unknown placeholder previewed")
	}
	data, err := f.s.PreviewPDF(t.Context(), f.admin, defaultSettings().Templates)
	if err != nil || !bytes.HasPrefix(data, []byte("%PDF-")) {
		t.Fatalf("pdf preview %v", err)
	}
	if _, err = f.s.SendTestMail(t.Context(), f.admin); !apperror.IsCode(err, "wiref_settings_invalid") {
		t.Fatalf("test mail without recipient: %v", err)
	}
	// A test mail works while real sending is still off.
	in := f.input(t)
	in.Enabled = false
	if _, err = f.s.UpdateSettings(t.Context(), f.admin, in, nil); err != nil {
		t.Fatal(err)
	}
	outcome, err := f.s.SendTestMail(t.Context(), f.admin)
	if err != nil || outcome.Status != DeliverySent || f.notifier.count() != 1 ||
		!strings.HasPrefix(f.notifier.sent[0].Subject, "[TEST] ") || f.notifier.sent[0].To != "wiref@example.org" {
		t.Fatalf("test mail %v %+v", err, outcome)
	}
}
