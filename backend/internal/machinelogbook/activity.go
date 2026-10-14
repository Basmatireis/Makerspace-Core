package machinelogbook

import (
	"context"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/google/uuid"
)

type MachineCurrentItem struct {
	Kind            string
	ID              uuid.UUID
	DisplayID       string
	Title, FileName *string
	StartedAt       time.Time
	EndsAt          *time.Time
}

type MachineConnectorState struct {
	RuntimeState, RuntimeErrorCode *string
	LastHeartbeatAt                *time.Time
}

type MachineActivity struct {
	MachineID        uuid.UUID
	Availability     string
	Current          *MachineCurrentItem
	Connector        *MachineConnectorState
	LastJobStartedAt *time.Time
}

// MachineActivity derives availability, the current run and the connector state
// of every machine. Availability never depends on the caller's job permission,
// but the current item is only disclosed to callers that may read jobs.
func (s *Service) MachineActivity(ctx context.Context, p authorization.Principal) ([]MachineActivity, error) {
	if err := require(p, authorization.MachinesRead); err != nil {
		return nil, err
	}
	q := machinelogbookdb.New(s.pool)
	now := s.now().UTC()
	machines, err := q.ListMachineActivityMachines(ctx)
	if err != nil {
		return nil, err
	}
	running, err := q.ListMachineRunningRuns(ctx, now)
	if err != nil {
		return nil, err
	}
	connectors, err := q.ListMachineConnectorStates(ctx)
	if err != nil {
		return nil, err
	}
	lastStarts, err := q.ListMachineLastJobStarts(ctx, now)
	if err != nil {
		return nil, err
	}
	runByMachine := make(map[uuid.UUID]machinelogbookdb.ListMachineRunningRunsRow, len(running))
	for _, row := range running {
		runByMachine[row.MachineID] = row
	}
	connectorByMachine := make(map[uuid.UUID]machinelogbookdb.ListMachineConnectorStatesRow, len(connectors))
	for _, row := range connectors {
		connectorByMachine[row.MachineID] = row
	}
	lastByMachine := make(map[uuid.UUID]time.Time, len(lastStarts))
	for _, row := range lastStarts {
		lastByMachine[row.MachineID] = row.LastStartedAt.UTC()
	}
	canReadJobs := p.Has(authorization.MachineJobsRead)
	result := make([]MachineActivity, 0, len(machines))
	for _, machine := range machines {
		item := MachineActivity{MachineID: machine.ID, Availability: "available"}
		if last, ok := lastByMachine[machine.ID]; ok {
			item.LastJobStartedAt = &last
		}
		if row, ok := connectorByMachine[machine.ID]; ok {
			item.Connector = &MachineConnectorState{RuntimeState: row.RuntimeState, RuntimeErrorCode: row.RuntimeErrorCode, LastHeartbeatAt: nullableTime(row.LastHeartbeatAt)}
		}
		current, inUse := runByMachine[machine.ID]
		switch {
		case machine.Status == "retired" || machine.Status == "maintenance":
			item.Availability = machine.Status
		case inUse:
			item.Availability = "in_use"
		}
		if canReadJobs && inUse {
			if current.JobID != nil && current.JobDisplayID != nil {
				item.Current = &MachineCurrentItem{Kind: "job", ID: *current.JobID, DisplayID: *current.JobDisplayID, Title: current.JobTitle, FileName: current.FileName, StartedAt: current.StartedAt.UTC(), EndsAt: nullableTime(current.EndsAt)}
			} else {
				item.Current = &MachineCurrentItem{Kind: "run", ID: current.ID, DisplayID: current.DisplayID, FileName: current.FileName, StartedAt: current.StartedAt.UTC(), EndsAt: nullableTime(current.EndsAt)}
			}
		}
		result = append(result, item)
	}
	return result, nil
}
