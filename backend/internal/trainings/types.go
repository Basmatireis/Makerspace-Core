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
