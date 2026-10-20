package printerconnectors

import (
	"context"
	"errors"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Create(
	ctx context.Context,
	principal authorization.Principal,
	name string,
	location *string,
	requestID *uuid.UUID,
) (Connector, error) {
	if !principal.Has(authorization.PrinterConnectorsManage) {
		return Connector{}, apperror.PermissionDenied
	}
	name, err := normalizeName(name)
	if err != nil {
		return Connector{}, err
	}
	location, err = normalizeLocation(location)
	if err != nil {
		return Connector{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id := ids.New()
	row, err := db.New(tx).CreateConnector(ctx, db.CreateConnectorParams{ID: id, Name: name, LocationLabel: location})
	if err != nil {
		return Connector{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "printer_connector.created",
			ResourceType:   "printer_connector",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"name", "locationLabel"},
		},
	); err != nil {
		return Connector{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return connectorFrom(row), nil
}

func (s *Service) List(ctx context.Context, principal authorization.Principal) ([]Connector, error) {
	if !principal.Has(authorization.PrinterConnectorsRead) {
		return nil, apperror.PermissionDenied
	}
	rows, err := db.New(s.pool).ListConnectors(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Connector, 0, len(rows))
	q := db.New(s.pool)
	for _, row := range rows {
		connector, err := connectorWithClearedBy(ctx, q, row)
		if err != nil {
			return nil, err
		}
		result = append(result, connector)
	}
	return result, nil
}

// connectorWithClearedBy converts a row and names the person who cleared the
// connector's events. The name is only shown on the connector's own reads.
func connectorWithClearedBy(ctx context.Context, q *db.Queries, row db.PrinterConnector) (Connector, error) {
	connector := connectorFrom(row)
	if row.EventsClearedBy == nil {
		return connector, nil
	}
	name, err := q.GetAccountDisplayName(ctx, *row.EventsClearedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return connector, nil
	}
	if err != nil {
		return Connector{}, err
	}
	connector.EventsClearedByName = &name
	return connector, nil
}

func (s *Service) Get(ctx context.Context, principal authorization.Principal, id uuid.UUID) (Connector, error) {
	if !principal.Has(authorization.PrinterConnectorsRead) {
		return Connector{}, apperror.PermissionDenied
	}
	q := db.New(s.pool)
	row, err := q.GetConnector(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.NotFound
	}
	if err != nil {
		return Connector{}, err
	}
	return connectorWithClearedBy(ctx, q, row)
}

// ClearEvents hides the events received so far from the event lists. Events are
// never deleted; includeCleared brings them back.
func (s *Service) ClearEvents(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (Connector, error) {
	if !principal.Has(authorization.PrinterConnectorsManage) {
		return Connector{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if _, err = q.GetConnectorForUpdate(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.NotFound
	} else if err != nil {
		return Connector{}, err
	}
	actor := principal.AccountID
	row, err := q.ClearConnectorEvents(
		ctx,
		db.ClearConnectorEventsParams{ID: id, ClearedBy: &actor},
	)
	if err != nil {
		return Connector{}, databaseError(err)
	}
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "printer_connector.events_cleared",
			ResourceType:   "printer_connector",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"eventsClearedAt"},
		},
	); err != nil {
		return Connector{}, err
	}
	connector, err := connectorWithClearedBy(ctx, q, row)
	if err != nil {
		return Connector{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return connector, nil
}

func (s *Service) Update(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	name string,
	location *string,
	enabled bool,
	expected int64,
	requestID *uuid.UUID,
) (Connector, error) {
	if !principal.Has(authorization.PrinterConnectorsManage) {
		return Connector{}, apperror.PermissionDenied
	}
	name, err := normalizeName(name)
	if err != nil {
		return Connector{}, err
	}
	location, err = normalizeLocation(location)
	if err != nil {
		return Connector{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Connector{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	current, err := q.GetConnectorForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.NotFound
	}
	if err != nil {
		return Connector{}, err
	}
	if Lifecycle(current.Lifecycle) == LifecycleRevoked {
		return Connector{}, apperror.Conflicting("printer_connector_revoked", "A revoked connector cannot be updated")
	}
	lifecycle := Lifecycle(current.Lifecycle)
	var disabledAt *time.Time
	if lifecycle == LifecyclePending {
		if !enabled {
			return Connector{}, apperror.Invalid("A pending connector cannot be disabled before enrollment")
		}
	} else if enabled {
		lifecycle = LifecycleActive
	} else {
		lifecycle = LifecycleDisabled
		now := time.Now().UTC()
		disabledAt = &now
	}
	row, err := q.UpdateConnector(
		ctx,
		db.UpdateConnectorParams{
			Name:            name,
			LocationLabel:   location,
			Lifecycle:       string(lifecycle),
			DisabledAt:      timestamptz(disabledAt),
			ID:              id,
			ExpectedVersion: expected,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Connector{}, apperror.StaleWrite
	}
	if err != nil {
		return Connector{}, databaseError(err)
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "printer_connector.updated",
			ResourceType:   "printer_connector",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"name", "locationLabel", "lifecycle"},
		},
	); err != nil {
		return Connector{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Connector{}, err
	}
	return connectorFrom(row), nil
}

// Delete removes a connector in any lifecycle. Its credentials, enrollments, assignments, live
// statuses and discovery data are deleted; recorded runs, printer errors and the events they rest on
// survive without the connector reference. A daemon still running with the deleted credential is
// rejected as unauthenticated.
func (s *Service) Delete(
	ctx context.Context,
	principal authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) error {
	if !principal.Has(authorization.PrinterConnectorsManage) {
		return apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if _, err = q.GetConnectorForUpdate(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	if err = q.RevokeConnectorCredentials(ctx, id); err != nil {
		return err
	}
	if err = q.RevokeOpenEnrollments(ctx, id); err != nil {
		return err
	}
	if err = q.SettleRunsOfConnector(ctx, id); err != nil {
		return err
	}
	if err = q.ResolveErrorOccurrencesOfConnector(ctx, id); err != nil {
		return err
	}
	if err = q.DeleteUnreferencedConnectorEvents(ctx, id); err != nil {
		return err
	}
	if err = q.DetachConnectorEvents(ctx, id); err != nil {
		return err
	}
	if err = q.DeleteConnectorAssignments(ctx, id); err != nil {
		return err
	}
	affected, err := q.DeleteConnector(ctx, db.DeleteConnectorParams{ID: id, ExpectedVersion: expected})
	if err != nil {
		return databaseError(err)
	}
	if affected == 0 {
		return apperror.StaleWrite
	}
	actor := principal.AccountID
	if err = audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &actor,
			Action:         "printer_connector.deleted",
			ResourceType:   "printer_connector",
			ResourceID:     &id,
			RequestID:      requestID,
			ChangedFields:  []string{"connector", "credentials", "assignments", "events"},
		},
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
