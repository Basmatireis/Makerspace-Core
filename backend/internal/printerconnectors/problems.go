package printerconnectors

import (
	"context"
	"fmt"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/jackc/pgx/v5/pgtype"
)

// ProblemWatchInterval is how often the scheduler compares connector facts with what was notified.
const ProblemWatchInterval = 30 * time.Second

// ProblemNotifyAfter is how long a connector problem must last before printer_connector_problem fires, so a
// short hiccup (one failed FTPS listing, a restarted connector) stays quiet.
const ProblemNotifyAfter = 2 * time.Minute

// WatchProblems derives each assignment's connector problem from its heartbeat facts, raises
// printer_connector_problem once a problem has lasted ProblemNotifyAfter, and resolves the notified problem when it
// clears, changes kind or its assignment ends. It returns how many problems were raised and resolved.
func (s *Service) WatchProblems(ctx context.Context, now time.Time) (raised, resolved int, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	rows, err := q.ListAssignmentProblemFacts(ctx)
	if err != nil {
		return 0, 0, err
	}
	now = now.UTC()
	for _, row := range rows {
		problem, code := machinelogbook.ConnectorProblemNone, ""
		if row.Active {
			facts := machinelogbook.ConnectorFacts{
				RuntimeState: row.RuntimeState, RuntimeErrorCode: row.RuntimeErrorCode, HealthState: row.HealthState,
			}
			if row.LastHeartbeatAt.Valid {
				facts.LastHeartbeatAt = &row.LastHeartbeatAt.Time
			}
			problem, code = machinelogbook.ClassifyConnectorProblem(facts, now)
		}
		stored := machinelogbook.ConnectorProblemNone
		if row.ProblemKind != nil {
			stored = machinelogbook.ConnectorProblem(*row.ProblemKind)
		}
		notified := row.ProblemNotifiedAt.Valid
		params := db.SetAssignmentProblemParams{ID: row.ID}
		switch {
		case problem != stored:
			if notified && s.emitter != nil {
				if err = s.emitter.PrinterConnectorProblemCleared(ctx, tx, row.MachineID, string(stored)); err != nil {
					return 0, 0, fmt.Errorf("resolve connector problem: %w", err)
				}
				resolved++
			}
			if problem != machinelogbook.ConnectorProblemNone {
				params.ProblemKind, params.ProblemCode, params.ProblemSince = problemColumns(problem, code, now)
			}
		case problem == machinelogbook.ConnectorProblemNone:
			continue
		default:
			params.ProblemKind, params.ProblemCode, _ = problemColumns(problem, code, now)
			params.ProblemSince = row.ProblemSince
			params.ProblemNotifiedAt = row.ProblemNotifiedAt
			if !notified && row.ProblemSince.Valid && now.Sub(row.ProblemSince.Time) >= ProblemNotifyAfter {
				if s.emitter != nil {
					message := machinelogbook.ConnectorProblemMessage(problem, code)
					if err = s.emitter.PrinterConnectorProblem(ctx, tx, row.MachineID, string(problem), code, message); err != nil {
						return 0, 0, fmt.Errorf("raise connector problem: %w", err)
					}
				}
				params.ProblemNotifiedAt = pgtype.Timestamptz{Time: now, Valid: true}
				raised++
			} else if row.ProblemCode != nil && *row.ProblemCode == code {
				continue
			}
		}
		if err = q.SetAssignmentProblem(ctx, params); err != nil {
			return 0, 0, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, 0, err
	}
	return raised, resolved, nil
}

func problemColumns(
	problem machinelogbook.ConnectorProblem, code string, now time.Time,
) (kind, codeColumn *string, since pgtype.Timestamptz) {
	value := string(problem)
	kind = &value
	if code != "" {
		codeColumn = &code
	}
	return kind, codeColumn, pgtype.Timestamptz{Time: now, Valid: true}
}
