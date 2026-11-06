package staffing

import (
	"context"
	"time"

	staffingdb "github.com/Basmatireis/Makerspace-Core/backend/internal/staffing/db"
	"github.com/google/uuid"
)

// Reader answers the staffing questions that need no permission check on any connection or transaction, so other
// features (the notification rules) count open days and resolve minimums exactly like the staffing pages do.
type Reader struct {
	db       staffingdb.DBTX
	location *time.Location
}

// NewReader returns a reader on the connection or transaction.
func NewReader(db staffingdb.DBTX, location *time.Location) Reader {
	if location == nil {
		location = time.UTC
	}
	return Reader{db: db, location: location}
}

// Rules loads the staffing rules.
func (r Reader) Rules(ctx context.Context) (Rules, error) {
	return loadRules(ctx, staffingdb.New(r.db))
}

// CurrentSemester resolves the semester for the instant, or nil when no period can serve as one.
func (r Reader) CurrentSemester(ctx context.Context, rules Rules, now time.Time) (*Semester, error) {
	rows, err := staffingdb.New(r.db).ListSemesterCandidates(ctx)
	if err != nil {
		return nil, err
	}
	candidates := make([]Semester, 0, len(rows))
	for _, row := range rows {
		candidates = append(candidates, semesterOf(rules, row.ID, row.Name, row.Status, row.StartsOn, row.EndsOn,
			row.SignUpDeadline))
	}
	return ResolveSemester(candidates, DateOf(now, r.location)), nil
}

// Counts returns the open-day counts of the semester per person; onlyPerson narrows it to one person. People without
// any assignment are absent. A nil semester yields no counts.
func (r Reader) Counts(
	ctx context.Context,
	rules Rules,
	semester *Semester,
	now time.Time,
	onlyPerson *uuid.UUID,
) (map[uuid.UUID]Counts, error) {
	result := map[uuid.UUID]Counts{}
	if semester == nil {
		return result, nil
	}
	rows, err := staffingdb.New(r.db).ListStaffingCounts(ctx, staffingdb.ListStaffingCountsParams{
		PeriodID: &semester.ID, Now: now, CountBy: string(rules.CountBy), OnlyPersonID: onlyPerson,
	})
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		result[row.PersonID] = Counts{
			Staffed: int(row.Staffed), Booked: int(row.Booked), StaffedAsTrainee: int(row.StaffedAsTrainee),
		}
	}
	return result, nil
}

// Minimums loads the exceptions and the excusals of the semester so each person's minimum can be resolved.
func (r Reader) Minimums(
	ctx context.Context,
	rules Rules,
	semester *Semester,
	onlyPerson *uuid.UUID,
) (Minimums, error) {
	queries := staffingdb.New(r.db)
	rows, err := queries.ListPersonExceptions(ctx, onlyPerson)
	if err != nil {
		return Minimums{}, err
	}
	result := Minimums{rules: rules, exceptions: map[uuid.UUID][]Exception{}, excusals: map[uuid.UUID]Excusal{}}
	for _, row := range rows {
		result.exceptions[row.PersonID] = append(result.exceptions[row.PersonID], Exception{
			RoleID: row.RoleID, RoleName: row.RoleName, Minimum: int(row.Minimum),
		})
	}
	if semester == nil {
		return result, nil
	}
	excusals, err := queries.ListExcusals(ctx, staffingdb.ListExcusalsParams{
		PeriodID: semester.ID, OnlyPersonID: onlyPerson,
	})
	if err != nil {
		return Minimums{}, err
	}
	for _, row := range excusals {
		result.excusals[row.PersonID] = Excusal{
			PeriodID: row.PeriodID, PersonID: row.PersonID, Reason: row.Reason, CreatedAt: row.CreatedAt,
		}
	}
	return result, nil
}
