package configtransfer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/branding"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/invoicing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/people"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/testdb"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacycatalog"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/subjectrequests"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/trainings"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/visitor"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

const smtpPassword = "s3cret-smtp-password-for-export-test"

type env struct {
	t      *testing.T
	ctx    context.Context
	pool   *pgxpool.Pool
	svc    *Service
	s      Services
	master authorization.Principal
}

func newEnv(t *testing.T) *env {
	t.Helper()
	pool := testdb.Pool(t)
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fileService := files.NewService(pool, store)
	mailer, err := mail.NewService(pool, [][]byte{bytes.Repeat([]byte{7}, 32)})
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{MakerspaceTimeZone: "Europe/Vienna", ChallengeHMACKey: bytes.Repeat([]byte{3}, 32)}
	staffingService, err := staffing.NewService(pool, cfg)
	if err != nil {
		t.Fatal(err)
	}
	labRules := laborordnung.NewService(pool, notifyrules.NewSystemEvents(nil), fileService)
	privacyService := privacy.NewService(pool, must(privacycatalog.Catalog()))
	services := Services{
		Files:           fileService,
		ManagedDevices:  manageddevices.NewService(pool),
		Roles:           roles.NewService(pool),
		MachineLogbook:  machinelogbook.NewService(pool, notifyrules.NewSystemEvents(nil)),
		Printing:        printing.NewService(pool),
		Staffing:        staffingService,
		Visitor:         visitor.NewService(pool, cfg, fileService, labRules, nil),
		Branding:        branding.NewService(pool, fileService),
		LabRules:        labRules,
		Surveys:         surveys.NewService(pool, cfg, nil),
		Mail:            mailer,
		Invoicing:       invoicing.NewService(pool, nil, nil),
		Trainings:       trainings.NewService(pool),
		Privacy:         privacyService,
		SubjectRequests: subjectrequests.NewService(pool, privacyService, people.NewService(pool, fileService), fileService),
	}
	e := &env{t: t, ctx: t.Context(), pool: pool, svc: NewService(pool, services), s: services}
	account, person := e.account("master")
	e.master = authorization.Principal{AccountID: account, PersonID: person, Master: true}
	return e
}

func (e *env) exec(query string, args ...any) {
	e.t.Helper()
	if _, err := e.pool.Exec(e.ctx, query, args...); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) account(suffix string) (uuid.UUID, uuid.UUID) {
	e.t.Helper()
	account, person := ids.New(), ids.New()
	e.exec(`INSERT INTO people (id, first_name, last_name, email) VALUES ($1, 'Transfer', 'Tester', $2)`,
		person, suffix+"-"+person.String()[24:]+"@example.test")
	e.exec(`INSERT INTO accounts (id, person_id, status) VALUES ($1, $2, 'enabled')`, account, person)
	return account, person
}

// staff is a principal holding exactly the given permissions through a role assigned to a new person.
func (e *env) staff(permissions ...authorization.Permission) authorization.Principal {
	e.t.Helper()
	account, person := e.account("staff")
	roleID := ids.New()
	e.exec(`INSERT INTO roles (id, name) VALUES ($1, $2)`, roleID, "Staff "+roleID.String()[24:])
	for _, permission := range permissions {
		e.exec(`INSERT INTO role_permission_grants (id, role_id, permission_id) VALUES (uuidv7(), $1, $2)`,
			roleID, permission)
	}
	e.exec(`INSERT INTO person_roles (person_id, role_id) VALUES ($1, $2)`, person, roleID)
	principal, err := authorization.LoadPermissionsFrom(e.ctx, e.pool, authorization.Principal{
		AccountID: account, PersonID: person, Assurance: authorization.AssuranceNormal,
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return principal
}

// must unwraps a service result in test setup; a failure panics, which fails the test with its stack.
func must[T any](value T, err error) T {
	if err != nil {
		panic(fmt.Sprintf("unexpected error: %v", err))
	}
	return value
}

func testPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	img.Set(1, 1, color.RGBA{R: 200, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// testPDF builds a one-page PDF with a correct cross-reference table.
func testPDF() []byte {
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
	}
	var buffer bytes.Buffer
	buffer.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects))
	for i, object := range objects {
		offsets[i] = buffer.Len()
		fmt.Fprintf(&buffer, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	xref := buffer.Len()
	fmt.Fprintf(&buffer, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for _, offset := range offsets {
		fmt.Fprintf(&buffer, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&buffer, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xref)
	return buffer.Bytes()
}

// seed fills an instance with one of everything a configuration file carries.
func (e *env) seed() {
	t, ctx, p := e.t, e.ctx, e.master
	kiosk := must(e.s.ManagedDevices.CreateType(ctx, p, "Kiosk", ptr("Front desk tablet"), nil))
	must(e.s.ManagedDevices.CreateSessionPolicy(ctx, p, manageddevices.SessionPolicyInput{
		Name: "Kiosk", IdleTimeoutSeconds: 600, AbsoluteLifetimeSeconds: 3600,
		PostSessionDestination: manageddevices.DestinationVisitorKiosk, IsDefault: true,
	}, nil))
	// The membership role Supervisor exists everywhere; only its description, behaviours and grants transfer.
	supervisor := roleByName(e.t, e, "Supervisor")
	supervisor = must(e.s.Roles.UpdateWithBehaviors(ctx, p, supervisor.ID, supervisor.Version, nil, true,
		ptr("Runs open days"), ptr(true), ptr(laborordnung.ModeWarning), nil))
	supervisor = must(e.s.Roles.ReplacePermissions(ctx, p, supervisor.ID, supervisor.Version,
		[]authorization.PermissionGrant{
			{PermissionID: authorization.OpenDaysRead, Scope: authorization.GrantEverywhere},
			{
				PermissionID: authorization.OpenDaysManage, Scope: authorization.GrantEverywhere,
				MinimumAssurance: authorization.AssuranceNormal, ReauthWithinMinutes: ptr(15),
			},
		}, nil))
	board := must(e.s.Roles.Create(ctx, p, "Board", nil, []authorization.PermissionGrant{{
		PermissionID: authorization.AttendanceAssist, Scope: authorization.GrantSelectedDeviceTypes,
		DeviceTypeIDs: []uuid.UUID{kiosk.ID}, MinimumAssurance: authorization.AssuranceNormal,
	}}, nil))
	logbook := e.s.MachineLogbook
	fdm := must(logbook.CreateProcess(ctx, p, "FDM printers", machinelogbook.IntegrationFDMPrinter, nil, nil))
	embroidery := must(logbook.CreateProcess(ctx, p, "Embroidery", machinelogbook.IntegrationNone,
		[]machinelogbook.ProcessMeasure{{Key: "stitches", Label: "Stitches", Unit: "stitch", BlockSize: 1000}}, nil))
	pla := must(logbook.CreateMaterialType(ctx, p, "PLA", machinelogbook.KindFilament, "g",
		[]uuid.UUID{fdm.ID}, nil))
	must(logbook.CreateMaterialType(ctx, p, "Thread", machinelogbook.KindConsumable, "m",
		[]uuid.UUID{embroidery.ID}, nil))
	printer := must(logbook.CreateMachine(ctx, p, fdm.ID, "Prusa 1", machinelogbook.MachineStatusActive, nil,
		false, nil))
	model := printing.ModelPrusaCoreOne
	must(e.s.Printing.SaveSetup(ctx, p, printer.ID, printing.SetupInput{
		Enabled: true, Model: &model, InputUnits: []printing.SetupUnitInput{{
			Name: "MMU", Slots: []printing.SetupSlotInput{
				{Name: "1", Status: printing.SlotAvailable}, {Name: "2", Status: printing.SlotUnavailable},
			},
		}},
	}, nil))
	matte := must(logbook.CreateMaterialTypeVariant(ctx, p, pla.ID, "Matte", nil))
	must(logbook.CreateMaterialTypeVariant(ctx, p, pla.ID, "Silk", nil))
	must(logbook.CreateMaterial(ctx, p, machinelogbook.MaterialInput{
		Name: "PLA Red", MaterialTypeID: pla.ID, ColorName: ptr("Red"), ColorHex: ptr("#FF0000"),
		LowStockThreshold: ptr("100"), FilamentDiameterMM: ptr("1.75"),
	}, nil))
	must(logbook.CreateMaterial(ctx, p, machinelogbook.MaterialInput{
		Name: "PLA Silk Gold", MaterialTypeID: pla.ID, ColorName: ptr("Gold"), Variant: ptr("Silk"),
		LowStockThreshold: ptr("100"), FilamentDiameterMM: ptr("1.75"),
	}, nil))
	group := must(logbook.CreatePricingGroup(ctx, p, "Members", ptr("Everyone with a role"), true, nil))
	runtime := machinelogbook.PricingRuleMachineRuntime
	must(logbook.CreatePricingRule(ctx, p, group.ID, runtime, &fdm.ID, nil, nil, "2.5", nil))
	must(logbook.CreatePricingRule(ctx, p, group.ID, machinelogbook.PricingRuleMaterial, nil, &pla.ID, nil,
		"0.04", nil))
	tx := must(e.pool.Begin(ctx))
	must(logbook.CreatePricingRuleTx(ctx, tx, p, group.ID, machinelogbook.PricingRuleMaterial, nil, &pla.ID,
		&matte.ID, nil, "0.06", nil))
	if err := tx.Commit(ctx); err != nil {
		e.t.Fatal(err)
	}
	must(logbook.CreatePricingRule(ctx, p, group.ID, machinelogbook.PricingRuleMachineMeasure, &embroidery.ID,
		nil, ptr("stitches"), "0.1", nil))
	must(logbook.SetRolePricingGroups(ctx, p, []machinelogbook.RolePricingGroupInput{
		{RoleID: supervisor.ID, PricingGroupID: group.ID, Priority: 10},
	}, nil))
	must(e.s.Staffing.UpdateRules(ctx, p, staffing.UpdateInput{
		ExpectedVersion: 1, SupervisorMinimum: 3, TraineeMinimum: 2, TraineeReadyAfter: 4, WarningWindowDays: 10,
		CountBy: staffing.CountByOpenDay, DefaultDeadline: staffing.DeadlineTwoWeeksBeforeEnd,
		Exceptions: []staffing.ExceptionInput{{RoleID: board.ID, Minimum: 1}},
	}, nil))
	must(e.s.Visitor.UpdateConfiguration(ctx, p, visitor.ConfigurationInput{
		Enabled: true, DeviceTypeIDs: []uuid.UUID{kiosk.ID},
		AllowedMethods: []visitor.AuthMethod{visitor.MethodPIN}, ExpectedVersion: 1,
	}, nil))
	current := must(e.s.Branding.Get(ctx, p))
	updated := must(e.s.Branding.Update(ctx, p, branding.ConfigurationInput{
		Identity: branding.Identity{
			LegalOrganizationName: "Transfer Lab e.V.", DisplayName: "Transfer Lab", ApplicationName: "Transfer Core",
			Tagline: ptr("Make things"),
		},
		Colors:          branding.Colors{Primary: "#112233", Secondary: "#445566", Accent: "#778899", Background: "#ffffff"},
		Imprint:         branding.Legal{Mode: branding.LegalInternal, Markdown: "# Imprint"},
		Privacy:         branding.Legal{Mode: branding.LegalExternal, ExternalURL: "https://example.test/privacy"},
		ExpectedVersion: current.Version,
	}, nil))
	must(e.s.Branding.PutAsset(ctx, p, branding.Logo, updated.Version, "logo.png", bytes.NewReader(testPNG(t)), nil))
	version := must(e.s.LabRules.CreateVersion(ctx, p, "2026-1", "lab-rules.pdf", bytes.NewReader(testPDF()), nil))
	must(e.s.LabRules.Publish(ctx, p, version.ID, time.Now().Add(-time.Hour).UTC().Truncate(time.Second), nil))
	survey := must(e.s.Surveys.Create(ctx, p, surveys.Input{
		Name: "Feedback", Title: "How was your visit?", Anonymous: true,
		Questions: []surveys.QuestionInput{
			{Kind: surveys.QuestionRating, Prompt: "Rate us", Required: true, RatingMin: ptr[int32](1), RatingMax: ptr[int32](5)},
			{Kind: surveys.QuestionSingleChoice, Prompt: "Again?", Options: []surveys.OptionInput{{Label: "Yes"}, {Label: "No"}}},
		},
	}, nil))
	must(e.s.Surveys.UpdateTrigger(ctx, p, survey.ID, false, 600, 10, nil, 0, nil))
	must(e.s.Mail.UpdateConfiguration(ctx, p, mail.ConfigurationInput{
		Enabled: true, Host: "smtp.example.test", Port: 587, TLSMode: mail.TLSStartTLS, Username: "mailer",
		Password: smtpPassword, FromAddress: "lab@example.test", FromName: "Transfer Lab",
		BaseURL: "https://lab.example.test", ExpectedVersion: 1,
	}, nil))
	wiref := must(e.s.Invoicing.GetSettings(ctx, p))
	must(e.s.Invoicing.UpdateSettings(ctx, p, invoicing.SettingsInput{
		Templates: invoicing.Templates{
			MailSubject: "Invoice request", MailIntro: "Hello", MailClosing: "Thanks",
			PDFTitle: "Invoice request", PDFIntro: "Intro", PDFClosing: "Bye",
			ShowContactPerson: true, ShowPurchaseOrder: true,
		},
		Enabled: true, RecipientEmail: "wiref@example.test", CCEmails: []string{"cc@example.test"},
		ReplyToEmail: "lab@example.test", ExpectedVersion: wiref.Version,
	}, nil))
	printingCompetency := must(e.s.Trainings.CreateCompetencyCategory(ctx, p, trainings.CompetencyCategoryInput{
		Name: "3D printing", Description: ptr("FDM and resin"), Active: true, SortOrder: 10,
	}, nil))
	electronics := must(e.s.Trainings.CreateCompetencyCategory(ctx, p, trainings.CompetencyCategoryInput{
		Name: "Electronics", Active: false, SortOrder: 20,
	}, nil))
	must(e.s.Trainings.CreateTraining(ctx, p, trainings.TrainingInput{
		Name: "Prusa – operation", Description: ptr("Loading filament"), Active: true, SortOrder: 1,
		CompetencyIDs: []uuid.UUID{printingCompetency.ID, electronics.ID}, ProcessIDs: []uuid.UUID{fdm.ID},
	}, nil))
	must(e.s.Trainings.CreateTraining(ctx, p, trainings.TrainingInput{Name: "Soldering", Active: false}, nil))
	privacySettings := must(e.s.Privacy.GetSettings(ctx, p))
	must(e.s.Privacy.UpdateSettings(ctx, p, privacy.SettingsInput{
		ControllerName: "HTU Graz", ControllerAddress: "Rechbauerstraße 12, 8010 Graz", DataProtectionContact: "privacy@example.test",
		AutomaticRunsEnabled: false, RunIntervalMinutes: 60, ExpectedVersion: privacySettings.Version,
	}, nil))
	for _, policy := range must(e.s.Privacy.ListPolicies(ctx, p)) {
		if policy.Category == privacycatalog.AuditEvents {
			must(e.s.Privacy.UpdatePolicy(ctx, p, policy.ID, privacy.PolicyInput{
				Category: policy.Category, Trigger: policy.Trigger, PeriodDays: 400, Action: policy.Action,
				Purpose: "Security review", LegalBasis: "Art. 6(1)(f) GDPR", Reason: "One year plus the audit season.",
			}, nil))
		}
	}
	must(e.s.SubjectRequests.CreateActivity(ctx, p, subjectrequests.ActivityInput{
		Name: "Member administration", Purpose: "Run the lab", LegalBasis: "Art. 6(1)(b) GDPR",
		CategoryIDs: []privacy.CategoryID{privacycatalog.PeopleIdentity, privacycatalog.AttendanceVisits},
		Recipients:  "None", RetentionNote: "See the retention policies.",
	}, nil))
}

func (e *env) export(p authorization.Principal, keys ...SectionKey) []byte {
	e.t.Helper()
	if len(keys) == 0 {
		keys = Sections()
	}
	return must(e.svc.Export(e.ctx, p, keys, nil)).Data
}

func sectionsOf(t *testing.T, data []byte) map[SectionKey]json.RawMessage {
	t.Helper()
	var parsed file
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed.Sections
}

// importFile previews and applies a file and returns the applied report.
func (e *env) importFile(p authorization.Principal, mode Mode, data []byte, keys ...SectionKey) Report {
	e.t.Helper()
	if len(keys) == 0 {
		keys = Sections()
	}
	preview := must(e.svc.Preview(e.ctx, p, mode, keys, bytes.NewReader(data)))
	if preview.Conflicts() > 0 {
		e.t.Fatalf("preview has conflicts: %+v", preview.Sections)
	}
	return must(e.svc.Apply(e.ctx, p, mode, keys, preview.Fingerprint, bytes.NewReader(data), nil))
}

func item(t *testing.T, report Report, key SectionKey, name string) Item {
	t.Helper()
	for _, section := range report.Sections {
		if section.Key != key {
			continue
		}
		for _, entry := range section.Items {
			if entry.Name == name {
				return entry
			}
		}
	}
	t.Fatalf("report has no %s item %q: %+v", key, name, report.Sections)
	return Item{}
}

func canonical(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestExportNeverContainsSecrets(t *testing.T) {
	e := newEnv(t)
	e.seed()
	data := e.export(e.master)
	for _, forbidden := range []string{smtpPassword, "encrypted", `"password"`} {
		if strings.Contains(strings.ToLower(string(data)), strings.ToLower(forbidden)) {
			t.Fatalf("export contains %q", forbidden)
		}
	}
	sections := sectionsOf(t, data)
	var mailSettings map[string]any
	if err := json.Unmarshal(sections[SectionMail], &mailSettings); err != nil {
		t.Fatal(err)
	}
	if mailSettings["username"] != "mailer" || mailSettings["host"] != "smtp.example.test" {
		t.Fatalf("mail settings = %v", mailSettings)
	}
	if strings.Contains(string(sections[SectionRoles]), `"master"`) {
		t.Fatal("the master role must not be exported")
	}
	var parsed file
	if err := json.Unmarshal(data, &parsed); err != nil || parsed.Format != FormatName || parsed.Version != 1 {
		t.Fatalf("envelope = %+v, %v", parsed, err)
	}
	if again := e.export(e.master); !bytes.Equal(stripExportedAt(again), stripExportedAt(data)) {
		t.Fatal("two exports of the same state differ")
	}
}

func stripExportedAt(data []byte) []byte {
	var parsed map[string]any
	_ = json.Unmarshal(data, &parsed)
	delete(parsed, "exportedAt")
	encoded, _ := json.Marshal(parsed)
	return encoded
}

func TestRoundTripIntoAFreshInstanceReproducesEverySection(t *testing.T) {
	source := newEnv(t)
	source.seed()
	data := source.export(source.master)
	want := sectionsOf(t, data)
	if !strings.Contains(string(want[SectionRoles]), `"reauthWithinMinutes"`) {
		t.Fatalf("the fresh sign-in window of a grant is not exported: %s", want[SectionRoles])
	}

	t.Run("overwrite", func(t *testing.T) {
		target := newEnv(t)
		report := target.importFile(target.master, ModeOverwrite, data)
		if !report.Applied {
			t.Fatal("report is not applied")
		}
		// Membership roles exist on every instance, so the import updates them instead of creating them.
		if got := item(t, report, SectionRoles, "Supervisor"); got.Action != ActionUpdate {
			t.Fatalf("Supervisor = %+v", got)
		}
		if got := item(t, report, SectionRoles, "Board"); got.Action != ActionCreate {
			t.Fatalf("Board = %+v", got)
		}
		got := sectionsOf(t, target.export(target.master))
		for _, key := range Sections() {
			if key == SectionMail {
				continue
			}
			if canonical(t, got[key]) != canonical(t, want[key]) {
				t.Errorf("section %s differs after import:\n got %s\nwant %s", key, got[key], want[key])
			}
		}
		// The password never travels, so mail delivery stays disabled until it is entered on the target.
		var mailSettings mailEntry
		if err := json.Unmarshal(got[SectionMail], &mailSettings); err != nil {
			t.Fatal(err)
		}
		if mailSettings.Enabled || mailSettings.Host != "smtp.example.test" {
			t.Fatalf("mail = %+v", mailSettings)
		}
		if notes := item(t, report, SectionMail, mailItem).Reason; !strings.Contains(notes, "SMTP password") {
			t.Fatalf("mail reason = %q", notes)
		}
		// A second preview of the same file changes nothing.
		again := must(target.svc.Preview(target.ctx, target.master, ModeOverwrite, Sections(), bytes.NewReader(data)))
		for _, section := range again.Sections {
			c := section.Counts
			if c.Create+c.Update+c.Delete+c.Deactivate+c.Conflict != 0 {
				t.Errorf("section %s is not idempotent: %+v %+v", section.Key, c, section.Items)
			}
		}
		var audits int
		if err := target.pool.QueryRow(target.ctx,
			`SELECT count(*) FROM audit_events WHERE action = 'configuration.section_overwritten'`).Scan(&audits); err != nil {
			t.Fatal(err)
		}
		if audits != len(Sections()) {
			t.Fatalf("section audit events = %d", audits)
		}
	})

	t.Run("insert", func(t *testing.T) {
		target := newEnv(t)
		report := target.importFile(target.master, ModeInsert, data)
		if got := item(t, report, SectionBranding, brandingItem); got.Action != ActionSkip {
			t.Fatalf("insert must leave settings untouched: %+v", got)
		}
		// The membership roles already exist, so insert leaves them as the target has them.
		if got := item(t, report, SectionRoles, "Supervisor"); got.Action != ActionSkip {
			t.Fatalf("insert must leave the membership role untouched: %+v", got)
		}
		if got := roleByName(t, target, "Supervisor"); got.Description != nil && *got.Description == "Runs open days" {
			t.Fatalf("insert changed the membership role: %+v", got.Description)
		}
		got := sectionsOf(t, target.export(target.master))
		for _, key := range []SectionKey{
			SectionDeviceTypes, SectionSessionPolicies, SectionProcesses, SectionMaterialTypes,
			SectionMachines, SectionInventoryArticles, SectionPricing, SectionLabRules, SectionSurveys,
		} {
			if canonical(t, got[key]) != canonical(t, want[key]) {
				t.Errorf("section %s differs after insert:\n got %s\nwant %s", key, got[key], want[key])
			}
		}
		if item(t, report, SectionRoles, "Board").Action != ActionCreate || roleByName(t, target, "Board").Name != "Board" {
			t.Fatal("insert did not create the custom role")
		}
	})
}

func TestInsertLeavesExistingEntriesAndOverwriteUpdatesThem(t *testing.T) {
	e := newEnv(t)
	e.seed()
	data := e.export(e.master, SectionRoles)
	role := roleByName(t, e, "Supervisor")
	must(e.s.Roles.Update(e.ctx, e.master, role.ID, role.Version, nil, true, ptr("Changed locally"), nil))

	report := e.importFile(e.master, ModeInsert, data, SectionRoles)
	if got := item(t, report, SectionRoles, "Supervisor"); got.Action != ActionSkip {
		t.Fatalf("insert = %+v", got)
	}
	if got := roleByName(t, e, "Supervisor"); got.Description == nil || *got.Description != "Changed locally" {
		t.Fatalf("insert changed the role: %+v", got.Description)
	}
	report = e.importFile(e.master, ModeOverwrite, data, SectionRoles)
	if got := item(t, report, SectionRoles, "Supervisor"); got.Action != ActionUpdate {
		t.Fatalf("overwrite = %+v", got)
	}
	if got := roleByName(t, e, "Supervisor"); got.Description == nil || *got.Description != "Runs open days" {
		t.Fatalf("overwrite did not restore the role: %+v", got.Description)
	}
}

func TestStaffingRulesTravelWithExceptionsByRoleName(t *testing.T) {
	source := newEnv(t)
	source.seed()
	data := source.export(source.master, SectionDeviceTypes, SectionRoles, SectionStaffingRules)
	target := newEnv(t)
	target.importFile(target.master, ModeOverwrite, data, SectionDeviceTypes, SectionRoles, SectionStaffingRules)
	rules := must(target.s.Staffing.Rules(target.ctx, target.master))
	if rules.SupervisorMinimum != 3 || rules.TraineeReadyAfter != 4 || rules.WarningWindowDays != 10 ||
		rules.CountBy != staffing.CountByOpenDay || len(rules.Exceptions) != 1 || rules.Exceptions[0].RoleName != "Board" ||
		rules.Exceptions[0].Minimum != 1 {
		t.Fatalf("imported rules = %+v", rules)
	}
	if got := roleByName(t, target, "Supervisor"); got.Description == nil || *got.Description != "Runs open days" ||
		got.SystemKey == nil || len(got.PermissionGrants) != 2 {
		t.Fatalf("membership role after import = %+v", got)
	}
}

func TestOlderRoleFilesWithStaffingFieldsStillImport(t *testing.T) {
	source := newEnv(t)
	source.seed()
	data := source.export(source.master, SectionDeviceTypes, SectionRoles)
	older := regexp.MustCompile(`"labRulesMode"`).ReplaceAll(data,
		[]byte(`"staffingLevel": "supervisor", "minOpenDaysPerSemester": 1, "labRulesMode"`))
	target := newEnv(t)
	target.importFile(target.master, ModeOverwrite, older, SectionDeviceTypes, SectionRoles)
	if got := roleByName(t, target, "Board"); got.ID == uuid.Nil {
		t.Fatal("the role of an older file was not imported")
	}
}

func roleByName(t *testing.T, e *env, name string) roles.Role {
	t.Helper()
	page := must(e.s.Roles.List(e.ctx, e.master, 100, ""))
	for _, role := range page.Items {
		if role.Name == name {
			return role
		}
	}
	t.Fatalf("role %q not found", name)
	return roles.Role{}
}

func TestOverwriteDeletesUnusedEntriesAndKeepsOrDeactivatesUsedOnes(t *testing.T) {
	e := newEnv(t)
	e.seed()
	data := e.export(e.master)
	ctx, p, logbook := e.ctx, e.master, e.s.MachineLogbook

	unused := must(e.s.Roles.Create(ctx, p, "Temporary", nil, nil, nil))
	used := must(e.s.Roles.Create(ctx, p, "Assigned", nil, nil, nil))
	_, person := e.account("holder")
	e.exec(`INSERT INTO person_roles (person_id, role_id) VALUES ($1, $2)`, person, used.ID)
	oldType := must(logbook.CreateProcess(ctx, p, "Old lasers", machinelogbook.IntegrationNone, nil, nil))
	legacy := must(logbook.CreateMaterialType(ctx, p, "Legacy resin", machinelogbook.KindConsumable, "ml",
		[]uuid.UUID{oldType.ID}, nil))
	article := must(logbook.CreateMaterial(ctx, p, machinelogbook.MaterialInput{
		Name: "Legacy resin bottle", MaterialTypeID: legacy.ID,
	}, nil))
	must(logbook.CreateMachine(ctx, p, oldType.ID, "Spare laser", machinelogbook.MachineStatusActive, nil, false, nil))

	// Roles, processes, machines and material types only: the legacy article stays and keeps its type in use.
	report := e.importFile(p, ModeOverwrite, data,
		SectionRoles, SectionProcesses, SectionMachines, SectionMaterialTypes)
	expectations := []struct {
		key    SectionKey
		name   string
		action Action
	}{
		{SectionRoles, "Temporary", ActionDelete},
		{SectionRoles, "Assigned", ActionKeep},
		{SectionProcesses, "Old lasers", ActionDeactivate},
		{SectionMachines, "Spare laser", ActionDelete},
		{SectionMaterialTypes, "Legacy resin", ActionDeactivate},
	}
	for _, expectation := range expectations {
		if got := item(t, report, expectation.key, expectation.name); got.Action != expectation.action {
			t.Errorf("%s %q = %+v, want %s", expectation.key, expectation.name, got, expectation.action)
		}
	}
	if _, err := e.s.Roles.Get(ctx, p, unused.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("unused role still exists: %v", err)
	}
	if got := must(logbook.GetMaterialType(ctx, p, legacy.ID)); got.Active {
		t.Fatal("referenced material type is still active")
	}
	if got := must(logbook.GetMaterial(ctx, p, article.ID)); !got.Active {
		t.Fatal("the article of an unselected section changed")
	}
	// The master role is never touched.
	var masters int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM roles WHERE system_key = 'master'`).Scan(&masters); err != nil ||
		masters != 1 {
		t.Fatalf("master roles = %d, %v", masters, err)
	}

	// With the articles section the unused article is deleted first, so its type can be deleted too.
	report = e.importFile(p, ModeOverwrite, data, SectionMaterialTypes, SectionInventoryArticles)
	if got := item(t, report, SectionInventoryArticles, "Legacy resin bottle"); got.Action != ActionDelete {
		t.Fatalf("article = %+v", got)
	}
	if got := item(t, report, SectionMaterialTypes, "Legacy resin"); got.Action != ActionDelete {
		t.Fatalf("material type = %+v", got)
	}
}

func TestMissingReferencesAreConflictsAndBlockTheImport(t *testing.T) {
	source := newEnv(t)
	source.seed()
	data := source.export(source.master, SectionMachines, SectionRoles)
	t.Run("into an instance without the referenced entries", func(t *testing.T) {
		missingReferences(t, data)
	})
}

func missingReferences(t *testing.T, data []byte) {
	target := newEnv(t)
	report := must(target.svc.Preview(target.ctx, target.master, ModeInsert,
		[]SectionKey{SectionMachines, SectionRoles}, bytes.NewReader(data)))
	if got := item(t, report, SectionMachines, "Prusa 1"); got.Action != ActionConflict ||
		got.Code != "process_missing" {
		t.Fatalf("machine = %+v", got)
	}
	if got := item(t, report, SectionRoles, "Board"); got.Action != ActionConflict ||
		got.Code != "device_type_missing" {
		t.Fatalf("role = %+v", got)
	}
	_, err := target.svc.Apply(target.ctx, target.master, ModeInsert, []SectionKey{SectionMachines, SectionRoles},
		report.Fingerprint, bytes.NewReader(data), nil)
	if !apperror.IsCode(err, "configuration_import_conflicts") {
		t.Fatalf("apply = %v", err)
	}
	if got := item(t, report, SectionRoles, "Supervisor"); got.Action != ActionSkip {
		t.Fatalf("membership role = %+v", got)
	}
	var count int
	if err := target.pool.QueryRow(target.ctx, `SELECT count(*) FROM roles WHERE name = 'Board'`).Scan(&count); err != nil ||
		count != 0 {
		t.Fatalf("a rejected import created roles: %d %v", count, err)
	}
}

func TestApplyRefusesWhenTheConfigurationChangedSincePreview(t *testing.T) {
	e := newEnv(t)
	e.seed()
	data := e.export(e.master, SectionDeviceTypes)
	preview := must(e.svc.Preview(e.ctx, e.master, ModeOverwrite, []SectionKey{SectionDeviceTypes}, bytes.NewReader(data)))
	must(e.s.ManagedDevices.CreateType(e.ctx, e.master, "Laptop", nil, nil))
	_, err := e.svc.Apply(e.ctx, e.master, ModeOverwrite, []SectionKey{SectionDeviceTypes}, preview.Fingerprint,
		bytes.NewReader(data), nil)
	if !apperror.IsCode(err, "configuration_changed") {
		t.Fatalf("apply = %v", err)
	}
	types := must(e.s.ManagedDevices.ListTypes(e.ctx, e.master))
	if len(types) != 2 {
		t.Fatalf("a refused import changed device types: %+v", types)
	}
}

func TestImportAuthorization(t *testing.T) {
	source := newEnv(t)
	source.seed()
	data := source.export(source.master, SectionRoles, SectionPricing)
	t.Run("on another instance", func(t *testing.T) { importAuthorization(t, data) })
}

func importAuthorization(t *testing.T, data []byte) {
	e := newEnv(t)
	must(e.s.ManagedDevices.CreateType(e.ctx, e.master, "Kiosk", nil, nil))
	keys := []SectionKey{SectionRoles}
	preview := func(p authorization.Principal) (Report, error) {
		return e.svc.Preview(e.ctx, p, ModeInsert, keys, bytes.NewReader(data))
	}

	if _, err := preview(e.staff(authorization.RolesRead, authorization.RolesManage)); !apperror.IsCode(
		err, "permission_denied") {
		t.Fatalf("without configuration.import: %v", err)
	}
	if _, err := preview(e.staff(authorization.ConfigurationImport, authorization.RolesRead)); !apperror.IsCode(
		err, "permission_denied") {
		t.Fatalf("without roles.manage: %v", err)
	}
	// A role editor may only grant what it holds: the imported Board role carries a permission it lacks.
	editor := e.staff(authorization.ConfigurationImport, authorization.RolesRead, authorization.RolesManage)
	report := must(preview(editor))
	if got := item(t, report, SectionRoles, "Board"); got.Action != ActionConflict || got.Code != "permission_denied" {
		t.Fatalf("privilege subset = %+v", got)
	}
	if _, err := e.svc.Apply(e.ctx, editor, ModeInsert, keys, report.Fingerprint, bytes.NewReader(data), nil); !apperror.IsCode(
		err, "configuration_import_conflicts") {
		t.Fatalf("apply with privilege violation = %v", err)
	}
	// An editor holding everything the role grants may import it.
	full := e.staff(authorization.ConfigurationImport, authorization.RolesRead, authorization.RolesManage,
		authorization.OpenDaysRead, authorization.OpenDaysManage, authorization.AttendanceAssist)
	report = must(preview(full))
	if got := item(t, report, SectionRoles, "Board"); got.Action != ActionCreate {
		t.Fatalf("full editor = %+v", got)
	}

	if _, err := e.svc.Export(e.ctx, e.staff(authorization.RolesRead), keys, nil); !apperror.IsCode(
		err, "permission_denied") {
		t.Fatalf("export without configuration.export: %v", err)
	}
	if _, err := e.svc.Export(e.ctx, e.staff(authorization.ConfigurationExport), keys, nil); !apperror.IsCode(
		err, "permission_denied") {
		t.Fatalf("export without roles.read: %v", err)
	}
	must(e.svc.Export(e.ctx, e.staff(authorization.ConfigurationExport, authorization.RolesRead), keys, nil))
}

func TestFilesAreValidatedStrictly(t *testing.T) {
	e := newEnv(t)
	cases := map[string]struct {
		body string
		code string
	}{
		"not json":        {`nope`, "configuration_file_invalid"},
		"wrong format":    {`{"format":"other","version":1,"sections":{}}`, "configuration_file_invalid"},
		"newer version":   {`{"format":"makerspace-core-config","version":2,"sections":{}}`, "configuration_version_unsupported"},
		"missing section": {`{"format":"makerspace-core-config","version":1,"sections":{}}`, "configuration_file_invalid"},
		"unknown field": {
			`{"format":"makerspace-core-config","version":1,"sections":{"roles":[{"name":"A","extra":1}]}}`,
			"configuration_file_invalid",
		},
		"master role": {
			`{"format":"makerspace-core-config","version":1,"sections":{"roles":[{"name":"Master","permissions":[]}]}}`,
			"configuration_file_invalid",
		},
		"duplicate names": {
			`{"format":"makerspace-core-config","version":1,"sections":{"roles":[{"name":"A"},{"name":"a"}]}}`,
			"configuration_file_invalid",
		},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := e.svc.Preview(e.ctx, e.master, ModeOverwrite, []SectionKey{SectionRoles}, strings.NewReader(test.body))
			if !apperror.IsCode(err, test.code) {
				t.Fatalf("error = %v, want %s", err, test.code)
			}
		})
	}
	unknown := `{"format":"makerspace-core-config","version":1,"sections":{"roles":[],"future":{}}}`
	report := must(e.svc.Preview(e.ctx, e.master, ModeOverwrite, []SectionKey{SectionRoles}, strings.NewReader(unknown)))
	if len(report.Warnings) != 1 {
		t.Fatalf("warnings = %v", report.Warnings)
	}
	large := strings.NewReader(strings.Repeat(" ", MaxFileBytes+1))
	var appErr *apperror.Error
	if _, err := e.svc.Preview(e.ctx, e.master, ModeOverwrite, []SectionKey{SectionRoles}, large); !apperror.IsCode(
		err, "configuration_file_too_large") {
		t.Fatalf("large file: %v", err)
	} else if ok := asAppError(err, &appErr); !ok || appErr.HTTPStatus != http.StatusRequestEntityTooLarge {
		t.Fatalf("large file status: %v", err)
	}
}

func asAppError(err error, target **apperror.Error) bool {
	value, ok := err.(*apperror.Error) //nolint:errorlint // the service returns the error unwrapped
	*target = value
	return ok
}

func TestInvoicingSectionAuthorizationAndValidation(t *testing.T) {
	e := newEnv(t)
	e.seed()
	data := e.export(e.master, SectionInvoicing)
	keys := []SectionKey{SectionInvoicing}
	if _, err := e.svc.Export(e.ctx, e.staff(authorization.ConfigurationExport), keys, nil); !apperror.IsCode(
		err, "permission_denied") {
		t.Fatalf("export without invoicing.settings.manage: %v", err)
	}
	must(e.svc.Export(e.ctx, e.staff(authorization.ConfigurationExport, authorization.InvoicingSettingsManage), keys, nil))
	preview := func(p authorization.Principal, body []byte) (Report, error) {
		return e.svc.Preview(e.ctx, p, ModeOverwrite, keys, bytes.NewReader(body))
	}
	if _, err := preview(e.staff(authorization.ConfigurationImport), data); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("import without invoicing.settings.manage: %v", err)
	}
	if _, err := preview(e.staff(authorization.InvoicingSettingsManage), data); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("import without configuration.import: %v", err)
	}
	importer := e.staff(authorization.ConfigurationImport, authorization.InvoicingSettingsManage)
	if got := item(t, must(preview(importer, data)), SectionInvoicing, invoicingItem); got.Action != ActionSkip {
		t.Fatalf("unchanged settings = %+v", got)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	invoicingSettings := parsed["sections"].(map[string]any)["invoicing"].(map[string]any)
	invoicingSettings["mailSubject"] = "Hello {{unknown}}"
	broken, _ := json.Marshal(parsed)
	if _, err := preview(importer, broken); !apperror.IsCode(err, "configuration_file_invalid") {
		t.Fatalf("unknown placeholder: %v", err)
	}

	if invoicingSettings["replyToEmail"] != "lab@example.test" {
		t.Fatalf("exported replyToEmail = %v", invoicingSettings["replyToEmail"])
	}
	// Files exported by 0.8.3 and 0.8.4 carry the German placeholder names; they import under the English ones.
	invoicingSettings["mailSubject"] = "Changed {{anforderungsnummer}}"
	invoicingSettings["replyToEmail"] = "office@example.test"
	changed, _ := json.Marshal(parsed)
	report := must(e.svc.Apply(e.ctx, importer, ModeOverwrite, keys, must(preview(importer, changed)).Fingerprint,
		bytes.NewReader(changed), nil))
	if got := item(t, report, SectionInvoicing, invoicingItem); got.Action != ActionUpdate {
		t.Fatalf("changed settings = %+v", got)
	}
	var subject, replyTo string
	if err := e.pool.QueryRow(e.ctx, `SELECT mail_subject, reply_to_email FROM wiref_delivery_settings`).Scan(
		&subject, &replyTo,
	); err != nil || subject != "Changed {{request_number}}" || replyTo != "office@example.test" {
		t.Fatalf("subject = %q, reply-to = %q, %v", subject, replyTo, err)
	}
	var audits int
	if err := e.pool.QueryRow(e.ctx,
		`SELECT count(*) FROM audit_events WHERE action = 'invoicing.wiref_settings_updated'`).Scan(&audits); err != nil || audits < 1 {
		t.Fatalf("audit events = %d, %v", audits, err)
	}
}

func TestTrainingsTravelWithoutRecordsAndOverwriteKeepsUsedOnes(t *testing.T) {
	source := newEnv(t)
	source.seed()
	keys := []SectionKey{SectionProcesses, SectionCompetencies, SectionTrainings}
	data := source.export(source.master, keys...)
	sections := sectionsOf(t, data)
	var exported []trainingEntry
	if err := json.Unmarshal(sections[SectionTrainings], &exported); err != nil {
		t.Fatal(err)
	}
	if len(exported) != 2 || exported[0].Name != "Prusa – operation" ||
		fmt.Sprint(exported[0].Competencies) != "[3D printing Electronics]" ||
		fmt.Sprint(exported[0].Processes) != "[FDM printers]" {
		t.Fatalf("trainings = %+v", exported)
	}

	// A target that holds a record of a training missing from the file keeps it, deactivated; unused ones go.
	t.Run("overwrite", func(t *testing.T) {
		target := newEnv(t)
		used := must(target.s.Trainings.CreateTraining(target.ctx, target.master,
			trainings.TrainingInput{Name: "Laser", Active: true}, nil))
		unused := must(target.s.Trainings.CreateTraining(target.ctx, target.master,
			trainings.TrainingInput{Name: "Vinyl", Active: true}, nil))
		_, person := target.account("trained")
		target.exec(`INSERT INTO training_records (person_id, training_id, status) VALUES ($1, $2, 'trained')`,
			person, used.ID)
		report := target.importFile(target.master, ModeOverwrite, data, keys...)
		if got := item(t, report, SectionTrainings, "Laser"); got.Action != ActionDeactivate {
			t.Fatalf("Laser = %+v", got)
		}
		if got := item(t, report, SectionTrainings, "Vinyl"); got.Action != ActionDelete {
			t.Fatalf("Vinyl = %+v", got)
		}
		if got := item(t, report, SectionTrainings, "Prusa – operation"); got.Action != ActionCreate {
			t.Fatalf("Prusa = %+v", got)
		}
		var active bool
		if err := target.pool.QueryRow(target.ctx, `SELECT active FROM trainings WHERE id = $1`, used.ID).Scan(&active); err != nil ||
			active {
			t.Fatalf("Laser active = %v, %v", active, err)
		}
		var records, vinyl int
		if err := target.pool.QueryRow(target.ctx, `SELECT (SELECT count(*) FROM training_records),
		(SELECT count(*) FROM trainings WHERE id = $1)`, unused.ID).Scan(&records, &vinyl); err != nil ||
			records != 1 || vinyl != 0 {
			t.Fatalf("records = %d, vinyl = %d, %v", records, vinyl, err)
		}
		got := sectionsOf(t, target.export(target.master, SectionCompetencies))
		if canonical(t, got[SectionCompetencies]) != canonical(t, sections[SectionCompetencies]) {
			t.Fatalf("competencies differ:\n got %s\nwant %s", got[SectionCompetencies], sections[SectionCompetencies])
		}

	})

	// Without the competencies and processes a training is a conflict.
	t.Run("missing references", func(t *testing.T) {
		empty := newEnv(t)
		preview := must(empty.svc.Preview(empty.ctx, empty.master, ModeInsert, []SectionKey{SectionTrainings},
			bytes.NewReader(data)))
		if got := item(t, preview, SectionTrainings, "Prusa – operation"); got.Action != ActionConflict ||
			got.Code != "competency_missing" {
			t.Fatalf("Prusa = %+v", got)
		}
		if got := item(t, preview, SectionTrainings, "Soldering"); got.Action != ActionCreate {
			t.Fatalf("Soldering = %+v", got)
		}

	})

	// Both sections need trainings.manage.
	if _, err := source.svc.Export(source.ctx, source.staff(authorization.ConfigurationExport, authorization.MachinesRead),
		[]SectionKey{SectionTrainings}, nil); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("export without trainings.manage: %v", err)
	}
}

// withPrivacySection returns the file with its privacy section replaced.
func withPrivacySection(t *testing.T, data []byte, mutate func(*privacyEntry)) []byte {
	t.Helper()
	var parsed file
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	var entry privacyEntry
	if err := json.Unmarshal(parsed.Sections[SectionPrivacy], &entry); err != nil {
		t.Fatal(err)
	}
	mutate(&entry)
	raw, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	parsed.Sections[SectionPrivacy] = raw
	return must(json.Marshal(parsed))
}

func policyOf(t *testing.T, e *env, category privacy.CategoryID, status string) privacy.Policy {
	t.Helper()
	for _, policy := range must(e.s.Privacy.ListPolicies(e.ctx, e.master)) {
		if policy.Category == category && policy.Status == status {
			return policy
		}
	}
	t.Fatalf("no %s policy for %s", status, category)
	return privacy.Policy{}
}

func TestPrivacyDecisionsImportAsDraftsAndAreNeverRemoved(t *testing.T) {
	source := newEnv(t)
	source.seed()
	data := source.export(source.master, SectionPrivacy)
	keys := []SectionKey{SectionPrivacy}
	audit := string(privacycatalog.AuditEvents)

	// Export and import need the policy permission; the automatic-run switch never travels.
	if _, err := source.svc.Export(source.ctx, source.staff(authorization.ConfigurationExport, authorization.PrivacyRead), keys, nil); !apperror.IsCode(
		err, "permission_denied") {
		t.Fatalf("export without privacy.policies.manage: %v", err)
	}
	if strings.Contains(string(sectionsOf(t, data)[SectionPrivacy]), "automaticRuns") {
		t.Fatal("the automatic-runs switch must not be exported")
	}

	// Pools are shared within one test, so the target instance lives in a subtest.
	t.Run("into a fresh instance", func(t *testing.T) {
		// A fresh instance: the file's decision updates the seeded draft, nothing is approved or activated.
		target := newEnv(t)
		report := target.importFile(target.master, ModeOverwrite, data, keys...)
		if got := item(t, report, SectionPrivacy, audit); got.Action != ActionUpdate {
			t.Fatalf("audit policy = %+v", got)
		}
		if got := item(t, report, SectionPrivacy, "Member administration"); got.Action != ActionCreate {
			t.Fatalf("activity = %+v", got)
		}
		if got := policyOf(t, target, privacycatalog.AuditEvents, privacy.PolicyDraft); got.PeriodDays != 400 || got.Purpose != "Security review" {
			t.Fatalf("imported draft = %+v", got)
		}

		// The target approves and activates its own, different decision; the file's version becomes a new draft next to it
		// and the active decision stays in force. Importing the same file again changes nothing.
		draft := policyOf(t, target, privacycatalog.AuditEvents, privacy.PolicyDraft)
		must(target.s.Privacy.UpdatePolicy(target.ctx, target.master, draft.ID, privacy.PolicyInput{
			Category: draft.Category, Trigger: draft.Trigger, PeriodDays: 730, Action: draft.Action,
			Purpose: "Local decision", LegalBasis: "Art. 6(1)(f) GDPR", Reason: "Two years.",
		}, nil))
		must(target.s.Privacy.TransitionPolicy(target.ctx, target.master, draft.ID, privacy.PolicyApproved, nil))
		must(target.s.Privacy.TransitionPolicy(target.ctx, target.master, draft.ID, privacy.PolicyActive, nil))
		report = target.importFile(target.master, ModeOverwrite, data, keys...)
		if got := item(t, report, SectionPrivacy, audit); got.Action != ActionCreate || got.Reason != policyKeptReason {
			t.Fatalf("decision next to an active policy = %+v", got)
		}
		if got := policyOf(t, target, privacycatalog.AuditEvents, privacy.PolicyActive); got.PeriodDays != 730 {
			t.Fatalf("active policy changed: %+v", got)
		}
		again := must(target.svc.Preview(target.ctx, target.master, ModeOverwrite, keys, bytes.NewReader(data)))
		if c := again.Sections[0].Counts; c.Create+c.Update+c.Delete+c.Conflict != 0 {
			t.Fatalf("second import is not idempotent: %+v", again.Sections[0].Items)
		}
		// The export of the target carries its active decision, not the imported draft.
		var exported privacyEntry
		if err := json.Unmarshal(sectionsOf(t, target.export(target.master, keys...))[SectionPrivacy], &exported); err != nil {
			t.Fatal(err)
		}
		for _, policy := range exported.RetentionPolicies {
			if policy.Category == audit && policy.PeriodDays != 730 {
				t.Fatalf("exported audit policy = %+v", policy)
			}
		}

		// A file without a category keeps the target's decision; an unknown category or trigger is a conflict; insert mode
		// leaves existing decisions untouched; the processing activity missing from the file is deleted in overwrite mode.
		trimmed := withPrivacySection(t, data, func(entry *privacyEntry) {
			entry.RetentionPolicies = slices.DeleteFunc(entry.RetentionPolicies, func(p retentionPolicyEntry) bool { return p.Category == audit })
			entry.RetentionPolicies = append(entry.RetentionPolicies, retentionPolicyEntry{
				Category: "events.content", Trigger: "created_at", PeriodDays: 10, Action: "delete", Purpose: "x", LegalBasis: "y", Reason: "z",
			})
			entry.ProcessingActivities = nil
		})
		preview := must(target.svc.Preview(target.ctx, target.master, ModeOverwrite, keys, bytes.NewReader(trimmed)))
		if got := item(t, preview, SectionPrivacy, audit); got.Action != ActionKeep {
			t.Fatalf("missing decision = %+v", got)
		}
		if got := item(t, preview, SectionPrivacy, "events.content"); got.Action != ActionConflict {
			t.Fatalf("unsupported trigger = %+v", got)
		}
		if got := item(t, preview, SectionPrivacy, "Member administration"); got.Action != ActionDelete {
			t.Fatalf("activity missing from the file = %+v", got)
		}
		insert := must(target.svc.Preview(target.ctx, target.master, ModeInsert, keys, bytes.NewReader(data)))
		if got := item(t, insert, SectionPrivacy, audit); got.Action != ActionSkip {
			t.Fatalf("insert mode = %+v", got)
		}
		if got := item(t, insert, SectionPrivacy, privacySettingsItem); got.Action != ActionSkip {
			t.Fatalf("settings in insert mode = %+v", got)
		}
	})
}

func TestProcessesTravelWithMeasuresAndMaterialTypesResolveThemByName(t *testing.T) {
	source := newEnv(t)
	source.seed()
	data := source.export(source.master, SectionProcesses, SectionMaterialTypes)
	sections := sectionsOf(t, data)
	var processes []processEntry
	if err := json.Unmarshal(sections[SectionProcesses], &processes); err != nil {
		t.Fatal(err)
	}
	var embroidery *processEntry
	for i := range processes {
		if processes[i].Name == "Embroidery" {
			embroidery = &processes[i]
		}
	}
	if embroidery == nil || embroidery.Integration != "none" || !embroidery.Active ||
		fmt.Sprint(embroidery.Measures) != "[{stitches Stitches stitch 1000}]" {
		t.Fatalf("exported processes = %+v", processes)
	}

	// A material type names processes the target does not have: a conflict, nothing imported.
	t.Run("missing process", func(t *testing.T) {
		empty := newEnv(t)
		preview := must(empty.svc.Preview(empty.ctx, empty.master, ModeInsert, []SectionKey{SectionMaterialTypes},
			bytes.NewReader(data)))
		if got := item(t, preview, SectionMaterialTypes, "Thread"); got.Action != ActionConflict ||
			got.Code != "process_missing" {
			t.Fatalf("Thread = %+v", got)
		}
	})

	// With the processes section the ids are those of the target instance.
	t.Run("names resolve to the ids of the target", func(t *testing.T) {
		target := newEnv(t)
		target.importFile(target.master, ModeInsert, data, SectionProcesses, SectionMaterialTypes)
		var linked string
		if err := target.pool.QueryRow(target.ctx, `SELECT string_agg(p.name, ',' ORDER BY p.name)
			FROM material_type_processes l
			JOIN material_types t ON t.id = l.material_type_id
			JOIN processes p ON p.id = l.process_id
			WHERE t.name = 'Thread'`).Scan(&linked); err != nil || linked != "Embroidery" {
			t.Fatalf("Thread processes = %q, %v", linked, err)
		}
		again := sectionsOf(t, target.export(target.master, SectionProcesses, SectionMaterialTypes))
		for _, key := range []SectionKey{SectionProcesses, SectionMaterialTypes} {
			if canonical(t, again[key]) != canonical(t, sections[key]) {
				t.Errorf("section %s differs after import:\n got %s\nwant %s", key, again[key], sections[key])
			}
		}
	})

	// An overwrite that drops a measure pricing rules still use is refused for that process only.
	t.Run("measure in use", func(t *testing.T) {
		target := newEnv(t)
		target.importFile(target.master, ModeInsert, data, SectionProcesses)
		row := must(target.s.MachineLogbook.ListProcesses(target.ctx, target.master))
		var id uuid.UUID
		for _, process := range row {
			if process.Name == "Embroidery" {
				id = process.ID
			}
		}
		group := must(target.s.MachineLogbook.CreatePricingGroup(target.ctx, target.master, "Stitchers", nil, false, nil))
		stitches := "stitches"
		must(target.s.MachineLogbook.CreatePricingRule(target.ctx, target.master, group.ID, "machine_measure", &id, nil,
			&stitches, "0.5", nil))
		parsed := file{}
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatal(err)
		}
		parsed.Sections = map[SectionKey]json.RawMessage{
			SectionProcesses: json.RawMessage(`[{"name":"Embroidery","integration":"none","measures":[],"active":true}]`),
		}
		trimmed := must(json.Marshal(parsed))
		preview := must(target.svc.Preview(target.ctx, target.master, ModeOverwrite, []SectionKey{SectionProcesses},
			bytes.NewReader(trimmed)))
		if got := item(t, preview, SectionProcesses, "Embroidery"); got.Action != ActionConflict ||
			got.Code != "measure_in_use" {
			t.Fatalf("Embroidery = %+v", got)
		}
	})
}

func TestMaterialTypeVariantsTravelAndOlderFilesStillImport(t *testing.T) {
	source := newEnv(t)
	source.seed()
	keys := []SectionKey{
		SectionDeviceTypes, SectionRoles, SectionProcesses, SectionMaterialTypes, SectionInventoryArticles, SectionPricing,
	}
	data := source.export(source.master, keys...)
	sections := sectionsOf(t, data)
	if !strings.Contains(canonical(t, sections[SectionMaterialTypes]), `"variants":["Matte","Silk"]`) ||
		!strings.Contains(canonical(t, sections[SectionInventoryArticles]), `"variant":"Silk"`) ||
		!strings.Contains(canonical(t, sections[SectionPricing]), `"variant":"Matte"`) {
		t.Fatalf("export does not carry the variants: %s", data)
	}
	t.Run("round trip into a fresh instance", func(t *testing.T) {
		target := newEnv(t)
		target.importFile(target.master, ModeOverwrite, data, keys...)
		got := sectionsOf(t, target.export(target.master, keys...))
		for _, key := range keys {
			if canonical(t, got[key]) != canonical(t, sections[key]) {
				t.Errorf("section %s differs:\n got %s\nwant %s", key, got[key], sections[key])
			}
		}
		var matteRules, typeRules int
		if err := target.pool.QueryRow(target.ctx, `SELECT
			count(*) FILTER (WHERE v.name = 'Matte'), count(*) FILTER (WHERE r.material_type_variant_id IS NULL)
			FROM pricing_rules r LEFT JOIN material_type_variants v ON v.id = r.material_type_variant_id
			WHERE r.kind = 'material' AND r.active`).Scan(&matteRules, &typeRules); err != nil ||
			matteRules != 1 || typeRules != 1 {
			t.Fatalf("variant rules = %d, type rules = %d, %v", matteRules, typeRules, err)
		}
		var articleVariant string
		if err := target.pool.QueryRow(target.ctx, `SELECT v.name FROM materials m
			JOIN material_type_variants v ON v.id = m.variant_id WHERE m.name = 'PLA Silk Gold' AND m.variant = v.name`).
			Scan(&articleVariant); err != nil || articleVariant != "Silk" {
			t.Fatalf("article variant = %q, %v", articleVariant, err)
		}
		again := must(target.svc.Preview(target.ctx, target.master, ModeOverwrite, keys, bytes.NewReader(data)))
		for _, section := range again.Sections {
			c := section.Counts
			if c.Create+c.Update+c.Delete+c.Deactivate+c.Conflict != 0 {
				t.Errorf("section %s is not idempotent: %+v %+v", section.Key, c, section.Items)
			}
		}
	})

	t.Run("overwrite adds variants and keeps local ones", func(t *testing.T) {
		target := newEnv(t)
		target.importFile(target.master, ModeOverwrite, data, keys...)
		pla := must(target.s.MachineLogbook.ListMaterialTypes(target.ctx, target.master))
		var plaID uuid.UUID
		for _, materialType := range pla {
			if materialType.Name == "PLA" {
				plaID = materialType.ID
			}
		}
		must(target.s.MachineLogbook.CreateMaterialTypeVariant(target.ctx, target.master, plaID, "Local only", nil))
		target.importFile(target.master, ModeOverwrite, data, keys...)
		var names string
		if err := target.pool.QueryRow(target.ctx, `SELECT string_agg(name, ',' ORDER BY name) FROM material_type_variants`).
			Scan(&names); err != nil || names != "Local only,Matte,Silk" {
			t.Fatalf("variants = %q, %v", names, err)
		}
	})

	t.Run("a rule for an unknown variant is a conflict", func(t *testing.T) {
		target := newEnv(t)
		bad := regexp.MustCompile(`"variant":\s*"Matte"`).ReplaceAllString(string(data), `"variant": "Unknown"`)
		if bad == string(data) {
			t.Fatal("the variant rule is not in the file")
		}
		preview := must(target.svc.Preview(target.ctx, target.master, ModeOverwrite, keys, strings.NewReader(bad)))
		if got := item(t, preview, SectionPricing, "Members"); got.Action != ActionConflict ||
			got.Code != "pricing_target_missing" {
			t.Fatalf("Members = %+v", got)
		}
	})

	t.Run("a variant on another kind is refused", func(t *testing.T) {
		target := newEnv(t)
		bad := `{"format":"makerspace-core-config","version":1,"sections":{"pricing":{"groups":[{"name":"G","active":true,` +
			`"isDefault":false,"rules":[{"kind":"machine_runtime","process":"FDM","variant":"Matte","rate":"1"}]}],` +
			`"rolePricingGroups":[]}}}`
		if _, err := target.svc.Preview(target.ctx, target.master, ModeOverwrite, []SectionKey{SectionPricing},
			strings.NewReader(bad)); !apperror.IsCode(err, "configuration_file_invalid") {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("older files without variants import unchanged", func(t *testing.T) {
		older := withoutVariants(t, data)
		if strings.Contains(string(older), "ariant") {
			t.Fatal("test file still contains variants")
		}
		target := newEnv(t)
		target.importFile(target.master, ModeOverwrite, older, keys...)
		var variants int
		if err := target.pool.QueryRow(target.ctx, `SELECT count(*) FROM material_type_variants`).Scan(&variants); err != nil ||
			variants != 0 {
			t.Fatalf("variants = %d, %v", variants, err)
		}
	})
}

// withoutVariants removes every variant field from the sections of an export, as a release without variants wrote it.
func withoutVariants(t *testing.T, data []byte) []byte {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatal(err)
	}
	var strip func(value any) any
	strip = func(value any) any {
		switch v := value.(type) {
		case map[string]any:
			delete(v, "variants")
			delete(v, "variant")
			for key, child := range v {
				v[key] = strip(child)
			}
		case []any:
			kept := v[:0]
			for _, child := range v {
				if m, ok := child.(map[string]any); ok && m["kind"] == "material" && m["variant"] != nil {
					continue // a variant rule did not exist
				}
				kept = append(kept, strip(child))
			}
			return kept
		}
		return value
	}
	out, err := json.Marshal(strip(parsed))
	if err != nil {
		t.Fatal(err)
	}
	return out
}
