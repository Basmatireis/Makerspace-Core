package scheduler

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

func TestJobsRunOnTheirIntervalAndHonourEnabled(t *testing.T) {
	s := New(nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	var runs, skipped atomic.Int32
	enabled := atomic.Bool{}
	enabled.Store(true)
	s.Add(Job{
		ID: "test.fast", Interval: 10 * time.Millisecond, RunAtStart: true,
		Enabled: func(context.Context) (bool, time.Duration, error) {
			if !enabled.Load() {
				skipped.Add(1)
			}
			return enabled.Load(), 0, nil
		},
		Run: func(context.Context) (Summary, error) { runs.Add(1); return Summary{"done": 1}, nil },
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	deadline := time.Now().Add(2 * time.Second)
	for runs.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if runs.Load() < 3 {
		t.Fatalf("job ran %d times", runs.Load())
	}
	enabled.Store(false)
	before := runs.Load()
	for skipped.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(30 * time.Millisecond)
	if runs.Load() > before+1 {
		t.Fatalf("job kept running while disabled: %d > %d", runs.Load(), before)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("scheduler did not stop")
	}
}

func TestAddRejectsDuplicatesAndInvalidJobs(t *testing.T) {
	s := New(nil, nil)
	s.Add(Job{ID: "a.b", Interval: time.Second, Run: func(context.Context) (Summary, error) { return nil, nil }})
	for name, job := range map[string]Job{
		"duplicate":   {ID: "a.b", Interval: time.Second, Run: func(context.Context) (Summary, error) { return nil, nil }},
		"no interval": {ID: "c.d", Run: func(context.Context) (Summary, error) { return nil, nil }},
		"no run":      {ID: "e.f", Interval: time.Second},
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("expected a panic")
				}
			}()
			s.Add(job)
		})
	}
	if ids := s.Jobs(); len(ids) != 1 || ids[0] != "a.b" {
		t.Fatalf("jobs = %v", ids)
	}
	if LockKey("privacy.retention") == LockKey("files.blob_gc") {
		t.Fatal("lock keys collide")
	}
}
