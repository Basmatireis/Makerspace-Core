// Package ids generates the application's identifiers.
package ids

import "github.com/google/uuid"

// New returns a new UUIDv7. Identifiers are generated in application code, never by the
// database, so that their time order matches creation order.
func New() uuid.UUID {
	return uuid.Must(uuid.NewV7())
}
