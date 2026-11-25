package printerconnector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func TestStorageWatchdogReportsAPassThatDoesNotEndOnce(t *testing.T) {
	t.Parallel()
	watchdog := newStorageWatchdog(time.Minute)
	start := time.Now()
	if watchdog.stalled(start.Add(time.Hour)) {
		t.Fatal("no pass is running, nothing can stall")
	}
	watchdog.passStarted()
	if watchdog.stalled(time.Now().Add(30 * time.Second)) {
		t.Fatal("a pass shorter than the limit was reported")
	}
	if !watchdog.stalled(time.Now().Add(2 * time.Minute)) {
		t.Fatal("a pass longer than the limit was not reported")
	}
	if watchdog.stalled(time.Now().Add(3 * time.Minute)) {
		t.Fatal("the same stalled pass was reported twice")
	}
	if !watchdog.passEnded() {
		t.Fatal("the worker was not told that its pass had been reported")
	}
	watchdog.passStarted()
	if watchdog.passEnded() {
		t.Fatal("a normal pass was treated as reported")
	}
}

func TestHangingStorageDegradesTheAssignmentAndRecovers(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store := openTestStore(t)
	release := make(chan struct{})
	adapter := &bambuH2DAdapter{
		kind:                 AdapterBambuH2D,
		assignmentID:         ids.New(),
		configurationVersion: 1,
		store:                store,
		features:             staticFeatures{value: &RecordingFeatures{TimelapseEnabled: true}},
		stallAfter:           50 * time.Millisecond,
		newFTPS: func(ctx context.Context) (bambuFTPS, error) {
			select {
			case <-release:
				return &fakeFTPS{files: map[string][]byte{}}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
	}
	runID := ids.New()
	active := Observation{Kind: ObservationOperationalState, RunID: &runID, Payload: json.RawMessage(`{}`)}
	if err := adapter.noteRunsForRecordings(ctx, []Observation{active}); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 1)
	go adapter.runArtifactRetrievals(ctx, results)
	select {
	case err := <-results:
		if !errors.Is(err, errStorageWorkerStalled) || classifyAdapterError(err) != "storage_worker_stalled" {
			t.Fatalf("expected the stalled worker to be reported, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a hanging printer storage was never reported")
	}
	close(release)
	select {
	case err := <-results:
		if err != nil {
			t.Fatalf("expected recovery after the pass ended, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("recovery was never reported")
	}
}

func TestUnreachableTimelapseStorageDegradesTheAssignment(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestStore(t)
	adapter := &bambuH2DAdapter{
		kind:                 AdapterBambuH2D,
		assignmentID:         ids.New(),
		configurationVersion: 1,
		store:                store,
		features:             staticFeatures{value: &RecordingFeatures{TimelapseEnabled: true}},
		newFTPS: func(context.Context) (bambuFTPS, error) {
			return nil, fmt.Errorf("negotiate Bambu FTPS control TLS: read tcp 10.0.0.2:990: i/o timeout")
		},
	}
	runID := ids.New()
	active := Observation{Kind: ObservationOperationalState, RunID: &runID, Payload: json.RawMessage(`{}`)}
	if err := adapter.noteRunsForRecordings(ctx, []Observation{active}); err != nil {
		t.Fatal(err)
	}
	err := adapter.processTimelapses(ctx)
	var storageErr *timelapseStorageError
	if !errors.As(err, &storageErr) || classifyAdapterError(storageErr.err) != "ftps_timeout" {
		t.Fatalf("expected an unreachable storage with ftps_timeout, got %v", err)
	}
}

func TestFTPSTimeoutsAreClassifiedAsTimeouts(t *testing.T) {
	t.Parallel()
	for _, message := range []string{
		"negotiate Bambu FTPS control TLS: read tcp 10.0.0.2:990: i/o timeout",
		"read Bambu FTPS greeting: read tcp 10.0.0.2:990: i/o timeout",
		"read Bambu FTPS data: read tcp 10.0.0.2:2024: i/o timeout",
		"enter Bambu FTPS passive mode: read tcp 10.0.0.2:990: i/o timeout",
	} {
		if code := classifyAdapterError(errors.New(message)); code != "ftps_timeout" {
			t.Errorf("%q classified as %s", message, code)
		}
	}
}
