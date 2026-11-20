package workinggroups

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

const (
	MaxProjectNumberRunes = 40
	MaxProjectLabelRunes  = 120
	// MaxFinanceFileBytes is the largest offer, cart, receipt or invoice.
	MaxFinanceFileBytes = 10 << 20
	maxMoney            = 1_000_000_000
)

var financeFileTypes = map[string]bool{
	"application/pdf": true, "image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true,
}

// WithFiles gives the service the file store it keeps offers, receipts and invoices in.
func (s *Service) WithFiles(service *files.Service) *Service {
	s.files = service
	return s
}

func isFinance(p authorization.Principal) bool {
	return p.Has(authorization.WorkingGroupFinancesManage)
}

func requireFinance(p authorization.Principal) error {
	if !isFinance(p) {
		return apperror.PermissionDenied
	}
	return nil
}

// parseMoney reads a non-negative euro amount with at most two places.
func parseMoney(value, field string) (decimal.Decimal, error) {
	clean := strings.TrimSpace(value)
	if clean == "" || strings.ContainsAny(clean, "eE+-") {
		return decimal.Zero, apperror.InvalidField(field)
	}
	amount, err := decimal.NewFromString(clean)
	if err != nil || amount.Exponent() < -2 || amount.GreaterThan(decimal.NewFromInt(maxMoney)) {
		return decimal.Zero, apperror.InvalidField(field)
	}
	return amount, nil
}

// dbMoney reads an amount the database produced.
func dbMoney(value string) decimal.Decimal {
	amount, err := decimal.NewFromString(value)
	if err != nil {
		return decimal.Zero
	}
	return amount
}

func moneyText(amount decimal.Decimal) string { return amount.StringFixed(2) }

// day is the date of a moment at midnight UTC, the way dates are carried in this package.
func day(value time.Time) time.Time {
	return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC)
}

func (s *Service) today() time.Time { return day(time.Now().In(s.location)) }

func auditNoResource(ctx context.Context, tx pgx.Tx, p authorization.Principal, action, resourceType string, requestID *uuid.UUID, fields []string) error {
	account := p.AccountID
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &account, Action: action, ResourceType: resourceType, RequestID: requestID, ChangedFields: fields,
	})
}

// canSeeFinances says whether the caller is a finance manager or a member of at least one group.
func canSeeFinances(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal) (bool, error) {
	if isFinance(p) {
		return true, nil
	}
	return q.IsMemberOfAnyWorkingGroup(ctx, p.PersonID)
}

// GetRules returns the finance rules. Only members of a group and finance managers see them (404 otherwise).
func (s *Service) GetRules(ctx context.Context, p authorization.Principal) (FinanceRules, error) {
	if err := requireRead(p); err != nil {
		return FinanceRules{}, err
	}
	q := workinggroupsdb.New(s.pool)
	visible, err := canSeeFinances(ctx, q, p)
	if err != nil {
		return FinanceRules{}, err
	}
	if !visible {
		return FinanceRules{}, apperror.NotFound
	}
	return loadRules(ctx, q)
}

func loadRules(ctx context.Context, q *workinggroupsdb.Queries) (FinanceRules, error) {
	row, err := q.GetWorkingGroupFinanceRules(ctx)
	if err != nil {
		return FinanceRules{}, err
	}
	requests, err := q.ListWorkingGroupProjectRequests(ctx)
	if err != nil {
		return FinanceRules{}, err
	}
	defaults, err := loadRequestDefaults(ctx, q)
	if err != nil {
		return FinanceRules{}, err
	}
	rules := FinanceRules{
		ProjectThreshold: moneyText(dbMoney(row.ProjectThreshold)), OffersThreshold: moneyText(dbMoney(row.OffersThreshold)),
		Request: defaults, Version: row.Version, ProjectRequests: make([]ProjectRequest, 0, len(requests)),
	}
	for _, r := range requests {
		rules.ProjectRequests = append(rules.ProjectRequests, ProjectRequest{ID: r.ID, Number: r.Number, Label: r.Label})
	}
	return rules, nil
}

// SetRules changes the thresholds under optimistic locking.
func (s *Service) SetRules(
	ctx context.Context,
	p authorization.Principal,
	input FinanceRulesInput,
	requestID *uuid.UUID,
) (result FinanceRules, err error) {
	if err := requireRead(p); err != nil {
		return FinanceRules{}, err
	}
	if err := requireFinance(p); err != nil {
		return FinanceRules{}, err
	}
	project, err := parseMoney(input.ProjectThreshold, "projectThreshold")
	if err != nil {
		return FinanceRules{}, err
	}
	offers, err := parseMoney(input.OffersThreshold, "offersThreshold")
	if err != nil {
		return FinanceRules{}, err
	}
	if input.ExpectedVersion < 1 {
		return FinanceRules{}, apperror.Invalid("expectedVersion must be positive")
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		version, err := q.LockWorkingGroupFinanceRules(ctx)
		if err != nil {
			return err
		}
		if version != input.ExpectedVersion {
			return apperror.StaleWrite
		}
		if _, err := q.UpdateWorkingGroupFinanceRules(ctx, workinggroupsdb.UpdateWorkingGroupFinanceRulesParams{
			ProjectThreshold: moneyText(project), OffersThreshold: moneyText(offers),
		}); err != nil {
			return err
		}
		fields := []string{"projectThreshold", "offersThreshold"}
		if input.Request != nil {
			defaults, err := validateDefaultsInput(ctx, q, *input.Request)
			if err != nil {
				return err
			}
			if err := q.UpdateWorkingGroupRequestDefaults(ctx, workinggroupsdb.UpdateWorkingGroupRequestDefaultsParams{
				UnitKind: defaults.UnitKind, UnitName: defaults.UnitName, AddGroupName: defaults.AddGroupName,
				ResponsiblePersonID: defaults.ResponsiblePersonID, Place: defaults.Place,
			}); err != nil {
				return err
			}
			fields = append(fields, "requestDefaults")
		}
		if err := auditNoResource(ctx, tx, p, "working_group_finance_rules.updated", "working_group_finance_rules", requestID, fields); err != nil {
			return err
		}
		result, err = loadRules(ctx, q)
		return err
	})
	return result, err
}

func validateProjectRequest(number, label string) (string, string, error) {
	number, label = strings.TrimSpace(number), strings.TrimSpace(label)
	if number == "" || utf8.RuneCountInString(number) > MaxProjectNumberRunes {
		return "", "", apperror.InvalidField("number")
	}
	if label == "" || utf8.RuneCountInString(label) > MaxProjectLabelRunes {
		return "", "", apperror.InvalidField("label")
	}
	return number, label, nil
}

func projectRequestExists(err error) error {
	return uniqueConflict(err, "working_group_project_request_exists", "A project request with this number already exists")
}

// CreateProjectRequest adds a standing project request.
func (s *Service) CreateProjectRequest(
	ctx context.Context,
	p authorization.Principal,
	number, label string,
	requestID *uuid.UUID,
) (result ProjectRequest, err error) {
	if err := requireRead(p); err != nil {
		return ProjectRequest{}, err
	}
	if err := requireFinance(p); err != nil {
		return ProjectRequest{}, err
	}
	number, label, err = validateProjectRequest(number, label)
	if err != nil {
		return ProjectRequest{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		id := ids.New()
		if err := q.CreateWorkingGroupProjectRequest(ctx, workinggroupsdb.CreateWorkingGroupProjectRequestParams{
			ID: id, Number: number, Label: label,
		}); err != nil {
			return projectRequestExists(err)
		}
		result = ProjectRequest{ID: id, Number: number, Label: label}
		return writeTaskAudit(ctx, tx, p, "working_group_project_request.created", "working_group_project_request", id, requestID,
			[]string{"number", "label"})
	})
	return result, err
}

// UpdateProjectRequest changes number and label of a standing project request.
func (s *Service) UpdateProjectRequest(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	number, label string,
	requestID *uuid.UUID,
) (result ProjectRequest, err error) {
	if err := requireRead(p); err != nil {
		return ProjectRequest{}, err
	}
	if err := requireFinance(p); err != nil {
		return ProjectRequest{}, err
	}
	number, label, err = validateProjectRequest(number, label)
	if err != nil {
		return ProjectRequest{}, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		changed, err := q.UpdateWorkingGroupProjectRequest(ctx, workinggroupsdb.UpdateWorkingGroupProjectRequestParams{
			ID: id, Number: number, Label: label,
		})
		if err != nil {
			return projectRequestExists(err)
		}
		if changed == 0 {
			return apperror.NotFound
		}
		result = ProjectRequest{ID: id, Number: number, Label: label}
		return writeTaskAudit(ctx, tx, p, "working_group_project_request.updated", "working_group_project_request", id, requestID,
			[]string{"number", "label"})
	})
	return result, err
}

// DeleteProjectRequest removes a standing project request; orders keep the number they used.
func (s *Service) DeleteProjectRequest(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	if err := requireFinance(p); err != nil {
		return err
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		removed, err := workinggroupsdb.New(tx).DeleteWorkingGroupProjectRequest(ctx, id)
		if err != nil {
			return err
		}
		if removed == 0 {
			return apperror.NotFound
		}
		return writeTaskAudit(ctx, tx, p, "working_group_project_request.deleted", "working_group_project_request", id, requestID, nil)
	})
}

// validateFinanceFile checks an uploaded offer, cart, receipt or invoice: PDF or image, small, and really what it
// says it is.
func validateFinanceFile(upload FileUpload) (string, error) {
	if len(upload.Data) > MaxFinanceFileBytes {
		return "", apperror.New(http.StatusRequestEntityTooLarge, "finance_file_too_large", "Files are limited to 10 MiB")
	}
	declared := strings.ToLower(strings.TrimSpace(strings.Split(upload.ContentType, ";")[0]))
	if !financeFileTypes[declared] {
		return "", apperror.Invalid("file type is not allowed: use a PDF or an image")
	}
	if len(upload.Data) == 0 || strings.TrimSpace(upload.Filename) == "" {
		return "", apperror.Invalid("the file is empty")
	}
	prefix := upload.Data
	if len(prefix) > 512 {
		prefix = prefix[:512]
	}
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(prefix), ";")[0]))
	if detected != declared {
		return "", apperror.Invalid("file content does not match its type")
	}
	return declared, nil
}

// storeFile validates and stores an upload; the caller deletes the file again with discardFile when the change that
// should refer to it does not commit.
func (s *Service) storeFile(ctx context.Context, p authorization.Principal, upload FileUpload, requestID *uuid.UUID) (files.File, error) {
	if s.files == nil {
		return files.File{}, errors.New("file storage is unavailable")
	}
	declared, err := validateFinanceFile(upload)
	if err != nil {
		return files.File{}, err
	}
	return s.files.StoreBytes(ctx, p, strings.TrimSpace(upload.Filename), declared, upload.Data, requestID)
}

// discardFiles deletes stored files that nothing refers to any more. Failures are not reported: the change they
// belong to already happened.
func (s *Service) discardFiles(fileIDs ...*uuid.UUID) {
	if s.files == nil {
		return
	}
	for _, id := range fileIDs {
		if id != nil {
			_ = s.files.DeleteSystem(context.Background(), *id, nil)
		}
	}
}

func (s *Service) openFile(ctx context.Context, id *uuid.UUID) (files.File, io.ReadCloser, error) {
	if id == nil {
		return files.File{}, nil, apperror.NotFound
	}
	if s.files == nil {
		return files.File{}, nil, errors.New("file storage is unavailable")
	}
	return s.files.Open(ctx, *id)
}
