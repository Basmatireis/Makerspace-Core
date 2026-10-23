package staffing

import (
	"testing"

	"github.com/google/uuid"

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
			if got := StatusFor(tc.kind, tc.counts, defaults, defaults.MinOpenDaysPerSemester); got != tc.want {
				t.Fatalf("StatusFor = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestStatusForMinimumZeroIsAlwaysFulfilled(t *testing.T) {
	got := StatusFor(roles.StaffingSupervisor, Counts{}, defaults, 0)
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

func TestEffectiveMinimumLowestOverrideWins(t *testing.T) {
	cases := []struct {
		name      string
		overrides []int
		want      int
	}{
		{"no override uses the general minimum", nil, 2},
		{"one override", []int{4}, 4},
		{"override below the general minimum", []int{1}, 1},
		{"several overrides, lowest wins", []int{5, 3, 4}, 3},
		{"override zero switches the minimum off", []int{3, 0}, 0},
		{"single zero override", []int{0}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := EffectiveMinimum(2, tc.overrides); got != tc.want {
				t.Fatalf("EffectiveMinimum = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestMinimumsResolvePerPerson(t *testing.T) {
	overridden, other := uuid.New(), uuid.New()
	minimums := Minimums{general: 2, overrides: map[uuid.UUID][]int{overridden: {4, 1}}}
	if got := minimums.For(overridden); got != 1 {
		t.Fatalf("overridden person = %d, want 1", got)
	}
	if got := minimums.For(other); got != 2 {
		t.Fatalf("person without override = %d, want 2", got)
	}
}
