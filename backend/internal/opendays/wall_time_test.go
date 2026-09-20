package opendays

import (
	"testing"
	"time"

	opendaysdb "github.com/Basmatireis/Makerspace-Core/backend/internal/opendays/db"
)

func TestLocalTimeMustResolveToExactlyOneInstant(t *testing.T) {
	location, err := time.LoadLocation("Europe/Vienna")
	if err != nil {
		t.Fatal(err)
	}
	service := Service{location: location}
	for _, test := range []struct{ wall, want string }{
		{"2026-02-15 12:30", "2026-02-15T11:30:00Z"},
		{"2026-03-29 02:30", ""},
		{"2026-10-25 02:30", ""},
		{"2026-03-29 03:30", "2026-03-29T01:30:00Z"},
		{"2026-10-25 03:30", "2026-10-25T02:30:00Z"},
	} {
		t.Run(test.wall, func(t *testing.T) {
			wall, _ := time.Parse("2006-01-02 15:04", test.wall)
			got, err := service.resolveWallTime(wall)
			if test.want == "" {
				if err == nil {
					t.Fatal("invalid local time accepted")
				}
				return
			}
			if err != nil || got.Format(time.RFC3339) != test.want {
				t.Fatalf("got %v %v", got, err)
			}
		})
	}
}

func TestSlotValidationRejectsAmbiguousInstantsAndPreservesOvernightBounds(t *testing.T) {
	location, _ := time.LoadLocation("Europe/Vienna")
	service := Service{location: location}
	date := func(value string) time.Time { d, _ := time.Parse("2006-01-02", value); return d }
	period := opendaysdb.OpenDayPeriod{StartsOn: pgDate(date("2026-01-01")), EndsOn: pgDate(date("2026-12-31"))}
	for _, test := range []struct {
		start, end string
		valid      bool
	}{
		{"2026-02-15T23:00:00+01:00", "2026-02-16T01:00:00+01:00", true},
		{"2026-03-28T23:00:00+01:00", "2026-03-29T04:00:00+02:00", true},
		{"2026-03-29T02:30:00+01:00", "2026-03-29T04:00:00+02:00", false},
		{"2026-10-25T00:30:00Z", "2026-10-25T03:00:00Z", false},
		{"2026-10-25T01:30:00Z", "2026-10-25T03:00:00Z", false},
		{"2026-10-25T00:00:00+02:00", "2026-10-25T02:30:00+01:00", false},
	} {
		start, _ := time.Parse(time.RFC3339, test.start)
		end, _ := time.Parse(time.RFC3339, test.end)
		if err := service.validateSlot(period, start, end); (err == nil) != test.valid {
			t.Errorf("%s / %s: %v", test.start, test.end, err)
		}
	}
}
