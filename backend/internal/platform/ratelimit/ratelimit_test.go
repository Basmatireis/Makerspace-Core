package ratelimit

import (
	"fmt"
	"testing"
	"time"
)

func TestLimiter(t *testing.T) {
	limiter := New(2, time.Minute)
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	if !limiter.Take("a", now) || !limiter.Take("a", now) || limiter.Take("a", now) {
		t.Fatal("limit of two was not enforced")
	}
	if !limiter.Take("b", now) {
		t.Fatal("limits must be per key")
	}
	if !limiter.Take("a", now.Add(2*time.Minute)) {
		t.Fatal("the window did not slide")
	}
	failures := New(1, time.Minute)
	if failures.Blocked("x", now) {
		t.Fatal("blocked before any failure")
	}
	failures.Take("x", now)
	if !failures.Blocked("x", now) || failures.Blocked("x", now.Add(2*time.Minute)) {
		t.Fatal("blocked() does not follow taken attempts")
	}
	failures.Refund("x", now)
	if failures.Blocked("x", now) {
		t.Fatal("refund did not give the attempt back")
	}
}

func TestLimiterManyKeysDoesNotRecurseAndFailsClosed(t *testing.T) {
	limiter := New(10, time.Hour)
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	admitted := 0
	for index := 0; index < 6000; index++ {
		if limiter.Take(fmt.Sprintf("key-%d", index), now) {
			admitted++
		}
	}
	if admitted != maxLimiterKeys || len(limiter.entries) != maxLimiterKeys {
		t.Fatalf("admitted %d keys, table has %d, want %d", admitted, len(limiter.entries), maxLimiterKeys)
	}
	if !limiter.Take("key-0", now) {
		t.Fatal("an already tracked key must keep working at the cap")
	}
	if !limiter.Blocked("brand-new", now) {
		t.Fatal("a new key must be refused while the table is full")
	}
	later := now.Add(2 * time.Hour)
	if !limiter.Take("brand-new", later) || len(limiter.entries) != 1 {
		t.Fatalf("expired keys were not swept (entries=%d)", len(limiter.entries))
	}
}

func TestKeyForIP(t *testing.T) {
	cases := map[string]string{
		"203.0.113.9":                   "203.0.113.9",
		"::ffff:203.0.113.9":            "203.0.113.9",
		"2001:db8:1:2:aaaa:bbbb:cccc:1": "2001:db8:1:2::/64",
		"2001:db8:1:2:1111:2222:3333:4": "2001:db8:1:2::/64",
		"2001:db8:1:3::1":               "2001:db8:1:3::/64",
		"":                              "unknown",
		"garbage":                       "unknown",
	}
	for raw, want := range cases {
		if got := KeyForIP(raw); got != want {
			t.Errorf("KeyForIP(%q) = %q, want %q", raw, got, want)
		}
	}
}
