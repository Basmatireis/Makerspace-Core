package dates

import (
	"testing"
	"time"
)

func TestFromTimeKeepsUTCDay(t *testing.T) {
	vienna := time.FixedZone("CET", 3600)
	got := FromTime(time.Date(2026, time.March, 2, 0, 30, 0, 0, vienna))
	want := time.Date(2026, time.March, 1, 0, 0, 0, 0, time.UTC)
	if !got.Valid || !got.Time.Equal(want) {
		t.Fatalf("FromTime = %v, want %v", got.Time, want)
	}
}
