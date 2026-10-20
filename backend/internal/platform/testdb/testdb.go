// Package testdb provides isolated, fully migrated PostgreSQL schemas for
// integration tests. It is imported from _test files only.
package testdb

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// heavyDDLLock serializes schema creation, migration and removal across test
// processes. Dropping or building a whole schema takes one lock per object, and
// several packages doing that at once exhaust PostgreSQL's shared lock table.
const heavyDDLLock = 7263530001

var (
	poolsMu sync.Mutex
	pools   = map[string]*pgxpool.Pool{}
)

// serialized runs fn while holding the cross-process DDL advisory lock.
func serialized(ctx context.Context, admin *pgxpool.Pool, fn func() error) error {
	conn, err := admin.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err = conn.Exec(ctx, "SELECT pg_advisory_lock($1)", int64(heavyDDLLock)); err != nil {
		return err
	}
	defer func() {
		unlock, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = conn.Exec(unlock, "SELECT pg_advisory_unlock($1)", int64(heavyDDLLock))
	}()
	return fn()
}

// Pool returns a pool bound to a fresh schema that has every migration applied.
// The schema is dropped on cleanup. The test is skipped when TEST_DATABASE_URL
// is unset. Repeated calls within one test return the same pool. Isolation keeps sequences and row counts independent of other
// packages running in parallel against the same database.
func Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	poolsMu.Lock()
	existing := pools[t.Name()]
	poolsMu.Unlock()
	if existing != nil {
		return existing
	}
	ctx := t.Context()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := "makerspace_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{schema}.Sanitize()
	if err = serialized(ctx, admin, func() error {
		_, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier)
		return err
	}); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		poolsMu.Lock()
		delete(pools, t.Name())
		poolsMu.Unlock()
		pool.Close()
		cleanup, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		_ = serialized(cleanup, admin, func() error {
			_, err := admin.Exec(cleanup, "DROP SCHEMA "+identifier+" CASCADE")
			return err
		})
		admin.Close()
	})

	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate testdb source")
	}
	paths, err := filepath.Glob(filepath.Join(filepath.Dir(file), "..", "..", "..", "migrations", "*.sql"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("locate migrations: %v", err)
	}
	sort.Strings(paths)
	if err = serialized(ctx, admin, func() error {
		for _, path := range paths {
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			up, _, found := strings.Cut(string(raw), "-- +goose Down")
			if !found {
				return fmt.Errorf("migration %s has no Goose Down section", filepath.Base(path))
			}
			if _, err = pool.Exec(ctx, up); err != nil {
				return fmt.Errorf("apply migration %s: %w", filepath.Base(path), err)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	poolsMu.Lock()
	pools[t.Name()] = pool
	poolsMu.Unlock()
	return pool
}
