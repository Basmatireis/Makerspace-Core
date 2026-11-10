package signage

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestEmbedLoadCounterCountsPerDayInBoundedMemory(t *testing.T) {
	counter := newEmbedLoadCounter()
	embed := uuid.New()
	evening := time.Date(2026, 11, 9, 23, 59, 0, 0, time.UTC)
	morning := evening.Add(2 * time.Minute)
	counter.record(embed, evening)
	counter.record(embed, evening.Add(time.Second))
	counter.record(embed, morning)
	if got := counter.today(embed, evening); got.count != 2 || !got.last.Equal(evening.Add(time.Second)) {
		t.Fatalf("evening loads = %+v", got)
	}
	if got := counter.today(embed, morning); got.count != 1 {
		t.Fatalf("morning loads = %+v", got)
	}
	taken := counter.take()
	if len(taken) != 2 || counter.today(embed, evening).count != 0 {
		t.Fatalf("taken = %v", taken)
	}
	// A failed write gives its loads back, merged with what arrived meanwhile.
	counter.record(embed, morning)
	counter.giveBack(taken)
	if got := counter.today(embed, morning); got.count != 2 {
		t.Fatalf("morning loads after give-back = %+v", got)
	}
	// The counter is bounded: new embeds beyond the cap are not counted, known ones still are.
	counter.take()
	for range maxPendingEmbedLoads {
		if !counter.record(uuid.New(), morning) {
			t.Fatal("a load below the cap was dropped")
		}
	}
	if counter.record(uuid.New(), morning) {
		t.Fatal("a load beyond the cap was counted")
	}
	if len(counter.take()) != maxPendingEmbedLoads {
		t.Fatal("the counter grew beyond its cap")
	}
}
