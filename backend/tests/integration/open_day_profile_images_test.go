package integration_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// openDayReader signs in a person whose only role grants the given permissions; none of them reads other people.
func openDayReader(
	ctx context.Context,
	t *testing.T,
	pool *pgxpool.Pool,
	suffix string,
	permissions ...authorization.Permission,
) authorization.Principal {
	t.Helper()
	account := seedAccount(t, pool, suffix, false)
	roleID := ids.New()
	if _, err := pool.Exec(ctx, `INSERT INTO roles (id, name) VALUES ($1, $2)`, roleID, "Reader "+suffix); err != nil {
		t.Fatal(err)
	}
	for _, permission := range permissions {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO role_permission_grants (id, role_id, permission_id) VALUES (uuidv7(), $1, $2)`,
			roleID,
			permission,
		); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO person_roles (person_id, role_id) VALUES ($1, $2)`,
		account.personID,
		roleID,
	); err != nil {
		t.Fatal(err)
	}
	principal, err := authorization.LoadPermissionsFrom(
		ctx,
		pool,
		authorization.Principal{AccountID: account.accountID, PersonID: account.personID},
	)
	if err != nil {
		t.Fatal(err)
	}
	return principal
}

func TestOpenDayAssignmentProfileImagesFollowAssignmentNames(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	manager := seedAccount(t, pool, "assignment-image", true)
	p := authorization.Principal{AccountID: manager.accountID, PersonID: manager.personID, Master: true}
	makeMasterHoldersSupervisors(t, pool)
	service, err := opendays.NewService(pool, notifyrules.NewSystemEvents(nil), config.Config{})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	period, err := service.CreatePeriod(ctx, p, "Assignment images", start, start.AddDate(0, 0, 2), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	schedule, err := service.CreateOpenDay(ctx, p, period.ID, period.Version, opendays.ScheduleInput{
		StartsAt: start.Add(12 * time.Hour), EndsAt: start.Add(14 * time.Hour),
		Requirements: []opendays.RequirementInput{
			{Kind: "supervisor", RequiredCount: 1, EligibleRoleIDs: []uuid.UUID{}},
			{Kind: "trainee", RequiredCount: 0},
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.TransitionPeriod(ctx, p, period.ID, schedule.Period.Version, "staffing", nil); err != nil {
		t.Fatal(err)
	}
	day := schedule.Items[0]
	assignment, err := service.Assign(ctx, p, day.ID, day.Requirements[0].ID, manager.personID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if assignment.HasProfileImage {
		t.Fatal("an assignee without a profile image is marked as having one")
	}
	if _, err := service.AssignmentProfileImageFile(ctx, p, day.ID, assignment.ID); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("image without upload: %v, want not found", err)
	}

	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	image, err := files.NewService(pool, store).StoreBytes(ctx, p, "profile.jpg", "image/jpeg", []byte("profile"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`UPDATE people SET profile_image_file_id=$1, profile_image_source='self_upload' WHERE id=$2`,
		image.ID,
		manager.personID,
	); err != nil {
		t.Fatal(err)
	}

	// Who sees the names sees the pictures, without permission to read the person.
	names := openDayReader(ctx, t, pool, "assignment-image-names",
		authorization.OpenDaysRead, authorization.OpenDaysReadAssignments)
	if names.CanReadPerson(manager.personID) {
		t.Fatal("the reader must not be able to read the assigned person")
	}
	visible, err := service.GetSchedule(ctx, names, period.ID)
	if err != nil {
		t.Fatal(err)
	}
	assignments := visible.Items[0].Timeslots[0].Requirements[0].Assignments
	if assignments == nil || len(*assignments) != 1 || !(*assignments)[0].HasProfileImage {
		t.Fatalf("assignments seen with names = %+v", assignments)
	}
	fileID, err := service.AssignmentProfileImageFile(ctx, names, day.ID, assignment.ID)
	if err != nil || fileID != image.ID {
		t.Fatalf("image for a name reader = %v, %v", fileID, err)
	}
	// The assignment must belong to the open day in the path.
	if _, err := service.AssignmentProfileImageFile(ctx, names, ids.New(), assignment.ID); !errors.Is(err, apperror.NotFound) {
		t.Fatalf("image under another open day: %v, want not found", err)
	}

	// Without the names there are no pictures either.
	anonymous := openDayReader(ctx, t, pool, "assignment-image-anonymous",
		authorization.OpenDaysRead, authorization.OpenDaysSignup)
	hidden, err := service.GetSchedule(ctx, anonymous, period.ID)
	if err != nil {
		t.Fatal(err)
	}
	if hidden.Items[0].Timeslots[0].Requirements[0].Assignments != nil {
		t.Fatal("assignments are visible without open_days.read_assignments")
	}
	if _, err := service.AssignmentProfileImageFile(ctx, anonymous, day.ID, assignment.ID); !errors.Is(
		err,
		apperror.PermissionDenied,
	) {
		t.Fatalf("image without read_assignments: %v, want permission denied", err)
	}
}
