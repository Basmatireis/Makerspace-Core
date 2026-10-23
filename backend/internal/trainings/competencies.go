package trainings

import (
	"context"

	trainingsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/trainings/db"
	"github.com/google/uuid"
)

// Competency is what may be shown publicly about an open day: a category ID and its label, nothing about people.
type Competency struct {
	ID    uuid.UUID
	Label string
}

// OpenDayCompetencies derives the planned competencies of open days from the supervisors assigned to them and their
// training records. It is the only place this rule lives; internal views, the public calendar, ICS and signage all
// read through it. Cancelled days and days without qualified supervisors get an empty list. The caller authorizes.
func OpenDayCompetencies(
	ctx context.Context,
	db trainingsdb.DBTX,
	openDayIDs []uuid.UUID,
) (map[uuid.UUID][]Competency, error) {
	result := make(map[uuid.UUID][]Competency, len(openDayIDs))
	if len(openDayIDs) == 0 {
		return result, nil
	}
	textIDs := make([]string, 0, len(openDayIDs))
	for _, id := range openDayIDs {
		textIDs = append(textIDs, id.String())
	}
	rows, err := trainingsdb.New(db).ListOpenDayCompetencies(ctx, textIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		result[row.OpenDayID] = append(result[row.OpenDayID], Competency{ID: row.ID, Label: row.Name})
	}
	return result, nil
}
