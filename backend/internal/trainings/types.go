package trainings

import (
	"time"

	"github.com/google/uuid"
)

// CompetencyCategory is a publicly shown area of support, such as "3D printing". Its name is the public label.
type CompetencyCategory struct {
	ID            uuid.UUID
	Name          string
	Description   *string
	Active        bool
	SortOrder     int32
	TrainingCount int64
	Version       int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// CompetencyCategoryInput is the editable part of a competency category.
type CompetencyCategoryInput struct {
	Name        string
	Description *string
	Active      bool
	SortOrder   int32
}

// Training is an internal training type. It feeds competency categories and may name the machine types it covers.
type Training struct {
	ID             uuid.UUID
	Name           string
	Description    *string
	Active         bool
	SortOrder      int32
	CompetencyIDs  []uuid.UUID
	MachineTypeIDs []uuid.UUID
	RecordCount    int64
	Version        int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// TrainingInput is the editable part of a training; the link lists replace the stored ones.
type TrainingInput struct {
	Name           string
	Description    *string
	Active         bool
	SortOrder      int32
	CompetencyIDs  []uuid.UUID
	MachineTypeIDs []uuid.UUID
}

// Status is a person's state for one training. NotTrained is never stored: it is the absence of a record.
type Status string

const (
	StatusNotTrained Status = "not_trained"
	StatusTrained    Status = "trained"
	StatusTrainer    Status = "trainer"
)

func (s Status) Valid() bool {
	return s == StatusNotTrained || s == StatusTrained || s == StatusTrainer
}

// Record is a person's status for one training. Version is nil while no record exists. Notes are internal and only
// filled for readers of all records.
type Record struct {
	TrainingID     uuid.UUID
	TrainingName   string
	TrainingActive bool
	Status         Status
	CompletedOn    *time.Time
	Notes          *string
	Version        *int64
	UpdatedAt      *time.Time
}

// RecordInput sets a person's status for one training. ExpectedVersion is the stored record's version, nil when the
// caller saw no record.
type RecordInput struct {
	Status          Status
	CompletedOn     *time.Time
	Notes           *string
	ExpectedVersion *int64
}
