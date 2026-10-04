package events

import "testing"

func TestSignupLimiterAppliesBothLimitsWithoutGrowingDeniedBuckets(t *testing.T) {
	t.Parallel()
	limiter := newSignupLimiter([]byte("test-key"))
	contact := "helper@example.test"
	for attempt := 0; attempt < 5; attempt++ {
		if !limiter.allow("192.0.2.1", "public-event", &contact) {
			t.Fatalf("attempt %d was unexpectedly denied", attempt+1)
		}
	}
	if limiter.allow("192.0.2.1", "public-event", &contact) {
		t.Fatal("sixth contact attempt was accepted")
	}
	for _, attempts := range limiter.attempts {
		if len(attempts) > 20 {
			t.Fatalf("denied attempts grew a bucket to %d entries", len(attempts))
		}
	}
}
