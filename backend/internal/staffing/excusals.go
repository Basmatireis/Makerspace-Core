package staffing

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	staffingdb "github.com/Basmatireis/Makerspace-Core/backend/internal/staffing/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// SetExcusal excuses a person from the minimum of one period, replacing an earlier excusal's reason. The audit event
// never carries the reason.
func (s *Service) SetExcusal(
	ctx context.Context,
	principal authorization.Principal,
	periodID, personID uuid.UUID,
	reason string,
	requestID *uuid.UUID,
) (Excusal, error) {
	if !principal.Has(authorization.OpenDaysManage) {
		return Excusal{}, apperror.PermissionDenied
	}
	reason = strings.TrimSpace(reason)
	if utf8.RuneCountInString(reason) > MaxExcusalReason {
		return Excusal{}, apperror.InvalidField("reason must be at most 500 characters")
	}
	var result Excusal
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		queries := staffingdb.New(tx)
		// People are locked before periods, the order a person deletion takes.
		if _, err := queries.GetPersonForShare(ctx, personID); errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		} else if err != nil {
			return err
		}
		if _, err := queries.GetPeriodForShare(ctx, periodID); errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		} else if err != nil {
			return err
		}
		actor := principal.AccountID
		row, err := queries.UpsertExcusal(ctx, staffingdb.UpsertExcusalParams{
			PeriodID: periodID, PersonID: personID, Reason: reason, CreatedByAccountID: &actor,
		})
		if err != nil {
			return err
		}
		result = Excusal{PeriodID: row.PeriodID, PersonID: row.PersonID, Reason: row.Reason, CreatedAt: row.CreatedAt}
		return audit.Write(ctx, tx, audit.Event{
			ActorAccountID: &actor,
			Action:         "staffing_excusal.saved",
			ResourceType:   "person",
			ResourceID:     &personID,
			RequestID:      requestID,
			Metadata:       map[string]any{"periodId": periodID.String()},
		})
	})
	return result, err
}

// RemoveExcusal withdraws a person's excusal for one period.
func (s *Service) RemoveExcusal(
	ctx context.Context,
	principal authorization.Principal,
	periodID, personID uuid.UUID,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.OpenDaysManage) {
		return apperror.PermissionDenied
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		removed, err := staffingdb.New(tx).DeleteExcusal(ctx, staffingdb.DeleteExcusalParams{
			PeriodID: periodID, PersonID: personID,
		})
		if err != nil {
			return err
		}
		if removed == 0 {
			return apperror.NotFound
		}
		actor := principal.AccountID
		return audit.Write(ctx, tx, audit.Event{
			ActorAccountID: &actor,
			Action:         "staffing_excusal.removed",
			ResourceType:   "person",
			ResourceID:     &personID,
			RequestID:      requestID,
			Metadata:       map[string]any{"periodId": periodID.String()},
		})
	})
}
