package privacy

import (
	"context"
	"fmt"
	"io"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DataSubject identifies the person a data-subject request concerns, with the
// account that belongs to them when they have one.
type DataSubject struct {
	PersonID  uuid.UUID
	AccountID *uuid.UUID
}

// EraseOutcome says what erasure does with a category's records of a subject.
type EraseOutcome string

const (
	// OutcomeErased: the records are deleted (directly or with the person row).
	OutcomeErased EraseOutcome = "erased"
	// OutcomeUnlinked: the records stay without their link to the person.
	OutcomeUnlinked EraseOutcome = "unlinked"
	// OutcomeRetainedLegal: the records are kept for a legal obligation, with the person link removed.
	OutcomeRetainedLegal EraseOutcome = "retained_legal"
	// OutcomeManualReview: the handler cannot decide; an operator must act.
	OutcomeManualReview EraseOutcome = "manual_review"
)

// ExportFile is a binary that belongs to a subject's export, such as the profile image.
type ExportFile struct {
	Name        string
	ContentType string
	Open        func(ctx context.Context) (io.ReadCloser, error)
}

// ExportSection is one category's contribution to an access export: a
// JSON-serialisable value (already encoded), the number of records it holds
// and any binary files.
type ExportSection struct {
	Records int64
	JSON    []byte
	Files   []ExportFile
}

// EraseResult reports what erasure did or would do with a category.
type EraseResult struct {
	Outcome EraseOutcome
	Records int64
	Note    string
}

// SubjectHandler answers data-subject requests for one category. Export runs
// inside a read transaction; Erase runs inside the erasure transaction before
// the person row is deleted, so a handler that relies on the database cascade
// only counts and reports its outcome. A dry run (assessment) calls Erase in a
// transaction that is rolled back, so Erase must not have effects outside it.
type SubjectHandler interface {
	Export(ctx context.Context, tx pgx.Tx, subject DataSubject) (ExportSection, error)
	Erase(ctx context.Context, tx pgx.Tx, subject DataSubject) (EraseResult, error)
}

// RegisterSubjectHandler attaches a handler for a declared category.
func (s *Service) RegisterSubjectHandler(category CategoryID, handler SubjectHandler) {
	if _, declared := s.catalog.Lookup(category); !declared {
		panic(fmt.Sprintf("privacy: subject handler for undeclared category %q", category))
	}
	if _, duplicate := s.subjects[category]; duplicate {
		panic(fmt.Sprintf("privacy: subject handler for %q registered twice", category))
	}
	s.subjects[category] = handler
}

// SubjectHandler returns the handler of a category, if any.
func (s *Service) SubjectHandler(category CategoryID) (SubjectHandler, bool) {
	handler, ok := s.subjects[category]
	return handler, ok
}
