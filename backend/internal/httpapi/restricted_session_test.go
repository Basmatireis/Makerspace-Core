package httpapi

import (
	"context"
	"net/http"
	"slices"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/auth"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

// The operations a session restricted to notification settings may call are an authorization decision. They come
// from `x-restricted-session` in the contract; widening the set must change this test on purpose.
func TestNotificationSettingsSessionsReachOnlyTheirOperations(t *testing.T) {
	spec, err := openapi.GetSwagger()
	if err != nil {
		t.Fatal(err)
	}
	policy := newRoutePolicy(spec)
	var allowed []string
	for key, restriction := range policy.restrictedAllowed {
		if restriction != string(auth.RestrictionNotificationSettings) {
			t.Errorf("%s names the unknown restriction %q", key, restriction)
		}
		allowed = append(allowed, key)
	}
	slices.Sort(allowed)
	want := []string{
		routeKey(http.MethodGet, "/auth/me"),
		routeKey(http.MethodGet, "/me/notifications/settings"),
		routeKey(http.MethodPost, "/auth/activity"),
		routeKey(http.MethodPost, "/auth/logout"),
		routeKey(http.MethodPut, "/me/notifications/consents"),
		routeKey(http.MethodPut, "/me/notifications/feedback-at-checkout"),
		routeKey(http.MethodPut, "/me/notifications/rules/{ruleId}/preference"),
	}
	slices.Sort(want)
	if !slices.Equal(allowed, want) {
		t.Fatalf("restricted operations = %v, want %v", allowed, want)
	}
	for _, key := range allowed {
		if policy.sessionless[key] {
			t.Errorf("%s is public; a restriction marker there means nothing", key)
		}
	}

	ctx := context.WithValue(context.Background(), normalizedRouteContextKey, routeKey(http.MethodGet, "/people"))
	if policy.allowsRestriction(ctx, auth.RestrictionNotificationSettings) {
		t.Fatal("a restricted session may list people")
	}
	ctx = context.WithValue(context.Background(), normalizedRouteContextKey, "")
	if policy.allowsRestriction(ctx, auth.RestrictionNotificationSettings) {
		t.Fatal("a request that matches no operation must be refused")
	}
	ctx = context.WithValue(
		context.Background(), normalizedRouteContextKey, routeKey(http.MethodGet, "/me/notifications/settings"),
	)
	if !policy.allowsRestriction(ctx, auth.RestrictionNotificationSettings) {
		t.Fatal("a restricted session must read its notification settings")
	}
}

func TestOperationsAreMatchedOnThePathChiDispatches(t *testing.T) {
	request, err := http.NewRequestWithContext(
		context.Background(), http.MethodGet, "http://example.test/api/v1/people/a%2Fb/notification-settings", nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := routingPath(request); got != "/api/v1/people/a%2Fb/notification-settings" {
		t.Fatalf("escaped path = %q", got)
	}
	request.URL.RawPath = ""
	request.URL.Path = "/api/v1/me/notifications/settings"
	if got := routingPath(request); got != "/api/v1/me/notifications/settings" {
		t.Fatalf("plain path = %q", got)
	}
}
