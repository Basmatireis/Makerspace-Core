package database

import (
	"context"
	"strings"
	"testing"
)

func TestOpenDoesNotExposeMalformedDatabaseSecret(t *testing.T) {
	const secret = "highly-sensitive-database-password"
	_, err := Open(context.Background(), "postgres://user:"+secret+"%zz@localhost/database")
	if err == nil {
		t.Fatal("malformed database URL was accepted")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatal("database password was exposed in a parse error")
	}
}
