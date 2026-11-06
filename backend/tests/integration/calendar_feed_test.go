package integration_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/calendarfeed"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
)

// feedToken extracts the token from a subscription link.
func feedToken(t *testing.T, link string) string {
	t.Helper()
	index := strings.LastIndex(link, "/api/v1/calendar/")
	if index < 0 || !strings.HasSuffix(link, ".ics") {
		t.Fatalf("unexpected subscription link shape: %d characters", len(link))
	}
	return strings.TrimSuffix(link[index+len("/api/v1/calendar/"):], ".ics")
}

func (e *staffingEnv) feedService() *calendarfeed.Service {
	e.t.Helper()
	service, err := calendarfeed.NewService(e.pool, config.Config{MakerspaceTimeZone: "Europe/Vienna"})
	if err != nil {
		e.t.Fatal(err)
	}
	return service
}

func TestCalendarFeedContainsOnlyTheOwnersOpenDaysAndEventShifts(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	service := e.feedService()
	supervisorRole := e.role("", level(roles.MembershipSupervisor), authorization.OpenDaysRead)
	alice := e.person("feed-alice", supervisorRole.ID)
	bob := e.person("feed-bob", supervisorRole.ID)

	mine := e.openDay(e.now.Add(3*24*time.Hour), 2*time.Hour, 3, 0)
	cancelled := e.openDay(e.now.Add(6*24*time.Hour), 2*time.Hour, 3, 0)
	longAgo := e.openDay(e.now.Add(-40*24*time.Hour), 2*time.Hour, 3, 0)
	recent := e.openDay(e.now.Add(-10*24*time.Hour), 2*time.Hour, 3, 0)
	bobsDay := e.openDay(e.now.Add(9*24*time.Hour), 2*time.Hour, 3, 0)
	for _, day := range []openDayFixture{mine, cancelled, longAgo, recent} {
		e.join(day, day.supervisorRequirement, alice)
	}
	e.join(bobsDay, bobsDay.supervisorRequirement, bob)
	e.exec(`UPDATE open_days SET status='cancelled', version=version+1 WHERE id=$1`, cancelled.id)
	e.exec(`UPDATE open_days SET version=4 WHERE id=$1`, mine.id)

	eventID := e.shift("Spring exhibition", true, "open", e.now.Add(4*24*time.Hour), 3*time.Hour, alice, "active")
	e.exec(`UPDATE events SET location='Hall B' WHERE id=$1`, eventID)
	e.shift("Bob's workshop", true, "open", e.now.Add(5*24*time.Hour), 3*time.Hour, bob, "active")
	e.shift("Left event", true, "open", e.now.Add(7*24*time.Hour), 3*time.Hour, alice, "cancelled")
	e.shift("Old event", true, "open", e.now.Add(-45*24*time.Hour), 3*time.Hour, alice, "active")
	e.shift("Called off", true, "cancelled", e.now.Add(8*24*time.Hour), 3*time.Hour, alice, "active")

	link, err := service.Rotate(ctx, alice, nil)
	if err != nil {
		t.Fatal(err)
	}
	body, err := service.ICS(ctx, feedToken(t, link.URL))
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, want := range []string{
		"UID:urn:uuid:" + mine.timeslot.String(),
		"UID:urn:uuid:" + cancelled.timeslot.String(),
		"UID:urn:uuid:" + recent.timeslot.String(),
		"SUMMARY:Open day · Supervisor",
		"SUMMARY:Spring exhibition · Door",
		"LOCATION:Hall B",
		"SEQUENCE:4",
		"SUMMARY:Called off · Door",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("feed lacks %q", want)
		}
	}
	for _, unwanted := range []string{
		longAgo.timeslot.String(), bobsDay.timeslot.String(), "Bob's workshop", "Left event", "Old event", "Test Person",
	} {
		if strings.Contains(text, unwanted) {
			t.Errorf("feed contains %q", unwanted)
		}
	}
	if got := strings.Count(text, "BEGIN:VEVENT"); got != 5 {
		t.Errorf("feed has %d events, want 5", got)
	}
	if got := strings.Count(text, "STATUS:CANCELLED"); got != 2 {
		t.Errorf("feed has %d cancelled events, want 2 (a cancelled open day and a cancelled shift)", got)
	}

	// Bob's feed holds Bob's items only.
	bobLink, err := service.Rotate(ctx, bob, nil)
	if err != nil {
		t.Fatal(err)
	}
	bobBody, err := service.ICS(ctx, feedToken(t, bobLink.URL))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(bobBody), mine.timeslot.String()) || !strings.Contains(string(bobBody), "Bob's workshop") ||
		strings.Count(string(bobBody), "BEGIN:VEVENT") != 2 {
		t.Errorf("bob's feed is wrong:\n%s", bobBody)
	}
}

func TestCalendarFeedLinksRotateExpireAndFollowTheAccount(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	service := e.feedService()
	alice := e.person("feed-rotate")

	if status, err := service.Get(ctx, alice); err != nil || status.Active || status.CreatedAt != nil {
		t.Fatalf("fresh status = %+v, %v", status, err)
	}
	first, err := service.Rotate(ctx, alice, nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.Rotate(ctx, alice, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.URL == second.URL {
		t.Fatal("rotating kept the same link")
	}
	expectAppCode(t, errOfBytes(service.ICS(ctx, feedToken(t, first.URL))), "not_found")
	if _, err := service.ICS(ctx, feedToken(t, second.URL)); err != nil {
		t.Fatal(err)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM calendar_feeds WHERE person_id=$1`, 1, alice.PersonID)
	// Only a digest is stored: neither token appears in the table or in the audit trail.
	for _, link := range []calendarfeed.Link{first, second} {
		token := feedToken(t, link.URL)
		assertCount(t, e.pool, `SELECT count(*) FROM calendar_feeds WHERE encode(token_digest,'escape') LIKE '%'||$1||'%'`, 0, token)
		assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE metadata::text LIKE '%'||$1||'%'`, 0, token)
	}
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='calendar_feed.created' AND resource_id=$1`, 1, alice.PersonID)
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='calendar_feed.rotated' AND resource_id=$1`, 1, alice.PersonID)

	// Last use is recorded coarsely: a second read within the hour keeps the first time.
	var firstUse, secondUse time.Time
	if err := e.pool.QueryRow(ctx, `SELECT last_used_at FROM calendar_feeds WHERE person_id=$1`, alice.PersonID).Scan(&firstUse); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ICS(ctx, feedToken(t, second.URL)); err != nil {
		t.Fatal(err)
	}
	if err := e.pool.QueryRow(ctx, `SELECT last_used_at FROM calendar_feeds WHERE person_id=$1`, alice.PersonID).Scan(&secondUse); err != nil || !secondUse.Equal(firstUse) {
		t.Fatalf("last use moved within the hour: %v -> %v (%v)", firstUse, secondUse, err)
	}
	e.exec(`UPDATE calendar_feeds SET last_used_at = now() - interval '2 hours' WHERE person_id=$1`, alice.PersonID)
	if _, err := service.ICS(ctx, feedToken(t, second.URL)); err != nil {
		t.Fatal(err)
	}
	if err := e.pool.QueryRow(ctx, `SELECT last_used_at FROM calendar_feeds WHERE person_id=$1`, alice.PersonID).Scan(&secondUse); err != nil || time.Since(secondUse) > time.Minute {
		t.Fatalf("last use did not refresh after two hours: %v (%v)", secondUse, err)
	}

	// A disabled account has no feed; enabling it again brings the same link back.
	e.exec(`UPDATE accounts SET status='disabled' WHERE id=$1`, alice.AccountID)
	expectAppCode(t, errOfBytes(service.ICS(ctx, feedToken(t, second.URL))), "not_found")
	e.exec(`UPDATE accounts SET status='enabled' WHERE id=$1`, alice.AccountID)

	// Revoking removes it, and a second revocation is a quiet no-op.
	if err := service.Revoke(ctx, alice, nil); err != nil {
		t.Fatal(err)
	}
	if err := service.Revoke(ctx, alice, nil); err != nil {
		t.Fatal(err)
	}
	expectAppCode(t, errOfBytes(service.ICS(ctx, feedToken(t, second.URL))), "not_found")
	expectAppCode(t, errOfBytes(service.ICS(ctx, strings.Repeat("x", 43))), "not_found")
	assertCount(t, e.pool, `SELECT count(*) FROM audit_events WHERE action='calendar_feed.revoked' AND resource_id=$1`, 1, alice.PersonID)

	// The feed goes with the person.
	if _, err := service.Rotate(ctx, alice, nil); err != nil {
		t.Fatal(err)
	}
	e.exec(`DELETE FROM people WHERE id=$1`, alice.PersonID)
	assertCount(t, e.pool, `SELECT count(*) FROM calendar_feeds`, 0)
}

func errOfBytes(_ []byte, err error) error { return err }

func TestCalendarFeedOverHTTP(t *testing.T) {
	e := newStaffingEnv(t)
	ctx := testContext(t)
	const (
		origin   = "http://makerspace.example.test"
		login    = "feed-owner@example.test"
		password = "Calendar subscription workshop password 17"
	)
	hash, err := security.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	e.exec(`UPDATE auth_identities SET identifier_display=$1, identifier_normalized=$1 WHERE account_id=$2`, login, e.master.AccountID)
	e.exec(`UPDATE password_credentials SET password_hash=$1
		WHERE auth_identity_id IN (SELECT id FROM auth_identities WHERE account_id=$2)`, hash, e.master.AccountID)
	baseURL, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		PublicBaseURL: baseURL, MakerspaceTimeZone: "Europe/Vienna", SessionCookieName: "makerspace_session",
		CSRFCookieName: "makerspace_csrf", SessionIdleTTL: 6 * time.Hour, SessionAbsoluteTTL: 72 * time.Hour,
		PasswordResetTTL: 30 * time.Minute,
	}
	handler, err := httpapi.NewHandler(e.pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	feedURL := server.URL + "/api/v1/me/calendar-feed"

	anonymous := newCookieClient(t)
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		response := doJSON(t, anonymous, method, feedURL, origin, "", nil)
		assertStatus(t, response, http.StatusUnauthorized)
		response.Body.Close()
	}

	client := newCookieClient(t)
	response := doJSON(t, client, http.MethodPost, server.URL+"/api/v1/auth/login", origin, "", map[string]any{
		"email": login, "password": password,
	})
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	csrf := cookieValue(t, client, server.URL, cfg.CSRFCookieName)

	response = doJSON(t, client, http.MethodGet, feedURL, "", "", nil)
	assertStatus(t, response, http.StatusOK)
	var status openapi.CalendarFeedStatus
	decodeResponse(t, response, &status)
	if status.Active {
		t.Fatalf("fresh status = %+v", status)
	}
	// Unsafe methods need the CSRF header.
	response = doJSON(t, client, http.MethodPost, feedURL, origin, "", nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()

	response = doJSON(t, client, http.MethodPost, feedURL, origin, csrf, nil)
	assertStatus(t, response, http.StatusCreated)
	assertNoStoreAndRequestID(t, response)
	var issued openapi.CalendarFeedLink
	decodeResponse(t, response, &issued)
	if !strings.HasPrefix(issued.Url, origin+"/api/v1/calendar/") || !strings.HasSuffix(issued.Url, ".ics") {
		t.Fatalf("issued link has an unexpected shape (%d characters)", len(issued.Url))
	}
	response = doJSON(t, client, http.MethodGet, feedURL, "", "", nil)
	assertStatus(t, response, http.StatusOK)
	status = openapi.CalendarFeedStatus{}
	decodeResponse(t, response, &status)
	if !status.Active || status.CreatedAt.IsNull() || !status.LastUsedAt.IsNull() {
		t.Fatalf("status = %+v", status)
	}

	// The master owns one open day and one shift; the feed needs no session.
	personID := e.master.PersonID
	day := e.openDay(e.now.Add(48*time.Hour), 2*time.Hour, 2, 0)
	e.join(day, day.supervisorRequirement, authorization.Principal{PersonID: personID})
	e.shift("Open lab night", true, "open", e.now.Add(72*time.Hour), time.Hour, authorization.Principal{PersonID: personID}, "active")
	publicURL := server.URL + strings.TrimPrefix(issued.Url, origin)
	read := func(client *http.Client, address string) *http.Response {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	response = read(anonymous, publicURL)
	assertStatus(t, response, http.StatusOK)
	assertNoStoreAndRequestID(t, response)
	if contentType := response.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "text/calendar") {
		t.Fatalf("content type = %q", contentType)
	}
	content := string(readResponse(t, response))
	if !strings.Contains(content, "UID:urn:uuid:"+day.timeslot.String()) || !strings.Contains(content, "Open lab night") {
		t.Fatalf("feed lacks the owner's items:\n%s", content)
	}

	// Rotating invalidates the old link at once; unknown tokens and malformed ones never reveal anything.
	response = doJSON(t, client, http.MethodPost, feedURL, origin, csrf, nil)
	assertStatus(t, response, http.StatusCreated)
	var rotated openapi.CalendarFeedLink
	decodeResponse(t, response, &rotated)
	response = read(anonymous, publicURL)
	assertStatus(t, response, http.StatusNotFound)
	assertNoStoreAndRequestID(t, response)
	response.Body.Close()
	newURL := server.URL + strings.TrimPrefix(rotated.Url, origin)
	response = read(anonymous, newURL)
	assertStatus(t, response, http.StatusOK)
	response.Body.Close()
	response = read(anonymous, server.URL+"/api/v1/calendar/"+strings.Repeat("A", 43)+".ics")
	assertStatus(t, response, http.StatusNotFound)
	response.Body.Close()
	response = read(anonymous, server.URL+"/api/v1/calendar/short.ics")
	assertStatus(t, response, http.StatusBadRequest)
	response.Body.Close()

	response = doJSON(t, client, http.MethodDelete, feedURL, origin, csrf, nil)
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	response = read(anonymous, newURL)
	assertStatus(t, response, http.StatusNotFound)
	response.Body.Close()
	response = doJSON(t, client, http.MethodGet, feedURL, "", "", nil)
	assertStatus(t, response, http.StatusOK)
	status = openapi.CalendarFeedStatus{}
	decodeResponse(t, response, &status)
	if status.Active {
		t.Fatalf("status after revoking = %+v", status)
	}
}
