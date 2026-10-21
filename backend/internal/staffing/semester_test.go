package staffing

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func day(month time.Month, d int) time.Time { return time.Date(2026, month, d, 0, 0, 0, 0, time.UTC) }

func semester(name string, start, end time.Time) Semester {
	return Semester{ID: uuid.New(), Name: name, StartsOn: start, EndsOn: end}
}

func TestResolveSemesterPrefersPeriodContainingToday(t *testing.T) {
	winter := semester("winter", day(time.October, 1), day(time.December, 31))
	summer := semester("summer", day(time.March, 1), day(time.June, 30))
	got := ResolveSemester([]Semester{summer, winter}, day(time.November, 15))
	if got == nil || got.Name != "winter" {
		t.Fatalf("semester = %v, want winter", got)
	}
	// Both ends of the range are inclusive.
	if got := ResolveSemester([]Semester{winter}, day(time.October, 1)); got == nil || got.Name != "winter" {
		t.Fatalf("first day semester = %v, want winter", got)
	}
	if got := ResolveSemester([]Semester{winter}, day(time.December, 31)); got == nil || got.Name != "winter" {
		t.Fatalf("last day semester = %v, want winter", got)
	}
}

func TestResolveSemesterFallsBackToNextUpcomingThenMostRecentPast(t *testing.T) {
	spring := semester("spring", day(time.March, 1), day(time.March, 31))
	summer := semester("summer", day(time.June, 1), day(time.June, 30))
	autumn := semester("autumn", day(time.October, 1), day(time.October, 31))
	if got := ResolveSemester([]Semester{autumn, summer, spring}, day(time.April, 10)); got == nil || got.Name != "summer" {
		t.Fatalf("between periods = %v, want the next upcoming (summer)", got)
	}
	if got := ResolveSemester([]Semester{autumn, summer, spring}, day(time.December, 1)); got == nil || got.Name != "autumn" {
		t.Fatalf("after all periods = %v, want the most recent past (autumn)", got)
	}
	if got := ResolveSemester(nil, day(time.April, 10)); got != nil {
		t.Fatalf("no periods = %v, want nil", got)
	}
}

func TestResolveSemesterPicksLatestStartWhenPeriodsOverlap(t *testing.T) {
	long := semester("long", day(time.January, 1), day(time.December, 31))
	short := semester("short", day(time.May, 1), day(time.May, 31))
	if got := ResolveSemester([]Semester{long, short}, day(time.May, 10)); got == nil || got.Name != "short" {
		t.Fatalf("overlapping periods = %v, want the later-starting one", got)
	}
}

func TestDateOfUsesTheMakerspaceCalendarDay(t *testing.T) {
	vienna, err := time.LoadLocation("Europe/Vienna")
	if err != nil {
		t.Fatal(err)
	}
	// 23:30 UTC on 30 Jun is already 1 Jul in Vienna.
	got := DateOf(time.Date(2026, time.June, 30, 23, 30, 0, 0, time.UTC), vienna)
	if !got.Equal(day(time.July, 1)) {
		t.Fatalf("date = %v, want 2026-07-01", got)
	}
}
