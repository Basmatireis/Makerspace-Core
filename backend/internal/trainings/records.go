package trainings

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	trainingsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/trainings/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const maxNotesRunes = 2000

// canReadRecords: everybody's records with read.all or update (who sets a status must see it), the own ones with
// read.self. readsNotes tells whether the internal notes may be shown.
func canReadRecords(p authorization.Principal, personID uuid.UUID) (allowed, readsNotes bool) {
	if p.Has(authorization.TrainingRecordsReadAll) || p.Has(authorization.TrainingRecordsUpdate) {
		return true, true
	}
	return p.PersonID == personID && p.Has(authorization.TrainingRecordsReadSelf), false
}

// ListPersonRecords returns the person's status for every active training and for inactive trainings they hold a
// record of. Missing records are reported as not trained.
func (s *Service) ListPersonRecords(ctx context.Context, p authorization.Principal, personID uuid.UUID) ([]Record, error) {
	allowed, readsNotes := canReadRecords(p, personID)
	if !allowed {
		return nil, apperror.PermissionDenied
	}
	q := trainingsdb.New(s.pool)
	exists, err := q.PersonExists(ctx, personID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, apperror.NotFound
	}
	rows, err := q.ListPersonTrainingRecords(ctx, personID)
	if err != nil {
		return nil, err
	}
	records := make([]Record, 0, len(rows))
	for _, row := range rows {
		record := Record{
			TrainingID:     row.TrainingID,
			TrainingName:   row.TrainingName,
			TrainingActive: row.TrainingActive,
			Status:         StatusNotTrained,
			CompletedOn:    dateFromPg(row.CompletedOn),
			Version:        row.Version,
		}
		if row.Status != nil {
			record.Status = Status(*row.Status)
		}
		if row.UpdatedAt.Valid {
			updatedAt := row.UpdatedAt.Time
			record.UpdatedAt = &updatedAt
		}
		if readsNotes {
			record.Notes = row.Notes
		}
		records = append(records, record)
	}
	return records, nil
}

// SetRecord sets another person's status for one training. Not trained deletes the record. Inactive trainings take no
// new or changed status, only removal and corrections of date and notes. Each change is audited with the status
// transition in the action name; notes and dates are never copied into the audit.
func (s *Service) SetRecord(
	ctx context.Context,
	p authorization.Principal,
	personID, trainingID uuid.UUID,
	input RecordInput,
	requestID *uuid.UUID,
) (Record, error) {
	if !p.Has(authorization.TrainingRecordsUpdate) {
		return Record{}, apperror.PermissionDenied
	}
	if p.PersonID == personID {
		return Record{}, apperror.New(
			http.StatusForbidden, "training_record_self", "Nobody can change their own training status",
		)
	}
	input, err := validateRecord(input)
	if err != nil {
		return Record{}, err
	}
	var result Record
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := trainingsdb.New(tx)
		if _, err := q.LockPersonForShare(ctx, personID); err != nil {
			return noRows(err)
		}
		training, err := q.GetTrainingForShare(ctx, trainingID)
		if err != nil {
			return noRows(err)
		}
		current, err := q.GetTrainingRecordForUpdate(
			ctx, trainingsdb.GetTrainingRecordForUpdateParams{PersonID: personID, TrainingID: trainingID},
		)
		exists := err == nil
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if !versionMatches(exists, current.Version, input.ExpectedVersion) {
			return apperror.StaleWrite
		}
		previous := StatusNotTrained
		if exists {
			previous = Status(current.Status)
		}
		if !training.Active && input.Status != StatusNotTrained && input.Status != previous {
			return apperror.Conflicting("training_inactive", "The training is inactive and takes no new status")
		}
		var changed []string
		switch {
		case input.Status == StatusNotTrained && !exists:
			// Nothing stored and nothing to store.
		case input.Status == StatusNotTrained:
			if _, err := q.DeleteTrainingRecord(ctx, trainingsdb.DeleteTrainingRecordParams{
				PersonID: personID, TrainingID: trainingID, ExpectedVersion: current.Version,
			}); err != nil {
				return err
			}
			changed = []string{"status", "completedOn", "notes"}
		case !exists:
			if err := q.InsertTrainingRecord(ctx, trainingsdb.InsertTrainingRecordParams{
				PersonID: personID, TrainingID: trainingID, Status: string(input.Status),
				CompletedOn: pgDate(input.CompletedOn), Notes: input.Notes, RecordedByAccountID: accountPointer(p),
			}); err != nil {
				return err
			}
			changed = changedRecordFields(StatusNotTrained, nil, nil, input)
		default:
			changed = changedRecordFields(previous, dateFromPg(current.CompletedOn), current.Notes, input)
			if len(changed) > 0 {
				if _, err := q.UpdateTrainingRecord(ctx, trainingsdb.UpdateTrainingRecordParams{
					Status: string(input.Status), CompletedOn: pgDate(input.CompletedOn), Notes: input.Notes,
					RecordedByAccountID: accountPointer(p), PersonID: personID, TrainingID: trainingID,
					ExpectedVersion: current.Version,
				}); err != nil {
					return err
				}
			}
		}
		if len(changed) > 0 {
			if err := audit.Write(ctx, tx, audit.Event{
				ActorAccountID: accountPointer(p),
				Action:         recordAction(previous, input.Status),
				ResourceType:   "training_record",
				ResourceID:     &personID,
				RequestID:      requestID,
				ChangedFields:  changed,
				Metadata:       map[string]any{"personId": personID.String(), "trainingId": trainingID.String()},
			}); err != nil {
				return err
			}
		}
		result, err = recordOf(ctx, q, personID, trainingID, training)
		return err
	})
	return result, err
}

// versionMatches: a caller who saw no record must send no version, one who saw a record must send its version.
func versionMatches(exists bool, stored int64, expected *int64) bool {
	if !exists {
		return expected == nil
	}
	return expected != nil && *expected == stored
}

func recordAction(previous, next Status) string {
	switch {
	case next == StatusNotTrained:
		return "training_record.removed"
	case previous == next:
		return "training_record.updated"
	case next == StatusTrainer:
		return "training_record.trainer"
	default:
		return "training_record.trained"
	}
}

func validateRecord(input RecordInput) (RecordInput, error) {
	if !input.Status.Valid() {
		return input, apperror.Invalid("status must be not_trained, trained or trainer")
	}
	notes, err := validateText(input.Notes, maxNotesRunes, "notes")
	if err != nil {
		return input, err
	}
	input.Notes = notes
	if input.Status == StatusNotTrained && (input.CompletedOn != nil || input.Notes != nil) {
		return input, apperror.Invalid("not_trained takes no completedOn or notes")
	}
	if input.CompletedOn != nil {
		day := time.Date(input.CompletedOn.Year(), input.CompletedOn.Month(), input.CompletedOn.Day(), 0, 0, 0, 0, time.UTC)
		if day.After(time.Now().UTC().AddDate(0, 0, 1)) {
			return input, apperror.Invalid("completedOn cannot be in the future")
		}
		input.CompletedOn = &day
	}
	if input.ExpectedVersion != nil && *input.ExpectedVersion < 1 {
		return input, apperror.Invalid("expectedVersion must be positive")
	}
	return input, nil
}

func changedRecordFields(previous Status, completedOn *time.Time, notes *string, input RecordInput) []string {
	var changed []string
	if previous != input.Status {
		changed = append(changed, "status")
	}
	if !equalDate(completedOn, input.CompletedOn) {
		changed = append(changed, "completedOn")
	}
	if !equalText(notes, input.Notes) {
		changed = append(changed, "notes")
	}
	return changed
}

func recordOf(
	ctx context.Context,
	q *trainingsdb.Queries,
	personID, trainingID uuid.UUID,
	training trainingsdb.Training,
) (Record, error) {
	record := Record{
		TrainingID: trainingID, TrainingName: training.Name, TrainingActive: training.Active, Status: StatusNotTrained,
	}
	row, err := q.GetTrainingRecordForUpdate(
		ctx, trainingsdb.GetTrainingRecordForUpdateParams{PersonID: personID, TrainingID: trainingID},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return record, nil
	}
	if err != nil {
		return Record{}, err
	}
	record.Status = Status(row.Status)
	record.CompletedOn = dateFromPg(row.CompletedOn)
	record.Notes = row.Notes
	record.Version = &row.Version
	record.UpdatedAt = &row.UpdatedAt
	return record, nil
}

func equalDate(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

func pgDate(value *time.Time) pgtype.Date {
	if value == nil {
		return pgtype.Date{}
	}
	return pgtype.Date{Time: *value, Valid: true}
}

func dateFromPg(value pgtype.Date) *time.Time {
	if !value.Valid {
		return nil
	}
	day := value.Time
	return &day
}

// accountPointer is the acting account; changes are always made by a signed-in person.
func accountPointer(p authorization.Principal) *uuid.UUID {
	account := p.AccountID
	return &account
}
