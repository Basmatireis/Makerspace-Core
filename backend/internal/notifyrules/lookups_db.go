package notifyrules

import (
	"context"
	"fmt"

	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
	"github.com/google/uuid"
)

// dbLookups answers validation questions from the database. It caches option sets for the length of one validation.
type dbLookups struct {
	ctx     context.Context
	queries *notifyrulesdb.Queries
	cache   map[OptionSource]map[string]struct{}
}

func newLookups(ctx context.Context, queries *notifyrulesdb.Queries) *dbLookups {
	return &dbLookups{ctx: ctx, queries: queries, cache: map[OptionSource]map[string]struct{}{}}
}

type idName struct {
	id   uuid.UUID
	name string
}

func (l *dbLookups) optionRows(source OptionSource) ([]idName, error) {
	var rows []idName
	switch source {
	case SourceMachines:
		list, err := l.queries.ListMachineOptions(l.ctx)
		for _, row := range list {
			rows = append(rows, idName{row.ID, row.Name})
		}
		return rows, err
	case SourcePrinters:
		list, err := l.queries.ListPrinterOptions(l.ctx)
		for _, row := range list {
			rows = append(rows, idName{row.ID, row.Name})
		}
		return rows, err
	case SourceRoles:
		list, err := l.queries.ListRoleOptions(l.ctx)
		for _, row := range list {
			rows = append(rows, idName{row.ID, row.Name})
		}
		return rows, err
	case SourceTrainings:
		list, err := l.queries.ListTrainingOptions(l.ctx)
		for _, row := range list {
			rows = append(rows, idName{row.ID, row.Name})
		}
		return rows, err
	case SourceProcesses:
		list, err := l.queries.ListProcessOptions(l.ctx)
		for _, row := range list {
			rows = append(rows, idName{row.ID, row.Name})
		}
		return rows, err
	case SourceFilamentTypes:
		list, err := l.queries.ListFilamentTypeOptions(l.ctx)
		for _, row := range list {
			rows = append(rows, idName{row.ID, row.Name})
		}
		return rows, err
	case SourceMaterialTypes:
		list, err := l.queries.ListMaterialTypeOptions(l.ctx)
		for _, row := range list {
			rows = append(rows, idName{row.ID, row.Name})
		}
		return rows, err
	}
	return nil, fmt.Errorf("unknown option source %q", source)
}

// OptionValues implements Lookups.
func (l *dbLookups) OptionValues(source OptionSource) (map[string]struct{}, error) {
	if set, ok := l.cache[source]; ok {
		return set, nil
	}
	rows, err := l.optionRows(source)
	if err != nil {
		return nil, fmt.Errorf("load %s options: %w", source, err)
	}
	set := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		set[row.id.String()] = struct{}{}
	}
	l.cache[source] = set
	return set, nil
}

// ExistingIDs implements Lookups.
func (l *dbLookups) ExistingIDs(kind IDKind, ids []uuid.UUID) (map[uuid.UUID]struct{}, error) {
	texts := make([]string, 0, len(ids))
	for _, id := range ids {
		texts = append(texts, id.String())
	}
	var found []uuid.UUID
	var err error
	switch kind {
	case IDRoles:
		found, err = l.queries.ListExistingRoleIDs(l.ctx, texts)
	case IDPeople:
		found, err = l.queries.ListExistingPersonIDs(l.ctx, texts)
	case IDDisplays:
		found, err = l.queries.ListExistingDisplayIDs(l.ctx, texts)
	case IDDevices:
		found, err = l.queries.ListExistingDeviceIDs(l.ctx, texts)
	default:
		return nil, fmt.Errorf("unknown identifier kind %q", kind)
	}
	if err != nil {
		return nil, fmt.Errorf("look up %s: %w", kind, err)
	}
	result := make(map[uuid.UUID]struct{}, len(found))
	for _, id := range found {
		result[id] = struct{}{}
	}
	return result, nil
}
