package workinggroups

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"log/slog"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/invoicing"
	mailservice "github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

const (
	maxSignaturePixels = 4000
	deliveryTimeout    = 60 * time.Second
	// maxMailAttachmentBytes bounds the files attached to one Projektantrag mail; what does not fit is listed in the body.
	maxMailAttachmentBytes = 20 << 20
	dateLayout             = "2006-01-02"
)

// WiRefMailer sends a message to the wiRef address that the wiRef settings configure.
type WiRefMailer interface {
	SendMessage(ctx context.Context, subject string, paragraphs []string, attachments []mailservice.Attachment) invoicing.Outcome
}

// WithWiRefMailer gives the service the mailer the Projektantrag is sent with.
func (s *Service) WithWiRefMailer(mailer WiRefMailer) *Service {
	s.mailer = mailer
	return s
}

// requestDefaults reads the defaults of the Projektantrag from the rules.
func loadRequestDefaults(ctx context.Context, q *workinggroupsdb.Queries) (RequestDefaults, error) {
	row, err := q.GetWorkingGroupRequestDefaults(ctx)
	if err != nil {
		return RequestDefaults{}, err
	}
	return RequestDefaults{
		UnitKind: row.RequestUnitKind, UnitName: row.RequestUnitName, AddGroupName: row.RequestAddGroupName,
		ResponsiblePerson: personRef(row.RequestResponsiblePersonID, row.ResponsibleDisplayName), Place: row.RequestPlace,
	}, nil
}

func validateDefaultsInput(ctx context.Context, q *workinggroupsdb.Queries, in RequestDefaultsInput) (RequestDefaultsInput, error) {
	switch in.UnitKind {
	case UnitStv, UnitUV, UnitReferat:
	default:
		return in, apperror.InvalidField("request.unitKind")
	}
	name, err := validateText(in.UnitName, "request.unitName", 120, false)
	if err != nil {
		return in, err
	}
	place, err := validateText(in.Place, "request.place", 80, false)
	if err != nil {
		return in, err
	}
	in.UnitName, in.Place = name, place
	if in.ResponsiblePersonID != nil {
		holds, err := q.PersonHoldsPermission(ctx, workinggroupsdb.PersonHoldsPermissionParams{
			PersonID: *in.ResponsiblePersonID, Permission: string(authorization.WorkingGroupFinancesManage),
		})
		if err != nil {
			return in, err
		}
		if !holds {
			return in, apperror.InvalidField("request.responsiblePersonId")
		}
	}
	return in, nil
}

// buildRequestForm builds the Projektantrag of a project from the rules and the project, overridden by the input, and
// resolves the signature (an uploaded one, else the caller's saved one when asked for).
func (s *Service) buildRequestForm(
	ctx context.Context,
	q *workinggroupsdb.Queries,
	p authorization.Principal,
	project Project,
	in RequestFormInput,
) (RequestForm, []byte, error) {
	defaults, err := q.GetWorkingGroupRequestDefaults(ctx)
	if err != nil {
		return RequestForm{}, nil, err
	}
	unit := defaults.RequestUnitName
	if defaults.RequestAddGroupName {
		unit = strings.TrimSpace(unit + " " + project.GroupName)
	}
	description := strings.TrimSpace(project.Goal)
	if b := strings.TrimSpace(project.Benefit); b != "" {
		description = strings.TrimSpace(description + "\n" + b)
	}
	if utf8.RuneCountInString(description) > 2000 {
		description = string([]rune(description)[:2000])
	}
	form := RequestForm{
		UnitKind: defaults.RequestUnitKind, UnitName: unit, Number: project.WiRefNumber, ProjectName: project.Title,
		Alcohol: project.Alcohol, People: int(project.People), Advance: project.AdvanceRequested, Description: description,
		MaxExpenses: project.Totals.Planned, MaxIncome: project.PlannedIncome, Place: defaults.RequestPlace,
		ResponsibleFirstName: defaults.ResponsibleFirstName, ResponsibleLastName: defaults.ResponsibleLastName,
		Date: s.today().Format(dateLayout),
	}
	if project.StartsOn != nil {
		form.StartsOn = project.StartsOn.Format(dateLayout)
	}
	if project.EndsOn != nil {
		form.EndsOn = project.EndsOn.Format(dateLayout)
	}
	set := func(dst *string, src *string, field string, max int) error {
		if src == nil {
			return nil
		}
		clean, err := validateText(*src, field, max, false)
		if err != nil {
			return err
		}
		*dst = clean
		return nil
	}
	if in.UnitKind != nil {
		switch *in.UnitKind {
		case UnitStv, UnitUV, UnitReferat:
			form.UnitKind = *in.UnitKind
		default:
			return form, nil, apperror.InvalidField("unitKind")
		}
	}
	for _, f := range []struct {
		dst  *string
		src  *string
		name string
		max  int
	}{
		{&form.UnitName, in.UnitName, "unitName", 120}, {&form.ProjectName, in.ProjectName, "projectName", 120},
		{&form.Description, in.Description, "description", 2000}, {&form.ResponsibleFirstName, in.ResponsibleFirstName, "responsibleFirstName", 80},
		{&form.ResponsibleLastName, in.ResponsibleLastName, "responsibleLastName", 80}, {&form.Place, in.Place, "place", 80},
	} {
		if err := set(f.dst, f.src, f.name, f.max); err != nil {
			return form, nil, err
		}
	}
	if in.Alcohol != nil {
		form.Alcohol = *in.Alcohol
	}
	if in.Advance != nil {
		form.Advance = *in.Advance
	}
	if in.People != nil {
		if *in.People < 1 || *in.People > maxProjectPeople {
			return form, nil, apperror.InvalidField("people")
		}
		form.People = *in.People
	}
	for _, f := range []struct {
		dst   *string
		value *string
		name  string
	}{{&form.MaxExpenses, in.MaxExpenses, "maxExpenses"}, {&form.MaxIncome, in.MaxIncome, "maxIncome"}} {
		if f.value != nil {
			amount, err := parseMoney(*f.value, f.name)
			if err != nil {
				return form, nil, err
			}
			*f.dst = moneyText(amount)
		}
	}
	for _, f := range []struct {
		dst   *string
		value *time.Time
	}{{&form.StartsOn, in.StartsOn}, {&form.EndsOn, in.EndsOn}, {&form.Date, in.Date}} {
		if f.value != nil {
			*f.dst = f.value.Format(dateLayout)
		}
	}
	if form.StartsOn != "" && form.EndsOn != "" && form.EndsOn < form.StartsOn {
		return form, nil, apperror.InvalidField("endsOn")
	}
	signature, err := s.resolveSignature(ctx, q, p, in)
	return form, signature, err
}

// cleanSignature decodes a PNG and encodes it again, so no metadata or trailing bytes survive.
func cleanSignature(data []byte) ([]byte, error) {
	if len(data) == 0 || len(data) > MaxSignatureBytes {
		return nil, apperror.New(413, "finance_file_too_large", "A signature is limited to 512 KiB")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > maxSignaturePixels || cfg.Height > maxSignaturePixels {
		return nil, apperror.Invalid("the signature must be a PNG image")
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, apperror.Invalid("the signature must be a PNG image")
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func (s *Service) resolveSignature(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, in RequestFormInput) ([]byte, error) {
	if len(in.Signature) > 0 {
		return cleanSignature(in.Signature)
	}
	if !in.UseSavedSignature {
		return nil, nil
	}
	fileID, err := q.GetWorkingGroupFinanceSignature(ctx, p.PersonID)
	if err != nil {
		if errors.Is(noRows(err), apperror.NotFound) {
			return nil, nil
		}
		return nil, err
	}
	return s.readFile(ctx, &fileID)
}

func (s *Service) readFile(ctx context.Context, id *uuid.UUID) ([]byte, error) {
	_, reader, err := s.openFile(ctx, id)
	if err != nil {
		return nil, err
	}
	defer func() { _ = reader.Close() }()
	return io.ReadAll(io.LimitReader(reader, MaxFinanceFileBytes+1))
}

func (s *Service) storeSignature(ctx context.Context, p authorization.Principal, png []byte, requestID *uuid.UUID) (files.File, error) {
	if s.files == nil {
		return files.File{}, fmt.Errorf("file storage is unavailable")
	}
	return s.files.StoreBytes(ctx, p, "signature.png", "image/png", png, requestID)
}

// PutFinanceSignature saves the caller's signature image for reuse.
func (s *Service) PutFinanceSignature(ctx context.Context, p authorization.Principal, upload FileUpload, requestID *uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	if err := requireFinance(p); err != nil {
		return err
	}
	if !strings.EqualFold(strings.TrimSpace(strings.Split(upload.ContentType, ";")[0]), "image/png") {
		return apperror.Invalid("the signature must be a PNG image")
	}
	data, err := cleanSignature(upload.Data)
	if err != nil {
		return err
	}
	stored, err := s.storeSignature(ctx, p, data, requestID)
	if err != nil {
		return err
	}
	var replaced *uuid.UUID
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		old, err := q.UpsertWorkingGroupFinanceSignature(ctx, workinggroupsdb.UpsertWorkingGroupFinanceSignatureParams{PersonID: p.PersonID, FileID: stored.ID})
		if err != nil {
			return err
		}
		if old != uuid.Nil {
			replaced = &old
		}
		return auditNoResource(ctx, tx, p, "working_group_finance_signature.saved", "working_group_finance_signature", requestID, []string{"signature"})
	})
	if err != nil {
		s.discardFiles(&stored.ID)
		return err
	}
	s.discardFiles(replaced)
	return nil
}

// DeleteFinanceSignature deletes the caller's saved signature.
func (s *Service) DeleteFinanceSignature(ctx context.Context, p authorization.Principal, requestID *uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	if err := requireFinance(p); err != nil {
		return err
	}
	var removed *uuid.UUID
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		id, err := workinggroupsdb.New(tx).DeleteWorkingGroupFinanceSignature(ctx, p.PersonID)
		if err != nil {
			return noRows(err)
		}
		removed = &id
		return auditNoResource(ctx, tx, p, "working_group_finance_signature.deleted", "working_group_finance_signature", requestID, []string{"signature"})
	})
	if err == nil {
		s.discardFiles(removed)
	}
	return err
}

// OpenFinanceSignature opens the caller's own saved signature.
func (s *Service) OpenFinanceSignature(ctx context.Context, p authorization.Principal) (files.File, io.ReadCloser, error) {
	if err := requireRead(p); err != nil {
		return files.File{}, nil, err
	}
	if err := requireFinance(p); err != nil {
		return files.File{}, nil, err
	}
	id, err := workinggroupsdb.New(s.pool).GetWorkingGroupFinanceSignature(ctx, p.PersonID)
	if err != nil {
		return files.File{}, nil, noRows(err)
	}
	return s.openFile(ctx, &id)
}

// PreviewProjectRequest renders the Projektantrag with the defaults and the given fields; nothing is stored or sent.
func (s *Service) PreviewProjectRequest(ctx context.Context, p authorization.Principal, id uuid.UUID, in RequestFormInput) ([]byte, error) {
	if err := requireRead(p); err != nil {
		return nil, err
	}
	if err := s.precheckProject(ctx, p, id, roleFinanceP); err != nil {
		return nil, err
	}
	q := workinggroupsdb.New(s.pool)
	project, err := s.loadProject(ctx, q, p, id)
	if err != nil {
		return nil, err
	}
	form, signature, err := s.buildRequestForm(ctx, q, p, project, in)
	if err != nil {
		return nil, err
	}
	return renderProjektantrag(form, signature)
}

// OpenProjectRequestPDF opens the Projektantrag that was mailed.
func (s *Service) OpenProjectRequestPDF(ctx context.Context, p authorization.Principal, id uuid.UUID) (files.File, io.ReadCloser, error) {
	if err := requireRead(p); err != nil {
		return files.File{}, nil, err
	}
	if err := s.precheckProject(ctx, p, id, roleFinanceP); err != nil {
		return files.File{}, nil, err
	}
	pdfID, err := workinggroupsdb.New(s.pool).GetWorkingGroupProjectRequestPDF(ctx, id)
	if err != nil {
		return files.File{}, nil, noRows(err)
	}
	return s.openFile(ctx, pdfID)
}

// SendProjectToWiRef mails the Projektantrag of a project that needs the wiRef and has not sent it yet.
func (s *Service) SendProjectToWiRef(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	in RequestFormInput,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	if err := s.precheckProject(ctx, p, id, roleFinanceP); err != nil {
		return Project{}, err
	}
	project, err := s.loadProject(ctx, workinggroupsdb.New(s.pool), p, id)
	if err != nil {
		return Project{}, err
	}
	if expected < 1 {
		return Project{}, apperror.Invalid("expectedVersion must be positive")
	}
	if project.Version != expected {
		return Project{}, apperror.StaleWrite
	}
	if !project.WiRefRequestPending {
		return Project{}, apperror.Conflicting("wiref_request_not_pending", "There is no Projektantrag waiting to be sent")
	}
	if err := s.sendRequest(ctx, p, id, requestID, in); err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, id)
}

func deliveryFailed(code string) error {
	return apperror.Conflicting("wiref_delivery_failed", "The Projektantrag could not be sent ("+code+")")
}

// sendRequest renders and mails the Projektantrag with its attachments outside any transaction, then stores the
// sent PDF and the outcome with their audit event in one.
func (s *Service) sendRequest(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
	in RequestFormInput,
) error {
	if s.mailer == nil {
		return deliveryFailed("not_configured")
	}
	if _, busy := s.sending.LoadOrStore(id, struct{}{}); busy {
		return apperror.Conflicting("wiref_delivery_in_progress", "The request is being sent right now")
	}
	defer s.sending.Delete(id)
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deliveryTimeout)
	defer cancel()
	q := workinggroupsdb.New(s.pool)
	project, err := s.loadProject(ctx, q, p, id)
	if err != nil {
		return err
	}
	if !project.WiRefRequestPending {
		return apperror.Conflicting("wiref_request_not_pending", "There is no Projektantrag waiting to be sent")
	}
	var form RequestForm
	var signature []byte
	if project.RequestForm != nil {
		form = *project.RequestForm
		sigID, err := q.GetWorkingGroupProjectSignature(ctx, id)
		if err != nil {
			return err
		}
		if sigID != nil {
			if signature, err = s.readFile(ctx, sigID); err != nil {
				return err
			}
		}
		if signature == nil {
			if signature, err = s.resolveSignature(ctx, q, p, in); err != nil {
				return err
			}
		}
	} else {
		in.UseSavedSignature = in.UseSavedSignature || len(in.Signature) == 0
		if form, signature, err = s.buildRequestForm(ctx, q, p, project, in); err != nil {
			return err
		}
	}
	if signature == nil {
		return apperror.New(422, "signature_required", "The Projektantrag needs a signature: send one or save yours")
	}
	// A signature that is not stored with the project yet is stored with the outcome.
	var newSignature *uuid.UUID
	if project.SignatureMissing || project.RequestForm == nil {
		stored, err := s.storeSignature(ctx, p, signature, requestID)
		if err != nil {
			return err
		}
		newSignature = &stored.ID
	}
	pdf, err := renderProjektantrag(form, signature)
	if err != nil {
		s.discardFiles(newSignature)
		return err
	}
	attachments, listed, err := s.requestAttachments(ctx, q, project, form, pdf)
	if err != nil {
		s.discardFiles(newSignature)
		return err
	}
	paragraphs := []string{
		fmt.Sprintf("Projektantrag of the working group %s: %s.", project.GroupName, project.Title),
		fmt.Sprintf("Planned maximum expenses: %s EUR, planned maximum income: %s EUR.", form.MaxExpenses, form.MaxIncome),
	}
	if len(listed) > 0 {
		paragraphs = append(paragraphs, "Files that are too large to attach and can be asked for: "+strings.Join(listed, ", ")+".")
	}
	outcome := s.mailer.SendMessage(ctx, "Projektantrag: "+project.Title, paragraphs, attachments)
	if outcome.Status != invoicing.DeliverySent {
		s.discardFiles(newSignature)
		return deliveryFailed(string(outcome.Status))
	}
	// The mail has left: its delivery is recorded even when the copy of the PDF cannot be stored. Across a process
	// crash between the send and this record the delivery is at least once.
	var pdfID *uuid.UUID
	if stored, err := s.files.StoreBytes(ctx, p, "Projektantrag.pdf", "application/pdf", pdf, requestID); err != nil {
		slog.ErrorContext(ctx, "store sent projektantrag failed")
	} else {
		pdfID = &stored.ID
	}
	recorded := false
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		tq := workinggroupsdb.New(tx)
		pc, err := lockProject(ctx, tx, p, id)
		if err != nil {
			return err
		}
		if project.RequestForm == nil || newSignature != nil {
			raw, err := json.Marshal(form)
			if err != nil {
				return err
			}
			signer := p.PersonID
			if err := tq.SetWorkingGroupProjectRequest(ctx, workinggroupsdb.SetWorkingGroupProjectRequestParams{
				ID: id, Form: string(raw), SignatureFileID: newSignature, SignedBy: &signer, PaidFrom: pc.core.PaidFrom,
			}); err != nil {
				return err
			}
		}
		changed, err := tq.SetWorkingGroupProjectRequestPDF(ctx, workinggroupsdb.SetWorkingGroupProjectRequestPDFParams{ID: id, PdfFileID: pdfID})
		if err != nil {
			return err
		}
		if changed == 0 {
			return nil
		}
		recorded = true
		if err := addProjectHistory(ctx, tq, p, id, "wiref_request_sent", ""); err != nil {
			return err
		}
		return writeTaskAudit(ctx, tx, p, "working_group_project.request_sent", "working_group_project", id, requestID, []string{"request"})
	})
	if err != nil || !recorded {
		s.discardFiles(pdfID)
	}
	if err != nil {
		s.discardFiles(newSignature)
	}
	return err
}

// sanitizeFileName keeps an attachment name readable but free of quotes, backslashes and control characters, which
// would break the mail headers.
func sanitizeFileName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r == '"':
			b.WriteRune('\'')
		case r == '\\':
			b.WriteRune('-')
		case unicode.IsControl(r):
			b.WriteRune(' ')
		default:
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

// requestAttachments are the generated PDFs and the stored files of a project; what exceeds the size bound is
// returned as names to list in the body.
func (s *Service) requestAttachments(
	ctx context.Context,
	q *workinggroupsdb.Queries,
	project Project,
	form RequestForm,
	projektantrag []byte,
) ([]mailservice.Attachment, []string, error) {
	pdf := func(name string, data []byte) mailservice.Attachment {
		return mailservice.Attachment{Name: name, ContentType: "application/pdf", Data: data}
	}
	out := []mailservice.Attachment{pdf("Projektantrag.pdf", projektantrag)}
	if form.Advance {
		amount := project.Totals.Planned
		if project.AdvanceAmount != nil {
			amount = *project.AdvanceAmount
		}
		data, err := renderAdvanceRequest(project, form, amount)
		if err != nil {
			return nil, nil, err
		}
		out = append(out, pdf("Vorschussantrag.pdf", data))
	}
	costPlan, err := renderCostPlan(project)
	if err != nil {
		return nil, nil, err
	}
	purchases, err := renderPurchases(project)
	if err != nil {
		return nil, nil, err
	}
	out = append(out, pdf("Cost plan.pdf", costPlan), pdf("Purchases.pdf", purchases))
	total := 0
	for _, a := range out {
		total += len(a.Data)
	}
	var listed []string
	add := func(id *uuid.UUID, label string) error {
		if id == nil {
			return nil
		}
		file, reader, err := s.openFile(ctx, id)
		if err != nil {
			return err
		}
		defer func() { _ = reader.Close() }()
		name := sanitizeFileName(label + " - " + file.OriginalFilename)
		if total+int(file.Size) > maxMailAttachmentBytes {
			listed = append(listed, name)
			return nil
		}
		data, err := io.ReadAll(io.LimitReader(reader, MaxFinanceFileBytes+1))
		if err != nil {
			return err
		}
		total += len(data)
		out = append(out, mailservice.Attachment{Name: name, ContentType: file.ContentType, Data: data})
		return nil
	}
	purchaseRows, err := q.ListWorkingGroupProjectPurchases(ctx, &project.ID)
	if err != nil {
		return nil, nil, err
	}
	for _, pu := range purchaseRows {
		if pu.Status != PurchaseDeclined {
			if err := add(pu.AttachmentFileID, "Purchase "+pu.Item); err != nil {
				return nil, nil, err
			}
		}
	}
	offerRows, err := q.ListWorkingGroupProjectOfferFiles(ctx, project.ID)
	if err != nil {
		return nil, nil, err
	}
	needs := map[uuid.UUID]bool{}
	for _, item := range project.Items {
		needs[item.ID] = item.NeedsOffers
	}
	for _, o := range offerRows {
		if needs[o.ItemID] {
			if err := add(o.FileID, "Offer "+o.Shop); err != nil {
				return nil, nil, err
			}
		}
	}
	return out, listed, nil
}

var _ = decimal.Zero

// CheckSignatureUpload is the refusal an upload handler runs before it reads the body.
func (s *Service) CheckSignatureUpload(p authorization.Principal) error {
	if err := requireRead(p); err != nil {
		return err
	}
	return requireFinance(p)
}
