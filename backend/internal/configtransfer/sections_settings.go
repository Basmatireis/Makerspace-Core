package configtransfer

import (
	"context"
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
	openDayRequirementsItem = "Open-day requirements"
	visitorEnrollmentItem   = "Visitor enrollment"
	mailItem                = "Mail delivery"
	invoicingItem           = "wiRef invoice delivery"
)

type openDayRequirementsEntry struct {
	MinOpenDaysPerSemester      int     `json:"minOpenDaysPerSemester"`
	TraineeOpenDaysForPromotion int     `json:"traineeOpenDaysForPromotion"`
	SupervisorRole              *string `json:"supervisorRole"`
}

func openDayRequirementsSection() section {
	return define(
		SectionOpenDayRequirements,
		permissions(authorization.OpenDaysRead),
		permissions(authorization.OpenDaysManage),
		func(ctx context.Context, q *configtransferdb.Queries) (openDayRequirementsEntry, error) {
			row, err := q.GetOpenDayRequirements(ctx)
			if err != nil {
				return openDayRequirementsEntry{}, err
			}
			return openDayRequirementsEntry{
				MinOpenDaysPerSemester:      int(row.MinOpenDaysPerSemester),
				TraineeOpenDaysForPromotion: int(row.TraineeOpenDaysForPromotion),
				SupervisorRole:              row.SupervisorRoleName,
			}, nil
		},
		func(entry *openDayRequirementsEntry) error {
			entry.SupervisorRole = trimmed(entry.SupervisorRole)
			return nil
		},
		func(r *run, entry *openDayRequirementsEntry) (func() error, error) {
			if r.mode == ModeInsert {
				r.skip(openDayRequirementsItem, reasonSingleton)
				return nil, nil
			}
			current, err := r.q.GetOpenDayRequirements(r.ctx)
			if err != nil {
				return nil, err
			}
			if int(current.MinOpenDaysPerSemester) == entry.MinOpenDaysPerSemester &&
				int(current.TraineeOpenDaysForPromotion) == entry.TraineeOpenDaysForPromotion &&
				sameName(current.SupervisorRoleName, entry.SupervisorRole) {
				r.skip(openDayRequirementsItem, reasonUnchanged)
				return nil, nil
			}
			roleID, problem, err := roleIDByName(r.ctx, r.q, entry.SupervisorRole)
			if err != nil {
				return nil, err
			}
			if problem != "" {
				r.conflict(openDayRequirementsItem, "role_missing", problem)
				return nil, nil
			}
			_, err = r.attempt(openDayRequirementsItem, ActionUpdate, "", func(tx pgx.Tx) error {
				_, err := r.svc.Staffing.UpdateRequirementsTx(r.ctx, tx, r.p, staffing.UpdateInput{
					ExpectedVersion:             current.Version,
					MinOpenDaysPerSemester:      entry.MinOpenDaysPerSemester,
					TraineeOpenDaysForPromotion: entry.TraineeOpenDaysForPromotion,
					SupervisorRoleID:            roleID,
				}, r.requestID)
				return err
			})
			return nil, err
		},
	)
}

func sameName(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return nameKey(*a) == nameKey(*b)
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
	Enabled        bool     `json:"enabled"`
	InitialRole    *string  `json:"initialRole"`
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
			entry.InitialRole = trimmed(entry.InitialRole)
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
		InitialRole:    row.InitialRoleName,
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
	if current.Enabled == entry.Enabled && sameName(current.InitialRole, entry.InitialRole) &&
		slices.Equal(current.AllowedMethods, entry.AllowedMethods) &&
		slices.Equal(lowerNames(current.DeviceTypes), lowerNames(entry.DeviceTypes)) {
		r.skip(visitorEnrollmentItem, reasonUnchanged)
		return nil, nil
	}
	roleID, problem, err := roleIDByName(r.ctx, r.q, entry.InitialRole)
	if err != nil {
		return nil, err
	}
	types, err := deviceTypeIDs(r.ctx, r.q)
	if err != nil {
		return nil, err
	}
	input := visitor.ConfigurationInput{Enabled: entry.Enabled, InitialRoleID: roleID}
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

// Invoicing: the wiRef recipient, CC list, templates and field toggles. Templates use the placeholder validation of the
// settings endpoint.

type invoicingEntry struct {
	Enabled                bool     `json:"enabled"`
	RecipientEmail         string   `json:"recipientEmail"`
	CCEmails               []string `json:"ccEmails"`
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
				&entry.RecipientEmail, &entry.MailSubject, &entry.MailIntro, &entry.MailClosing,
				&entry.PDFTitle, &entry.PDFIntro, &entry.PDFClosing,
			} {
				*field = strings.TrimSpace(*field)
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
		Enabled: row.Enabled, RecipientEmail: row.RecipientEmail, CCEmails: cc,
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
		slices.Equal(current.CCEmails, entry.CCEmails) && current.templates() == entry.templates() {
		r.skip(invoicingItem, reasonUnchanged)
		return nil, nil
	}
	_, err = r.attempt(invoicingItem, ActionUpdate, "", func(tx pgx.Tx) error {
		_, err := r.svc.Invoicing.UpdateSettingsTx(r.ctx, tx, r.p, invoicing.SettingsInput{
			Templates:       entry.templates(),
			Enabled:         entry.Enabled,
			RecipientEmail:  entry.RecipientEmail,
			CCEmails:        entry.CCEmails,
			ExpectedVersion: row.Version,
		}, r.requestID)
		return err
	})
	return nil, err
}
