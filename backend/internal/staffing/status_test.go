package staffing

import (
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
)

var defaults = Requirements{MinOpenDaysPerSemester: 2, TraineeOpenDaysForPromotion: 3}

func TestStatusForCountsBookedOpenDaysTowardsTheMinimum(t *testing.T) {
	cases := []struct {
		name   string
		kind   roles.StaffingLevel
		counts Counts
		want   Standing
	}{
		{"supervisor nothing", roles.StaffingSupervisor, Counts{}, Standing{StatusMissing, 2}},
		{"supervisor one booked", roles.StaffingSupervisor, Counts{Booked: 1}, Standing{StatusMissing, 1}},
		{"supervisor signed up is enough", roles.StaffingSupervisor, Counts{Staffed: 1, Booked: 1}, Standing{StatusFulfilled, 0}},
		{"supervisor beyond minimum", roles.StaffingSupervisor, Counts{Staffed: 5}, Standing{StatusFulfilled, 0}},
		{"trainee below threshold", roles.StaffingTrainee, Counts{Staffed: 2, StaffedAsTrainee: 2}, Standing{StatusFulfilled, 0}},
		{"trainee at threshold is ready", roles.StaffingTrainee, Counts{Staffed: 3, StaffedAsTrainee: 3}, Standing{StatusReady, 0}},
		{"booked trainee days do not make ready", roles.StaffingTrainee, Counts{Staffed: 2, Booked: 3, StaffedAsTrainee: 2}, Standing{StatusFulfilled, 0}},
		{"supervisor is never ready", roles.StaffingSupervisor, Counts{Staffed: 4, StaffedAsTrainee: 4}, Standing{StatusFulfilled, 0}},
		{"trainee missing", roles.StaffingTrainee, Counts{Booked: 1}, Standing{StatusMissing, 1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := StatusFor(tc.kind, tc.counts, defaults); got != tc.want {
				t.Fatalf("StatusFor = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestStatusForMinimumZeroIsAlwaysFulfilled(t *testing.T) {
	got := StatusFor(roles.StaffingSupervisor, Counts{}, Requirements{MinOpenDaysPerSemester: 0, TraineeOpenDaysForPromotion: 3})
	if got.Status != StatusFulfilled || got.Missing != 0 {
		t.Fatalf("StatusFor = %+v, want fulfilled", got)
	}
}

func TestKindOfLetsSupervisorWinOverTrainee(t *testing.T) {
	if got := KindOf(nil); got != nil {
		t.Fatalf("no levels = %v, want nil", *got)
	}
	if got := KindOf([]roles.StaffingLevel{roles.StaffingTrainee}); got == nil || *got != roles.StaffingTrainee {
		t.Fatalf("trainee only = %v", got)
	}
	both := []roles.StaffingLevel{roles.StaffingTrainee, roles.StaffingSupervisor}
	if got := KindOf(both); got == nil || *got != roles.StaffingSupervisor {
		t.Fatalf("both = %v, want supervisor", got)
	}
}
