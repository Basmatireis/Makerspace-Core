package integration_test

import (
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Tests that are not about second factors sign masters in with a password. Masters need a strong_mfa session for
// their universal permissions, so these helpers stand in for the second-factor step of such a login.
var testPools sync.Map

func registerTestPool(t *testing.T, pool *pgxpool.Pool) {
	testPools.Store(t.Name(), pool)
	t.Cleanup(func() { testPools.Delete(t.Name()) })
}

var masterElevationDisabled sync.Map

// disableMasterElevation keeps password logins of the test as they are, for tests about second factors.
func disableMasterElevation(t *testing.T) {
	masterElevationDisabled.Store(t.Name(), true)
	t.Cleanup(func() { masterElevationDisabled.Delete(t.Name()) })
}

// testPool finds the pool registered by the test or one of its parents.
func testPool(t *testing.T) *pgxpool.Pool {
	name := t.Name()
	if _, disabled := masterElevationDisabled.Load(name); disabled {
		return nil
	}
	for {
		if value, ok := testPools.Load(name); ok {
			pool, _ := value.(*pgxpool.Pool)
			return pool
		}
		index := strings.LastIndex(name, "/")
		if index < 0 {
			return nil
		}
		name = name[:index]
	}
}

// elevateMasterSessions marks the live sessions of master accounts as a fresh multi-factor sign-in.
func elevateMasterSessions(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(testContext(t), `
		UPDATE sessions SET base_assurance='strong_mfa', current_assurance='strong_mfa',
			authenticated_assurance='strong_mfa', authenticated_at=now(), assurance_expires_at=NULL,
			mfa_setup_required=false
		WHERE revoked_at IS NULL AND account_id IN (
			SELECT a.id FROM accounts a JOIN person_roles pr ON pr.person_id=a.person_id
			JOIN roles r ON r.id=pr.role_id WHERE r.system_key='master')`); err != nil {
		t.Fatal(err)
	}
}
