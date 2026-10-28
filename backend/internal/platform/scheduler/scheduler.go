// Package scheduler runs the API process's periodic jobs: one goroutine per
// job, a database advisory lock per run so several API replicas never execute
// the same job at once, and privacy-minimised logging (counts, never record
// data). Modules register jobs at startup; a job whose Enabled predicate says
// no is skipped on that tick, which is how a disabled module or a switched-off
// feature keeps its background work quiet without a restart.
package scheduler

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"log/slog"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Summary counts what one run changed, for the log line.
type Summary map[string]int

// Job is a periodic unit of work.
type Job struct {
	// ID is stable and lower snake case with dots, for example "privacy.retention".
	ID       string
	Interval time.Duration
	// RunAtStart runs the job once right after the scheduler starts.
	RunAtStart bool
	// Enabled is consulted before every run; nil means always. It may also
	// shorten or lengthen the interval for the next tick (zero keeps Interval).
	Enabled func(ctx context.Context) (enabled bool, interval time.Duration, err error)
	Run     func(ctx context.Context) (Summary, error)
}

// Scheduler owns the registered jobs.
type Scheduler struct {
	pool   *pgxpool.Pool
	logger *slog.Logger
	jobs   []Job
}

// New creates an empty scheduler.
func New(pool *pgxpool.Pool, logger *slog.Logger) *Scheduler {
	if logger == nil {
		logger = slog.Default()
	}
	return &Scheduler{pool: pool, logger: logger}
}

// Add registers a job. It panics on a duplicate id or a non-positive interval,
// which are programming errors caught at startup.
func (s *Scheduler) Add(job Job) {
	if job.ID == "" || job.Interval <= 0 || job.Run == nil {
		panic(fmt.Sprintf("scheduler: job %q needs an id, a positive interval and a run function", job.ID))
	}
	for _, existing := range s.jobs {
		if existing.ID == job.ID {
			panic(fmt.Sprintf("scheduler: job %q registered twice", job.ID))
		}
	}
	s.jobs = append(s.jobs, job)
}

// Jobs lists the registered job ids.
func (s *Scheduler) Jobs() []string {
	ids := make([]string, 0, len(s.jobs))
	for _, job := range s.jobs {
		ids = append(ids, job.ID)
	}
	sort.Strings(ids)
	return ids
}

// Run starts every job and blocks until ctx is cancelled and all jobs returned.
func (s *Scheduler) Run(ctx context.Context) {
	done := make(chan struct{}, len(s.jobs))
	for _, job := range s.jobs {
		go func(job Job) {
			defer func() { done <- struct{}{} }()
			s.loop(ctx, job)
		}(job)
	}
	for range s.jobs {
		<-done
	}
}

func (s *Scheduler) loop(ctx context.Context, job Job) {
	interval := job.Interval
	if job.RunAtStart {
		interval = s.tick(ctx, job, interval)
	}
	for {
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			interval = s.tick(ctx, job, interval)
		}
	}
}

// tick runs the job once when it is enabled and no other replica holds its
// lock, and returns the interval until the next tick.
func (s *Scheduler) tick(ctx context.Context, job Job, interval time.Duration) time.Duration {
	if job.Enabled != nil {
		enabled, next, err := job.Enabled(ctx)
		if err != nil {
			s.logError(ctx, job, "job precondition failed", err)
			return interval
		}
		if next > 0 {
			interval = next
		}
		if !enabled {
			return interval
		}
	}
	summary, err := s.runLocked(ctx, job)
	switch {
	case errors.Is(err, errLocked):
	case err != nil:
		s.logError(ctx, job, "job failed", err)
	case len(summary) > 0:
		attributes := []any{"job", job.ID}
		for _, key := range sortedKeys(summary) {
			attributes = append(attributes, key, summary[key])
		}
		s.logger.Info("scheduled job ran", attributes...)
	}
	return interval
}

var errLocked = errors.New("scheduler: job locked by another replica")

// runLocked holds a transaction-scoped advisory lock for the duration of the
// run. The lock lives on its own connection so the job's own transactions are
// unaffected; pg_try_advisory_xact_lock never blocks, so a busy replica skips.
func (s *Scheduler) runLocked(ctx context.Context, job Job) (Summary, error) {
	if s.pool == nil {
		return job.Run(ctx)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var locked bool
	if err := tx.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock($1)", LockKey(job.ID)).Scan(&locked); err != nil {
		return nil, err
	}
	if !locked {
		return nil, errLocked
	}
	return job.Run(ctx)
}

// LockKey derives the advisory lock key of a job id.
func LockKey(id string) int64 {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte("scheduler:" + id))
	return int64(hash.Sum64()) //nolint:gosec // a lock key, wrapping is fine
}

func (s *Scheduler) logError(ctx context.Context, job Job, message string, err error) {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) {
		return
	}
	s.logger.Error(message, "job", job.ID, "error_type", fmt.Sprintf("%T", err))
}

func sortedKeys(summary Summary) []string {
	keys := make([]string, 0, len(summary))
	for key := range summary {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
