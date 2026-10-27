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

// SignatureSort names the column a signature list is ordered by.
type SignatureSort string

const (
	SignatureSortPerson      SignatureSort = "person"
	SignatureSortVersion     SignatureSort = "version"
	SignatureSortSignedDate  SignatureSort = "signedDate"
	SignatureSortReference   SignatureSort = "reference"
	SignatureSortConfirmedBy SignatureSort = "confirmedBy"
	SignatureSortConfirmedAt SignatureSort = "confirmedAt"
)

// MaxSignaturePageSize bounds one page of the signature list.
const MaxSignaturePageSize = 100

// Signature is one confirmed physical Lab Rules signature.
type Signature struct {
	ID                        uuid.UUID
	PersonID                  uuid.UUID
	PersonName                string
	VersionID                 uuid.UUID
	HumanRevision             string
	SignedDate                *time.Time
	PhysicalDocumentReference *string
	ConfirmedByName           *string
	ConfirmedAt               time.Time
}

// SignatureFilters selects and orders one page of signatures.
type SignatureFilters struct {
	Search     string
	VersionID  *uuid.UUID
	PersonID   *uuid.UUID
	Sort       SignatureSort
	Descending bool
	Page       int
	PageSize   int
}

// ListSignatures returns one page of completed requests and the total number of matches.
func (s *Service) ListSignatures(
	ctx context.Context,
	principal authorization.Principal,
	filters SignatureFilters,
) ([]Signature, int64, error) {
	if !principal.Has(authorization.LaborordnungRequestsRead) {
		return nil, 0, apperror.PermissionDenied
	}
	if filters.Page < 1 || filters.PageSize < 1 || filters.PageSize > MaxSignaturePageSize ||
		filters.Page > 21474836 {
		return nil, 0, apperror.Invalid("page must be positive and pageSize must be between 1 and 100")
	}
	switch filters.Sort {
	case SignatureSortPerson, SignatureSortVersion, SignatureSortSignedDate, SignatureSortReference,
		SignatureSortConfirmedBy, SignatureSortConfirmedAt:
	default:
		return nil, 0, apperror.Invalid("unknown sort column")
	}
	search := strings.TrimSpace(filters.Search)
	queries := laborordnungdb.New(s.pool)
	rows, err := queries.ListSignatures(ctx, laborordnungdb.ListSignaturesParams{
		PersonID:   filters.PersonID,
		VersionID:  filters.VersionID,
		Search:     search,
		Sort:       string(filters.Sort),
		Descending: filters.Descending,
		PageOffset: int32((filters.Page - 1) * filters.PageSize),
		PageLimit:  int32(filters.PageSize),
	})
	if err != nil {
		return nil, 0, err
	}
	total, err := queries.CountSignatures(ctx, laborordnungdb.CountSignaturesParams{
		PersonID:  filters.PersonID,
		VersionID: filters.VersionID,
		Search:    search,
	})
	if err != nil {
		return nil, 0, err
	}
	items := make([]Signature, 0, len(rows))
	for _, row := range rows {
		item := Signature{
			ID:                        row.ID,
			PersonID:                  row.PersonID,
			PersonName:                row.PersonName,
			VersionID:                 row.VersionID,
			HumanRevision:             row.HumanRevision,
			PhysicalDocumentReference: row.PhysicalDocumentReference,
			ConfirmedAt:               row.CompletedAt.Time,
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
