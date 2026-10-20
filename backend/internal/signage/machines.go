package signage

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
)

// Machine is the picker view of a machine: no statistics, no external identifiers.
type Machine struct {
	ID        uuid.UUID
	Name      string
	Kind      string
	HasCamera bool
}

// ListMachines lists machines for signage pickers. Any signage permission that edits or reads
// signage content is enough; `machines.read` is deliberately not required.
func (s *Service) ListMachines(ctx context.Context, principal authorization.Principal) ([]Machine, error) {
	if !principal.Has(authorization.SignageRead) && !principal.Has(authorization.SignageManage) && !principal.Has(authorization.SignageContentManage) {
		return nil, apperror.PermissionDenied
	}
	rows, err := signagedb.New(s.pool).ListSignageMachines(ctx)
	if err != nil {
		return nil, err
	}
	cameraIDs, err := signagedb.New(s.pool).ListSignageCameraMachineIDs(ctx)
	if err != nil {
		return nil, err
	}
	withCamera := make(map[uuid.UUID]struct{}, len(cameraIDs))
	for _, id := range cameraIDs {
		withCamera[id] = struct{}{}
	}
	machines := make([]Machine, 0, len(rows))
	for _, row := range rows {
		_, hasCamera := withCamera[row.ID]
		machines = append(machines, Machine{ID: row.ID, Name: row.Name, Kind: row.Kind, HasCamera: hasCamera})
	}
	return machines, nil
}
