package laborordnung

import (
	"context"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	laborordnungdb "github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// ConfirmationSort names the column a confirmation list is ordered by.
type ConfirmationSort string

const (
	ConfirmationSortPerson      ConfirmationSort = "person"
	ConfirmationSortVersion     ConfirmationSort = "version"
	ConfirmationSortMethod      ConfirmationSort = "method"
	ConfirmationSortConfirmedAt ConfirmationSort = "confirmedAt"
)

// MaxConfirmationPageSize bounds one page of the confirmation list.
const MaxConfirmationPageSize = 100

// Confirmation is one person's confirmation of one Lab Rules version. SignedDate, PhysicalDocumentReference and
// ConfirmedByName belong to paper confirmations only.
type Confirmation struct {
	ID                        uuid.UUID
	PersonID                  uuid.UUID
	PersonName                string
	VersionID                 uuid.UUID
	HumanRevision             string
	Method                    ConfirmationMethod
	ConfirmedAt               time.Time
	SignedDate                *time.Time
	PhysicalDocumentReference *string
	ConfirmedByName           *string
}

// ConfirmationFilters selects and orders one page of confirmations.
type ConfirmationFilters struct {
	Search     string
	VersionID  *uuid.UUID
	PersonID   *uuid.UUID
	Method     *ConfirmationMethod
	Sort       ConfirmationSort
	Descending bool
	Page       int
	PageSize   int
}

// ListConfirmations returns one page of confirmations and the total number of matches. Without people.read.all the
// list is limited to the caller's own confirmations, so people.read.self never reveals anyone else.
func (s *Service) ListConfirmations(
	ctx context.Context,
	principal authorization.Principal,
	filters ConfirmationFilters,
) ([]Confirmation, int64, error) {
	if !principal.Has(authorization.LaborordnungConfirmationsRead) {
		return nil, 0, apperror.PermissionDenied
	}
	if !principal.Has(authorization.PeopleReadAll) {
		if !principal.CanReadPerson(principal.PersonID) ||
			(filters.PersonID != nil && *filters.PersonID != principal.PersonID) {
			return nil, 0, apperror.PermissionDenied
		}
		own := principal.PersonID
		filters.PersonID = &own
	}
	if filters.Page < 1 || filters.PageSize < 1 || filters.PageSize > MaxConfirmationPageSize ||
		filters.Page > 21474836 {
		return nil, 0, apperror.Invalid("page must be positive and pageSize must be between 1 and 100")
	}
	switch filters.Sort {
	case ConfirmationSortPerson, ConfirmationSortVersion, ConfirmationSortMethod, ConfirmationSortConfirmedAt:
	default:
		return nil, 0, apperror.Invalid("unknown sort column")
	}
	var method *string
	if filters.Method != nil {
		if !filters.Method.Valid() {
			return nil, 0, apperror.Invalid("unknown confirmation method")
		}
		value := string(*filters.Method)
		method = &value
	}
	search := strings.TrimSpace(filters.Search)
	queries := laborordnungdb.New(s.pool)
	rows, err := queries.ListConfirmations(ctx, laborordnungdb.ListConfirmationsParams{
		PersonID:   filters.PersonID,
		VersionID:  filters.VersionID,
		Method:     method,
		Search:     search,
		Sort:       string(filters.Sort),
		Descending: filters.Descending,
		PageOffset: int32((filters.Page - 1) * filters.PageSize),
		PageLimit:  int32(filters.PageSize),
	})
	if err != nil {
		return nil, 0, err
	}
	total, err := queries.CountConfirmations(ctx, laborordnungdb.CountConfirmationsParams{
		PersonID:  filters.PersonID,
		VersionID: filters.VersionID,
		Method:    method,
		Search:    search,
	})
	if err != nil {
		return nil, 0, err
	}
	items := make([]Confirmation, 0, len(rows))
	for _, row := range rows {
		item := Confirmation{
			ID:                        row.ID,
			PersonID:                  row.PersonID,
			PersonName:                row.PersonName,
			VersionID:                 row.VersionID,
			HumanRevision:             row.HumanRevision,
			Method:                    ConfirmationMethod(row.Method),
			ConfirmedAt:               row.ConfirmedAt,
			PhysicalDocumentReference: row.PhysicalDocumentReference,
		}
		if row.SignedDate.Valid {
			item.SignedDate = &row.SignedDate.Time
		}
		if row.ConfirmedByName != "" {
			name := row.ConfirmedByName
			item.ConfirmedByName = &name
		}
		items = append(items, item)
	}
	return items, total, nil
}
