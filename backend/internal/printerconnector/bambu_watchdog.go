package printerconnector

import (
	"context"
	"errors"
	"sync"
	"time"
)

// storageWorkerStallAfter is how long one pass of the retrieval worker (consumption,
// timelapse and archive lookups) may take before the assignment is reported as
// degraded. FTPS reads and writes time out after a minute without data, so a pass
// only runs this long when something below them hangs; large downloads that keep
// moving finish well within it.
const storageWorkerStallAfter = 20 * time.Minute

// errStorageWorkerStalled tells Core that print files and timelapses are not
// being fetched although the printer itself may still report over MQTT.
var errStorageWorkerStalled = errors.New("printer storage worker stalled")

func (a *bambuH2DAdapter) storageStallAfter() time.Duration {
	if a.stallAfter > 0 {
		return a.stallAfter
	}
	return storageWorkerStallAfter
}

// storageWatchdog notices a retrieval pass that does not end. The worker marks
// the start and end of each pass; the watchdog reports a pass running longer
// than stallAfter once, and the worker clears the report when the pass ends.
type storageWatchdog struct {
	stallAfter time.Duration
	mu         sync.Mutex
	started    time.Time
	running    bool
	reported   bool
}

func newStorageWatchdog(stallAfter time.Duration) *storageWatchdog {
	return &storageWatchdog{stallAfter: stallAfter}
}

func (w *storageWatchdog) passStarted() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.started, w.running = time.Now(), true
}

// passEnded returns true when the watchdog had reported this pass as stalled.
func (w *storageWatchdog) passEnded() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	reported := w.reported
	w.running, w.reported = false, false
	return reported
}

func (w *storageWatchdog) stalled(now time.Time) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.running || w.reported || now.Sub(w.started) < w.stallAfter {
		return false
	}
	w.reported = true
	return true
}

func (w *storageWatchdog) watch(ctx context.Context, send func(error) bool) {
	interval := min(w.stallAfter/4, time.Minute)
	ticker := time.NewTicker(max(interval, 10*time.Millisecond))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			if w.stalled(now) && !send(errStorageWorkerStalled) {
				return
			}
		}
	}
}
