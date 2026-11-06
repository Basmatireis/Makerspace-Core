package configtransfer

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	configtransferdb "github.com/Basmatireis/Makerspace-Core/backend/internal/configtransfer/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/invoicing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/visitor"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Settings sections are single records that always exist: insert mode leaves them untouched and overwrite updates
// them. Roles and device types are referenced by name.

const (
	staffingRulesItem     = "Staffing rules"
	visitorEnrollmentItem = "Visitor enrollment"
	mailItem              = "Mail delivery"
	invoicingItem         = "wiRef invoice delivery"
)

// Staffing rules: the rules with their exceptions, which name extra roles by name. Files of releases before the
// staffing rules carry an "openDayRequirements" section instead, which an import reports as unknown and ignores.

type staffingExceptionEntry struct {
	Role    string `json:"role"`
	Minimum int    `json:"minimum"`
}

type staffingRulesEntry struct {
	SupervisorMinimum int                      `json:"supervisorMinimum"`
	TraineeMinimum    int                      `json:"traineeMinimum"`
	TraineeReadyAfter int                      `json:"traineeReadyAfter"`
	WarningWindowDays int                      `json:"warningWindowDays"`
	CountBy           string                   `json:"countBy"`
	DefaultDeadline   string                   `json:"defaultDeadline"`
	Exceptions        []staffingExceptionEntry `json:"exceptions"`
}

func staffingRulesSection() section {
	return define(
		SectionStaffingRules,
		permissions(authorization.OpenDaysManage),
		permissions(authorization.OpenDaysManage),
		exportStaffingRules,
		validateStaffingRules,
		applyStaffingRules,
	)
}

func exportStaffingRules(ctx context.Context, q *configtransferdb.Queries) (staffingRulesEntry, error) {
	row, err := q.GetStaffingRules(ctx)
	if err != nil {
		return staffingRulesEntry{}, err
	}
	exceptions, err := q.ListStaffingRuleExceptions(ctx)
	if err != nil {
		return staffingRulesEntry{}, err
	}
	entry := staffingRulesEntry{
		SupervisorMinimum: int(row.SupervisorMinimum),
		TraineeMinimum:    int(row.TraineeMinimum),
		TraineeReadyAfter: int(row.TraineeReadyAfter),
		WarningWindowDays: int(row.WarningWindowDays),
		CountBy:           row.CountBy,
		DefaultDeadline:   row.DefaultDeadline,
		Exceptions:        make([]staffingExceptionEntry, 0, len(exceptions)),
	}
	for _, exception := range exceptions {
		entry.Exceptions = append(entry.Exceptions, staffingExceptionEntry{
			Role: exception.RoleName, Minimum: int(exception.Minimum),
		})
	}
	return entry, nil
}

func validateStaffingRules(entry *staffingRulesEntry) error {
	if entry.Exceptions == nil {
		entry.Exceptions = []staffingExceptionEntry{}
	}
	if len(entry.Exceptions) > staffing.MaxExceptions {
		return errors.New("too many staffing exceptions")
	}
	names := make([]*string, len(entry.Exceptions))
	for i := range entry.Exceptions {
		names[i] = &entry.Exceptions[i].Role
		if entry.Exceptions[i].Minimum < 0 || entry.Exceptions[i].Minimum > staffing.MaxMinimum {
			return errors.New("exception minimums must be between 0 and 20")
		}
	}
	if !staffing.CountBy(entry.CountBy).Valid() {
		return errors.New("countBy is invalid")
	}
	if !staffing.DefaultDeadline(entry.DefaultDeadline).Valid() {
		return errors.New("defaultDeadline is invalid")
	}
	return checkNames("staffing exception role", names, 100)
}

func applyStaffingRules(r *run, entry *staffingRulesEntry) (func() error, error) {
	if r.mode == ModeInsert {
		r.skip(staffingRulesItem, reasonSingleton)
		return nil, nil
	}
	current, err := exportStaffingRules(r.ctx, r.q)
	if err != nil {
		return nil, err
	}
	if sameStaffingRules(current, *entry) {
		r.skip(staffingRulesItem, reasonUnchanged)
		return nil, nil
	}
	input := staffing.UpdateInput{
		SupervisorMinimum: entry.SupervisorMinimum,
		TraineeMinimum:    entry.TraineeMinimum,
		TraineeReadyAfter: entry.TraineeReadyAfter,
		WarningWindowDays: entry.WarningWindowDays,
		CountBy:           staffing.CountBy(entry.CountBy),
		DefaultDeadline:   staffing.DefaultDeadline(entry.DefaultDeadline),
	}
	for _, exception := range entry.Exceptions {
		roleID, problem, err := roleIDByName(r.ctx, r.q, &exception.Role)
		if err != nil {
			return nil, err
		}
		if problem != "" {
			r.conflict(staffingRulesItem, "role_missing", problem)
			return nil, nil
		}
		input.Exceptions = append(input.Exceptions, staffing.ExceptionInput{RoleID: *roleID, Minimum: exception.Minimum})
	}
	row, err := r.q.GetStaffingRules(r.ctx)
	if err != nil {
		return nil, err
	}
	input.ExpectedVersion = row.Version
	_, err = r.attempt(staffingRulesItem, ActionUpdate, "", func(tx pgx.Tx) error {
		_, err := r.svc.Staffing.UpdateRulesTx(r.ctx, tx, r.p, input, r.requestID)
		return err
	})
	return nil, err
}

func sameStaffingRules(a, b staffingRulesEntry) bool {
	if a.SupervisorMinimum != b.SupervisorMinimum || a.TraineeMinimum != b.TraineeMinimum ||
		a.TraineeReadyAfter != b.TraineeReadyAfter || a.WarningWindowDays != b.WarningWindowDays ||
		a.CountBy != b.CountBy || a.DefaultDeadline != b.DefaultDeadline || len(a.Exceptions) != len(b.Exceptions) {
		return false
	}
	minimums := make(map[string]int, len(a.Exceptions))
	for _, exception := range a.Exceptions {
		minimums[nameKey(exception.Role)] = exception.Minimum
	}
	for _, exception := range b.Exceptions {
		minimum, ok := minimums[nameKey(exception.Role)]
		if !ok || minimum != exception.Minimum {
			return false
		}
	}
	return true
}

// roleIDByName resolves an optional role name; a missing role is a problem of the entry, not an error.
func roleIDByName(ctx context.Context, q *configtransferdb.Queries, name *string) (*uuid.UUID, string, error) {
	if name == nil {
		return nil, "", nil
	}
	rows, err := q.ListRoles(ctx)
	if err != nil {
		return nil, "", err
	}
	for _, row := range rows {
		if nameKey(row.Name) == nameKey(*name) {
			return ptr(row.ID), "", nil
		}
	}
	return nil, fmt.Sprintf("The role %q does not exist.", *name), nil
}

type visitorEnrollmentEntry struct {
	Enabled bool `json:"enabled"`
	// InitialRole is accepted from files of releases before membership roles and ignored: enrolled visitors get the
	// Visitor membership like every new person.
	InitialRole    *string  `json:"initialRole,omitempty"`
	AllowedMethods []string `json:"allowedMethods"`
	DeviceTypes    []string `json:"deviceTypes"`
}

func visitorEnrollmentSection() section {
	return define(
		SectionVisitorEnrollment,
		permissions(authorization.VisitorEnrollmentManage),
		permissions(authorization.VisitorEnrollmentManage),
		exportVisitorEnrollment,
		func(entry *visitorEnrollmentEntry) error {
			entry.InitialRole = nil
			entry.AllowedMethods = sortedStrings(entry.AllowedMethods)
			if entry.DeviceTypes == nil {
				entry.DeviceTypes = []string{}
			}
			for i := range entry.DeviceTypes {
				entry.DeviceTypes[i] = strings.TrimSpace(entry.DeviceTypes[i])
			}
			return nil
		},
		applyVisitorEnrollment,
	)
}

func exportVisitorEnrollment(ctx context.Context, q *configtransferdb.Queries) (visitorEnrollmentEntry, error) {
	row, err := q.GetVisitorEnrollmentConfiguration(ctx)
	if err != nil {
		return visitorEnrollmentEntry{}, err
	}
	types, err := q.ListVisitorEnrollmentDeviceTypes(ctx)
	if err != nil {
		return visitorEnrollmentEntry{}, err
	}
	entry := visitorEnrollmentEntry{
		Enabled:        row.Enabled,
		AllowedMethods: sortedStrings(row.AllowedMethods),
		DeviceTypes:    make([]string, 0, len(types)),
	}
	for _, deviceType := range types {
		entry.DeviceTypes = append(entry.DeviceTypes, deviceType.Name)
	}
	return entry, nil
}

func lowerNames(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		result = append(result, nameKey(value))
	}
	return sortedStrings(result)
}

func applyVisitorEnrollment(r *run, entry *visitorEnrollmentEntry) (func() error, error) {
	if r.mode == ModeInsert {
		r.skip(visitorEnrollmentItem, reasonSingleton)
		return nil, nil
	}
	current, err := exportVisitorEnrollment(r.ctx, r.q)
	if err != nil {
		return nil, err
	}
	if current.Enabled == entry.Enabled &&
		slices.Equal(current.AllowedMethods, entry.AllowedMethods) &&
		slices.Equal(lowerNames(current.DeviceTypes), lowerNames(entry.DeviceTypes)) {
		r.skip(visitorEnrollmentItem, reasonUnchanged)
		return nil, nil
	}
	problem := ""
	types, err := deviceTypeIDs(r.ctx, r.q)
	if err != nil {
		return nil, err
	}
	input := visitor.ConfigurationInput{Enabled: entry.Enabled}
	for _, name := range entry.DeviceTypes {
		id, ok := types[nameKey(name)]
		if !ok && problem == "" {
			problem = fmt.Sprintf("The device type %q does not exist.", name)
		}
		input.DeviceTypeIDs = append(input.DeviceTypeIDs, id)
	}
	if problem != "" {
		r.conflict(visitorEnrollmentItem, "reference_missing", problem)
		return nil, nil
	}
	for _, method := range entry.AllowedMethods {
		input.AllowedMethods = append(input.AllowedMethods, visitor.AuthMethod(method))
	}
	row, err := r.q.GetVisitorEnrollmentConfiguration(r.ctx)
	if err != nil {
		return nil, err
	}
	input.ExpectedVersion = row.Version
	_, err = r.attempt(visitorEnrollmentItem, ActionUpdate, "", func(tx pgx.Tx) error {
		_, err := r.svc.Visitor.UpdateConfigurationTx(r.ctx, tx, r.p, input, r.requestID)
		return err
	})
	return nil, err
}

// Mail: the SMTP password is never exported. Changing the server, port, TLS mode or username drops a stored password
// so it is never sent to a server it was not entered for; delivery then stays disabled until it is entered again.

type mailEntry struct {
	Enabled     bool   `json:"enabled"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	TLSMode     string `json:"tlsMode"`
	Username    string `json:"username"`
	FromAddress string `json:"fromAddress"`
	FromName    string `json:"fromName"`
	BaseURL     string `json:"baseUrl"`
}

func mailSection() section {
	return define(
		SectionMail,
		permissions(authorization.MailManage),
		permissions(authorization.MailManage),
		func(ctx context.Context, q *configtransferdb.Queries) (mailEntry, error) {
			row, err := q.GetMailConfiguration(ctx)
			if err != nil {
				return mailEntry{}, err
			}
			return mailFromRow(row), nil
		},
		func(entry *mailEntry) error {
			for _, field := range []*string{
				&entry.Host, &entry.TLSMode, &entry.Username, &entry.FromAddress, &entry.FromName, &entry.BaseURL,
			} {
				*field = strings.TrimSpace(*field)
			}
			return nil
		},
		applyMail,
	)
}

func mailFromRow(row configtransferdb.GetMailConfigurationRow) mailEntry {
	return mailEntry{
		Enabled:     row.Enabled,
		Host:        row.SmtpHost,
		Port:        int(row.SmtpPort),
		TLSMode:     row.SmtpTlsMode,
		Username:    row.SmtpUsername,
		FromAddress: row.FromAddress,
		FromName:    row.FromName,
		BaseURL:     row.BaseUrl,
	}
}

func applyMail(r *run, entry *mailEntry) (func() error, error) {
	if r.mode == ModeInsert {
		r.skip(mailItem, reasonSingleton)
		return nil, nil
	}
	row, err := r.q.GetMailConfiguration(r.ctx)
	if err != nil {
		return nil, err
	}
	current := mailFromRow(row)
	serverChanged := !strings.EqualFold(current.Host, entry.Host) || current.Port != entry.Port ||
		current.TLSMode != entry.TLSMode || current.Username != entry.Username
	clearPassword := row.PasswordConfigured && serverChanged
	passwordAvailable := row.PasswordConfigured && !clearPassword
	desired := *entry
	var notes []string
	if clearPassword {
		notes = append(notes, "The stored SMTP password was removed because the server or username changed.")
	}
	switch {
	case desired.Enabled && !r.svc.Mail.EncryptionAvailable():
		desired.Enabled = false
		notes = append(notes, "Delivery stays disabled: application encryption keys are not configured.")
	case desired.Enabled && desired.Username != "" && !passwordAvailable:
		desired.Enabled = false
		notes = append(notes, "Delivery stays disabled until the SMTP password is entered.")
	}
	if desired == current && !clearPassword {
		r.skip(mailItem, strings.Join(append([]string{reasonUnchanged}, notes...), " "))
		return nil, nil
	}
	_, err = r.attempt(mailItem, ActionUpdate, strings.Join(notes, " "), func(tx pgx.Tx) error {
		_, err := r.svc.Mail.UpdateConfigurationTx(r.ctx, tx, r.p, mail.ConfigurationInput{
			Enabled:         desired.Enabled,
			Host:            desired.Host,
			Username:        desired.Username,
			FromAddress:     desired.FromAddress,
			FromName:        desired.FromName,
			BaseURL:         desired.BaseURL,
			ClearPassword:   clearPassword,
			TLSMode:         mail.TLSMode(desired.TLSMode),
			Port:            desired.Port,
			ExpectedVersion: row.Version,
		}, r.requestID)
		return err
	})
	return nil, err
}

// Invoicing: the wiRef recipient, CC list, Reply-To address, templates and field toggles. Templates use the placeholder
// validation of the settings endpoint; the German placeholder names of files exported by 0.8.3 and 0.8.4 are renamed
// first.

type invoicingEntry struct {
	Enabled                bool     `json:"enabled"`
	RecipientEmail         string   `json:"recipientEmail"`
	CCEmails               []string `json:"ccEmails"`
	ReplyToEmail           string   `json:"replyToEmail"`
	MailSubject            string   `json:"mailSubject"`
	MailIntro              string   `json:"mailIntro"`
	MailClosing            string   `json:"mailClosing"`
	PDFTitle               string   `json:"pdfTitle"`
	PDFIntro               string   `json:"pdfIntro"`
	PDFClosing             string   `json:"pdfClosing"`
	ShowContactPerson      bool     `json:"showContactPerson"`
	ShowApprover           bool     `json:"showApprover"`
	ShowPurchaseOrder      bool     `json:"showPurchaseOrder"`
	ShowServicePeriod      bool     `json:"showServicePeriod"`
	ShowServiceDescription bool     `json:"showServiceDescription"`
}

func invoicingSection() section {
	return define(
		SectionInvoicing,
		permissions(authorization.InvoicingSettingsManage),
		permissions(authorization.InvoicingSettingsManage),
		exportInvoicing,
		func(entry *invoicingEntry) error {
			for _, field := range []*string{
				&entry.RecipientEmail, &entry.ReplyToEmail, &entry.MailSubject, &entry.MailIntro, &entry.MailClosing,
				&entry.PDFTitle, &entry.PDFIntro, &entry.PDFClosing,
			} {
				*field = strings.TrimSpace(*field)
			}
			for _, field := range []*string{
				&entry.MailSubject, &entry.MailIntro, &entry.MailClosing, &entry.PDFTitle, &entry.PDFIntro, &entry.PDFClosing,
			} {
				*field = invoicing.RenameLegacyPlaceholders(*field)
			}
			if entry.CCEmails == nil {
				entry.CCEmails = []string{}
			}
			for i := range entry.CCEmails {
				entry.CCEmails[i] = strings.TrimSpace(entry.CCEmails[i])
			}
			return invoicing.ValidateTemplates(entry.templates())
		},
		applyInvoicing,
	)
}

func (e invoicingEntry) templates() invoicing.Templates {
	return invoicing.Templates{
		MailSubject: e.MailSubject, MailIntro: e.MailIntro, MailClosing: e.MailClosing,
		PDFTitle: e.PDFTitle, PDFIntro: e.PDFIntro, PDFClosing: e.PDFClosing,
		ShowContactPerson: e.ShowContactPerson, ShowApprover: e.ShowApprover, ShowPurchaseOrder: e.ShowPurchaseOrder,
		ShowServicePeriod: e.ShowServicePeriod, ShowServiceDescription: e.ShowServiceDescription,
	}
}

func exportInvoicing(ctx context.Context, q *configtransferdb.Queries) (invoicingEntry, error) {
	row, err := q.GetWirefDeliverySettings(ctx)
	if err != nil {
		return invoicingEntry{}, err
	}
	return invoicingFromRow(row), nil
}

func invoicingFromRow(row configtransferdb.GetWirefDeliverySettingsRow) invoicingEntry {
	cc := row.CcEmails
	if cc == nil {
		cc = []string{}
	}
	return invoicingEntry{
		Enabled: row.Enabled, RecipientEmail: row.RecipientEmail, CCEmails: cc, ReplyToEmail: row.ReplyToEmail,
		MailSubject: row.MailSubject, MailIntro: row.MailIntro, MailClosing: row.MailClosing,
		PDFTitle: row.PdfTitle, PDFIntro: row.PdfIntro, PDFClosing: row.PdfClosing,
		ShowContactPerson: row.ShowContactPerson, ShowApprover: row.ShowApprover,
		ShowPurchaseOrder: row.ShowPurchaseOrder, ShowServicePeriod: row.ShowServicePeriod,
		ShowServiceDescription: row.ShowServiceDescription,
	}
}

func applyInvoicing(r *run, entry *invoicingEntry) (func() error, error) {
	if r.mode == ModeInsert {
		r.skip(invoicingItem, reasonSingleton)
		return nil, nil
	}
	row, err := r.q.GetWirefDeliverySettings(r.ctx)
	if err != nil {
		return nil, err
	}
	current := invoicingFromRow(row)
	if current.Enabled == entry.Enabled && current.RecipientEmail == entry.RecipientEmail &&
		slices.Equal(current.CCEmails, entry.CCEmails) && current.ReplyToEmail == entry.ReplyToEmail &&
		current.templates() == entry.templates() {
		r.skip(invoicingItem, reasonUnchanged)
		return nil, nil
	}
	_, err = r.attempt(invoicingItem, ActionUpdate, "", func(tx pgx.Tx) error {
		_, err := r.svc.Invoicing.UpdateSettingsTx(r.ctx, tx, r.p, invoicing.SettingsInput{
			Templates:       entry.templates(),
			Enabled:         entry.Enabled,
			RecipientEmail:  entry.RecipientEmail,
			CCEmails:        entry.CCEmails,
			ReplyToEmail:    entry.ReplyToEmail,
			ExpectedVersion: row.Version,
		}, r.requestID)
		return err
	})
	return nil, err
}
