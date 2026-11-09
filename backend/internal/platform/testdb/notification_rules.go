package testdb

import (
	_ "embed"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed notification_rules.sql
var notificationRulesSQL string

// SeedNotificationRules creates the notification rules the application shipped before migration 00127, so tests of
// the features that raise system events can check who those events reach.
func SeedNotificationRules(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	conn, err := pool.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	// The script defines a pg_temp function, so it runs as one simple-protocol batch on one connection.
	if _, err := conn.Conn().PgConn().Exec(t.Context(), notificationRulesSQL).ReadAll(); err != nil {
		t.Fatalf("seed notification rules: %v", err)
	}
}
