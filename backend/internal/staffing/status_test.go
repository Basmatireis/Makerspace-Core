package staffing

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/google/uuid"
)

var defaults = Rules{SupervisorMinimum: 2, TraineeMinimum: 2, TraineeReadyAfter: 3}

func membershipMinimum(value int) Minimum { return Minimum{Value: value, Source: SourceMembership} }

func TestStatusForCountsBookedOpenDaysTowardsTheMinimum(t *testing.T) {
	supervisor, trainee := roles.MembershipSupervisor, roles.MembershipTrainee
	cases := []struct {
		name       string
		membership roles.Membership
		counts     Counts
		want       Standing
	}{
		{"supervisor nothing", supervisor, Counts{}, Standing{StatusMissing, 2}},
		{"supervisor one booked", supervisor, Counts{Booked: 1}, Standing{StatusMissing, 1}},
		{"supervisor signed up is enough", supervisor, Counts{Staffed: 1, Booked: 1}, Standing{StatusFulfilled, 0}},
		{"supervisor beyond minimum", supervisor, Counts{Staffed: 5}, Standing{StatusFulfilled, 0}},
		{"trainee below threshold", trainee, Counts{Staffed: 2, StaffedAsTrainee: 2}, Standing{StatusFulfilled, 0}},
		{"trainee at threshold is ready", trainee, Counts{Staffed: 3, StaffedAsTrainee: 3}, Standing{StatusReady, 0}},
		{"booked trainee days do not make ready", trainee, Counts{Staffed: 2, Booked: 3, StaffedAsTrainee: 2},
			Standing{StatusFulfilled, 0}},
		{"supervisor is never ready", supervisor, Counts{Staffed: 4, StaffedAsTrainee: 4}, Standing{StatusFulfilled, 0}},
		{"trainee missing", trainee, Counts{Booked: 1}, Standing{StatusMissing, 1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := StatusFor(tc.membership, tc.counts, defaults, membershipMinimum(2)); got != tc.want {
				t.Fatalf("StatusFor = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestStatusForZeroMinimumAndExcusal(t *testing.T) {
	if got := StatusFor(roles.MembershipSupervisor, Counts{}, defaults, membershipMinimum(0)); got.Status != StatusNoMinimum {
		t.Fatalf("minimum zero = %+v, want no_minimum", got)
	}
	excused := Minimum{Value: 0, Source: SourceExcused}
	if got := StatusFor(roles.MembershipSupervisor, Counts{}, defaults, excused); got.Status != StatusExcused {
		t.Fatalf("excused = %+v, want excused", got)
	}
	ready := Counts{Staffed: 3, StaffedAsTrainee: 3}
	if got := StatusFor(roles.MembershipTrainee, ready, defaults, excused); got.Status != StatusReady {
		t.Fatalf("excused but ready trainee = %+v, want ready", got)
	}
}

func TestKindOfLeavesVisitorsOut(t *testing.T) {
	if got := KindOf(roles.MembershipVisitor); got != nil {
		t.Fatalf("visitor = %v, want nil", *got)
	}
	if got := KindOf(roles.MembershipTrainee); got == nil || *got != roles.MembershipTrainee {
		t.Fatalf("trainee = %v", got)
	}
	if got := KindOf(roles.MembershipSupervisor); got == nil || *got != roles.MembershipSupervisor {
		t.Fatalf("supervisor = %v", got)
	}
}

func TestResolveMinimumOnlyLowerExceptionsAndExcusalsCount(t *testing.T) {
	rules := Rules{SupervisorMinimum: 3, TraineeMinimum: 2}
	cases := []struct {
		name       string
		membership roles.Membership
		exceptions []Exception
		excused    bool
		want       int
		source     MinimumSource
		role       string
	}{
		{"supervisor membership minimum", roles.MembershipSupervisor, nil, false, 3, SourceMembership, ""},
		{"trainee membership minimum", roles.MembershipTrainee, nil, false, 2, SourceMembership, ""},
		{"higher exception is ignored", roles.MembershipTrainee, []Exception{{RoleName: "Board", Minimum: 4}}, false, 2,
			SourceMembership, ""},
		{"lowest exception wins", roles.MembershipSupervisor,
			[]Exception{{RoleName: "Board", Minimum: 2}, {RoleName: "Abroad", Minimum: 0}}, false, 0, SourceException,
			"Abroad"},
		{"excusal wins over everything", roles.MembershipSupervisor, []Exception{{RoleName: "Board", Minimum: 1}}, true,
			0, SourceExcused, ""},
		{"visitors have no minimum", roles.MembershipVisitor, nil, false, 0, SourceMembership, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveMinimum(tc.membership, rules, tc.exceptions, tc.excused)
			if got.Value != tc.want || got.Source != tc.source {
				t.Fatalf("ResolveMinimum = %+v, want %d from %s", got, tc.want, tc.source)
			}
			if tc.role != "" && (got.ExceptionRole == nil || *got.ExceptionRole != tc.role) {
				t.Fatalf("exception role = %v, want %s", got.ExceptionRole, tc.role)
			}
		})
	}
}

func TestMinimumsResolvePerPerson(t *testing.T) {
	exceptional, excused, other := uuid.New(), uuid.New(), uuid.New()
	minimums := Minimums{
		rules:      defaults,
		exceptions: map[uuid.UUID][]Exception{exceptional: {{RoleName: "Board", Minimum: 1}}},
		excusals:   map[uuid.UUID]Excusal{excused: {PersonID: excused, Reason: "abroad"}},
	}
	if got := minimums.For(exceptional, roles.MembershipSupervisor); got.Value != 1 || got.Source != SourceException {
		t.Fatalf("exceptional person = %+v", got)
	}
	if got := minimums.For(excused, roles.MembershipSupervisor); got.Source != SourceExcused {
		t.Fatalf("excused person = %+v", got)
	}
	if minimums.Excusal(excused) == nil || minimums.Excusal(other) != nil {
		t.Fatal("excusal lookup is wrong")
	}
	if got := minimums.For(other, roles.MembershipTrainee); got.Value != 2 {
		t.Fatalf("person without exception = %+v, want 2", got)
	}
}

func TestSignUpByFallsBackToTheDefaultDeadline(t *testing.T) {
	end := time.Date(2026, time.June, 30, 0, 0, 0, 0, time.UTC)
	explicit := time.Date(2026, time.May, 1, 0, 0, 0, 0, time.UTC)
	periodEnd := Rules{DefaultDeadline: DeadlinePeriodEnd}
	twoWeeks := Rules{DefaultDeadline: DeadlineTwoWeeksBeforeEnd}
	if got := periodEnd.SignUpBy(end, nil); !got.Equal(end) {
		t.Fatalf("period end = %v", got)
	}
	if got := twoWeeks.SignUpBy(end, nil); !got.Equal(end.AddDate(0, 0, -14)) {
		t.Fatalf("two weeks before end = %v", got)
	}
	if got := twoWeeks.SignUpBy(end, &explicit); !got.Equal(explicit) {
		t.Fatalf("explicit deadline = %v", got)
	}
}
