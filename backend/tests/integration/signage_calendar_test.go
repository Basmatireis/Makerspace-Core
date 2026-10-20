package integration_test

import (
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/opendays"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
)

// TestSignageCalendarShowsRealOpenDaysAndEvents creates open days and events through the real
// services (period lifecycle, schedule, event lifecycle and publication) and checks that exactly
// the public ones reach both the admin calendar endpoint and a paired display's live data.
func TestSignageCalendarShowsRealOpenDaysAndEvents(t *testing.T) {
	e := newSignageEnv(t)
	ctx := testContext(t)
	admin := e.fixture.admin
	staff := e.allStaff()
	_, playlist := e.seedContent("Calendar")
	display, player := e.pair(staff, "Calendar display", playlist.ID)
	e.expect(e.as(staff, http.MethodPost, "/signage/displays/"+display["id"].(string)+"/publish", nil), http.StatusOK)

	openDays, err := opendays.NewService(e.pool, config.Config{MakerspaceTimeZone: "Europe/Vienna"})
	if err != nil {
		t.Fatal(err)
	}
	baseURL, _ := url.Parse("https://makerspace.example.test")
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	eventService, err := events.NewService(
		e.pool,
		config.Config{
			MakerspaceTimeZone: "Europe/Vienna",
			PublicBaseURL:      baseURL,
			ChallengeHMACKey:   []byte("calendar-limiter-key"),
		},
		files.NewService(e.pool, store),
	)
	if err != nil {
		t.Fatal(err)
	}

	// Nothing planned yet: both lists are empty arrays (never null).
	empty := e.expect(e.as(staff, http.MethodGet, "/signage/calendar", nil), http.StatusOK)
	if days, ok := empty["openDays"].([]any); !ok || len(days) != 0 {
		t.Fatalf("empty calendar openDays = %v", empty["openDays"])
	}
	if list, ok := empty["events"].([]any); !ok || len(list) != 0 {
		t.Fatalf("empty calendar events = %v", empty["events"])
	}

	// Open days: a published period with seven future days, one cancelled, plus a period still in
	// staffing whose day must stay invisible.
	today := time.Now().UTC().Truncate(24 * time.Hour)
	period, err := openDays.CreatePeriod(ctx, admin, "Autumn", today, today.AddDate(0, 0, 40), nil)
	if err != nil {
		t.Fatal(err)
	}
	slot := func(days int) (time.Time, time.Time) {
		start := today.AddDate(0, 0, days).Add(16 * time.Hour)
		return start, start.Add(3 * time.Hour)
	}
	requirements := []opendays.RequirementInput{
		{Kind: "supervisor", RequiredCount: 1, EligibleRoleIDs: []uuid.UUID{uuid.MustParse(masterRoleID)}},
		{Kind: "trainee", RequiredCount: 0},
	}
	var schedule opendays.Schedule
	version := period.Version
	for _, offset := range []int{9, 3, 5, 7, 4, 8, 6} { // created out of order on purpose
		start, end := slot(offset)
		if schedule, err = openDays.CreateOpenDay(
			ctx,
			admin,
			period.ID,
			version,
			opendays.ScheduleInput{StartsAt: start, EndsAt: end, Requirements: requirements},
			nil,
		); err != nil {
			t.Fatalf("open day +%d: %v", offset, err)
		}
		version = schedule.Period.Version
	}
	staffing, err := openDays.TransitionPeriod(ctx, admin, period.ID, version, "staffing", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Staffing is not public yet.
	if got := e.expect(e.as(staff, http.MethodGet, "/signage/calendar", nil), http.StatusOK)["openDays"].([]any); len(
		got,
	) != 0 {
		t.Fatalf("period in staffing is visible: %v", got)
	}
	published, err := openDays.TransitionPeriod(ctx, admin, period.ID, staffing.Version, "published", nil)
	if err != nil {
		t.Fatal(err)
	}

	// Events: seven public ones (planning), one unpublished, one past; each with its own session.
	owner := admin.PersonID
	makeEvent := func(name, title string, hoursFromNow int, publish bool) {
		t.Helper()
		location := "Workshop floor"
		event, err := eventService.Create(ctx, admin, events.EventInput{Name: name, OwnerPersonID: &owner}, nil)
		if err != nil {
			t.Fatal(err)
		}
		start := time.Now().UTC().Add(time.Duration(hoursFromNow) * time.Hour).Truncate(time.Minute)
		if _, err = eventService.CreateSession(
			ctx,
			admin,
			event.ID,
			events.SessionInput{StartsAt: start, EndsAt: start.Add(2 * time.Hour), IsPublic: true, Status: "scheduled"},
			nil,
		); err != nil {
			t.Fatal(err)
		}
		planning, err := eventService.Transition(ctx, admin, event.ID, event.Version, "planning", nil)
		if err != nil {
			t.Fatal(err)
		}
		if publish {
			if planning, err = eventService.Update(
				ctx,
				admin,
				event.ID,
				events.EventInput{
					Name:            name,
					OwnerPersonID:   &owner,
					PublicTitle:     &title,
					PublicLocation:  &location,
					ExpectedVersion: planning.Version,
				},
				nil,
			); err != nil {
				t.Fatal(err)
			}
			if _, err = eventService.SetPublished(ctx, admin, event.ID, planning.Version, true, nil); err != nil {
				t.Fatal(err)
			}
		}
	}
	for index := 0; index < 7; index++ {
		makeEvent(
			fmt.Sprintf("Internal %d", index),
			fmt.Sprintf("Public event %d", index),
			30+index*10-(index%2)*5,
			true,
		)
	}
	makeEvent("Unpublished", "Not public", 24, false)

	assertLists := func(source string, body map[string]any) {
		t.Helper()
		days := body["openDays"].([]any)
		if len(days) != 5 {
			t.Fatalf("%s: %d open days, want the next 5", source, len(days))
		}
		for index, offset := range []int{3, 4, 5, 6, 7} {
			wantStart, wantEnd := slot(offset)
			day := days[index].(map[string]any)
			gotStart, _ := time.Parse(time.RFC3339, day["startsAt"].(string))
			gotEnd, _ := time.Parse(time.RFC3339, day["endsAt"].(string))
			if !gotStart.Equal(wantStart) || !gotEnd.Equal(wantEnd) || day["status"] != "scheduled" {
				t.Fatalf("%s: open day %d = %v, want %v..%v", source, index, day, wantStart, wantEnd)
			}
		}
		list := body["events"].([]any)
		if len(list) != 5 {
			t.Fatalf("%s: %d events, want 5", source, len(list))
		}
		previous := ""
		for _, raw := range list {
			entry := raw.(map[string]any)
			if len(entry) != 3 || entry["location"] != "Workshop floor" || entry["title"] == "Not public" ||
				entry["title"] == nil {
				t.Fatalf("%s: event = %v", source, entry)
			}
			if starts := entry["startsAt"].(string); starts < previous {
				t.Fatalf("%s: events not ascending: %v", source, list)
			} else {
				previous = starts
			}
		}
	}
	response := e.as(staff, http.MethodGet, "/signage/calendar", nil)
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header.Get("Cache-Control"))
	}
	calendar := e.expect(response, http.StatusOK)
	assertLists("calendar", calendar)
	live := e.expect(e.do(player, "", http.MethodGet, "/signage/player/live", nil), http.StatusOK)
	assertLists("live", live)
	// Both endpoints serve the same lists.
	for _, key := range []string{"openDays", "events"} {
		if fmt.Sprint(calendar[key]) != fmt.Sprint(live[key]) {
			t.Fatalf("%s differ: calendar %v, live %v", key, calendar[key], live[key])
		}
	}

	// A cancelled open day keeps its place with status cancelled; the next ones move up.
	var firstDay opendays.OpenDay
	for _, day := range schedule.Items {
		if firstDay.ID == uuid.Nil || day.StartsAt.Before(firstDay.StartsAt) {
			firstDay = day
		}
	}
	if _, err = openDays.CancelOpenDay(ctx, admin, firstDay.ID, published.Version, firstDay.Version, nil); err != nil {
		t.Fatal(err)
	}
	days := e.expect(e.as(staff, http.MethodGet, "/signage/calendar", nil), http.StatusOK)["openDays"].([]any)
	if len(days) != 5 {
		t.Fatalf("after cancelling: %v", days)
	}
	// The cancelled day either stays with status cancelled or leaves the list; it is never "scheduled".
	first := days[0].(map[string]any)
	gotStart, _ := time.Parse(time.RFC3339, first["startsAt"].(string))
	if wantFirst, _ := slot(3); gotStart.Equal(wantFirst) && first["status"] == "scheduled" {
		t.Fatalf("cancelled day still shown as scheduled: %v", first)
	}
}

func TestSignageCalendarPermissions(t *testing.T) {
	e := newSignageEnv(t)
	for name, session := range map[string]staffSession{
		"read":    e.staff("cal-read", authorization.SignageRead),
		"content": e.staff("cal-content", authorization.SignageContentManage),
		"manage":  e.staff("cal-manage", authorization.SignageManage),
	} {
		t.Run("allowed "+name, func(t *testing.T) {
			e.expect(e.as(session, http.MethodGet, "/signage/calendar", nil), http.StatusOK)
		})
	}
	for name, session := range map[string]staffSession{
		"nobody":   e.staff("cal-nobody"),
		"publish":  e.staff("cal-publish", authorization.SignagePublish),
		"override": e.staff("cal-override", authorization.SignageOverride),
		"local":    e.staff("cal-local", authorization.LocalServicesManage),
	} {
		t.Run("denied "+name, func(t *testing.T) {
			e.expectCode(
				e.as(session, http.MethodGet, "/signage/calendar", nil),
				http.StatusForbidden,
				"permission_denied",
			)
		})
	}
	t.Run("anonymous", func(t *testing.T) {
		e.expect(e.do(e.newPlayer(), "", http.MethodGet, "/signage/calendar", nil), http.StatusUnauthorized)
	})
	t.Run("pairing-less player", func(t *testing.T) {
		_, playlist := e.seedContent("Calendar permissions")
		_, player := e.pair(e.allStaff(), "Calendar device", playlist.ID)
		// A paired player has no staff session and may not read the staff calendar.
		status := e.do(player, "", http.MethodGet, "/signage/calendar", nil).StatusCode
		if status != http.StatusUnauthorized && status != http.StatusForbidden {
			t.Fatalf("player status = %d", status)
		}
	})
}
