// Package testdb provides isolated, fully migrated PostgreSQL databases for
// integration tests. It is imported from _test files only.
package testdb

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
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

// templateLock serializes building the migrated template database across test
// processes, so concurrently started packages migrate it only once.
const templateLock = 7263530002

// templatePrefix names the template databases. The suffix is a digest of the
// migration files, so a changed migration builds a new template.
const templatePrefix = "makerspace_template_"

var (
	poolsMu sync.Mutex
	pools   = map[string]*pgxpool.Pool{}

	setupOnce sync.Once
	admin     *pgxpool.Pool
	template  string
	setupErr  error
)

// Pool returns a pool bound to a fresh database that has every migration applied.
// The database is dropped on cleanup. The test is skipped when TEST_DATABASE_URL
// is unset. Repeated calls within one test return the same pool. Isolation keeps sequences and row counts independent of other
// tests and of packages running in parallel against the same server.
func Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	poolsMu.Lock()
	existing := pools[t.Name()]
	poolsMu.Unlock()
	if existing != nil {
		return existing
	}
	pool := NewPool(t, pgx.QueryExecModeCacheStatement)
	poolsMu.Lock()
	pools[t.Name()] = pool
	poolsMu.Unlock()
	t.Cleanup(func() {
		poolsMu.Lock()
		delete(pools, t.Name())
		poolsMu.Unlock()
	})
	return pool
}

// NewPool returns a pool with the given query mode bound to a new database that
// has every migration applied, on every call. The database is a copy of a
// template migrated once per set of migration files and is dropped on cleanup.
// The test is skipped when TEST_DATABASE_URL is unset.
func NewPool(t *testing.T, mode pgx.QueryExecMode) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	setupOnce.Do(func() { admin, template, setupErr = setUp(databaseURL) })
	if setupErr != nil {
		t.Fatal(setupErr)
	}
	ctx := t.Context()
	name := "makerspace_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{name}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+identifier+" TEMPLATE "+pgx.Identifier{template}.Sanitize()); err != nil {
		t.Fatalf("create test database from template: %v", err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		_, _ = admin.Exec(cleanup, "DROP DATABASE IF EXISTS "+identifier+" WITH (FORCE)")
	})
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Database = name
	config.ConnConfig.DefaultQueryExecMode = mode
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// setUp opens the process-wide administrative pool and makes sure the template
// database for the current migration files exists.
func setUp(databaseURL string) (*pgxpool.Pool, string, error) {
	paths, err := migrationPaths()
	if err != nil {
		return nil, "", err
	}
	digest := sha256.New()
	for _, path := range paths {
		raw, err := os.ReadFile(path) //nolint:gosec // paths come from globbing the repository's own migration directory
		if err != nil {
			return nil, "", err
		}
		_, _ = fmt.Fprintf(digest, "%s\x00%d\x00", filepath.Base(path), len(raw))
		_, _ = digest.Write(raw)
	}
	name := templatePrefix + hex.EncodeToString(digest.Sum(nil))[:16]

	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		return nil, "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err = buildTemplate(ctx, pool, databaseURL, name, paths); err != nil {
		pool.Close()
		return nil, "", fmt.Errorf("build template database: %w", err)
	}
	return pool, name, nil
}

// buildTemplate creates and migrates the template database unless another
// process already finished it. Only a completely migrated database is marked as
// template, so a build interrupted halfway is discarded and repeated.
func buildTemplate(ctx context.Context, admin *pgxpool.Pool, databaseURL, name string, paths []string) error {
	conn, err := admin.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err = conn.Exec(ctx, "SELECT pg_advisory_lock($1)", int64(templateLock)); err != nil {
		return err
	}
	defer func() {
		unlock, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = conn.Exec(unlock, "SELECT pg_advisory_unlock($1)", int64(templateLock))
	}()

	var complete bool
	err = conn.QueryRow(ctx, "SELECT datistemplate FROM pg_database WHERE datname = $1", name).Scan(&complete)
	if err == nil && complete {
		return nil
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	identifier := pgx.Identifier{name}.Sanitize()

	// Templates of earlier migration sets are no longer used by anyone.
	rows, err := conn.Query(ctx, "SELECT datname FROM pg_database WHERE starts_with(datname, $1)", templatePrefix)
	if err != nil {
		return err
	}
	stale, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, database := range stale {
		quoted := pgx.Identifier{database}.Sanitize()
		if _, err = conn.Exec(ctx, "ALTER DATABASE "+quoted+" IS_TEMPLATE false"); err != nil {
			return err
		}
		if _, err = conn.Exec(ctx, "DROP DATABASE "+quoted+" WITH (FORCE)"); err != nil {
			return err
		}
	}

	if _, err = conn.Exec(ctx, "CREATE DATABASE "+identifier); err != nil {
		return err
	}
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return err
	}
	config.Database = name
	target, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return err
	}
	for _, path := range paths {
		raw, err := os.ReadFile(path) //nolint:gosec // paths come from globbing the repository's own migration directory
		if err != nil {
			_ = target.Close(ctx)
			return err
		}
		up, _, found := strings.Cut(string(raw), "-- +goose Down")
		if !found {
			_ = target.Close(ctx)
			return fmt.Errorf("migration %s has no Goose Down section", filepath.Base(path))
		}
		if _, err = target.Exec(ctx, up); err != nil {
			_ = target.Close(ctx)
			return fmt.Errorf("apply migration %s: %w", filepath.Base(path), err)
		}
	}
	// A template must have no open connections when it is copied.
	if err = target.Close(ctx); err != nil {
		return err
	}
	_, err = conn.Exec(ctx, "ALTER DATABASE "+identifier+" IS_TEMPLATE true")
	return err
}

func migrationPaths() ([]string, error) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return nil, errors.New("cannot locate testdb source")
	}
	paths, err := filepath.Glob(filepath.Join(filepath.Dir(file), "..", "..", "..", "migrations", "*.sql"))
	if err != nil {
		return nil, fmt.Errorf("locate migrations: %w", err)
	}
	if len(paths) == 0 {
		return nil, errors.New("locate migrations: no migration files found")
	}
	sort.Strings(paths)
	return paths, nil
}
