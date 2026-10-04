package integration_test

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/supervisors"
	"github.com/google/uuid"
)

func TestSupervisorDashboardSeparatesAssignmentKindsByPeriod(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	service := supervisors.NewService(pool)
	if _, err := service.Get(ctx, authorization.Principal{}); !apperror.IsCode(err, "permission_denied") {
		t.Fatalf("unauthorized dashboard error = %v, want permission_denied", err)
	}

	member := seedAccount(t, pool, "supervisor-dashboard-counts", false)
	designatedRoleID := uuid.Must(uuid.NewV7())
	if _, err := pool.Exec(ctx, `INSERT INTO roles(id,name,supervisor_dashboard) VALUES($1,'Dashboard members',true)`, designatedRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO person_roles(person_id,role_id) VALUES($1,$2)`, member.personID, designatedRoleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM accounts WHERE id=$1`, member.accountID); err != nil {
		t.Fatal(err)
	}

	periodID := uuid.Must(uuid.NewV7())
	firstDayID := uuid.Must(uuid.NewV7())
	secondDayID := uuid.Must(uuid.NewV7())
	supervisorRequirementID := uuid.Must(uuid.NewV7())
	traineeRequirementID := uuid.Must(uuid.NewV7())
	startsAt := time.Date(2026, time.October, 10, 8, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `
		INSERT INTO open_day_periods(id,name,starts_on,ends_on,status)
		VALUES($1,'Dashboard period','2026-10-01','2026-10-31','staffing');
		INSERT INTO open_days(id,period_id,starts_at,ends_at) VALUES
			($2,$1,$6::timestamptz,$6::timestamptz + interval '4 hours'),
			($3,$1,$6::timestamptz + interval '1 day',$6::timestamptz + interval '1 day 4 hours');
		INSERT INTO open_day_staff_requirements(id,open_day_id,kind,required_count) VALUES
			($4,$2,'supervisor',1),
			($5,$3,'trainee',1);`,
		periodID, firstDayID, secondDayID, supervisorRequirementID, traineeRequirementID, startsAt); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO open_day_assignments(id,open_day_id,requirement_id,person_id) VALUES
			($1,$2,$3,$6),
			($4,$5,$7,$6)`,
		uuid.Must(uuid.NewV7()), firstDayID, supervisorRequirementID,
		uuid.Must(uuid.NewV7()), secondDayID, member.personID, traineeRequirementID); err != nil {
		t.Fatal(err)
	}

	dashboard, err := service.Get(ctx, authorization.Principal{Master: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(dashboard.Periods) != 1 || dashboard.Periods[0].ID != periodID || dashboard.Periods[0].SupervisorAssignments != 1 {
		t.Fatalf("periods = %#v, want one period with one supervisor assignment", dashboard.Periods)
	}
	if len(dashboard.Supervisors) != 1 || dashboard.Supervisors[0].PersonID != member.personID {
		t.Fatalf("supervisors = %#v, want dashboard member", dashboard.Supervisors)
	}
	counts := dashboard.Supervisors[0].AssignmentCounts
	if len(counts) != 1 || counts[0].PeriodID != periodID || counts[0].SupervisorCount != 1 || counts[0].TraineeCount != 1 {
		t.Fatalf("assignment counts = %#v, want one supervisor and one trainee assignment", counts)
	}
}
