package notifyrules

import "github.com/google/uuid"

// IDKind names a table whose rows definitions point to.
type IDKind string

const (
	IDRoles    IDKind = "roles"
	IDPeople   IDKind = "people"
	IDDisplays IDKind = "displays"
	IDDevices  IDKind = "devices"
)

// Lookups answers the questions about stored data a definition's validation needs. The service implements it with
// queries; tests use a fake. Implementations may cache within one validation.
type Lookups interface {
	// OptionValues returns the values (row identifiers) of a database option set.
	OptionValues(source OptionSource) (map[string]struct{}, error)
	// ExistingIDs returns those of the identifiers that exist in the table.
	ExistingIDs(kind IDKind, ids []uuid.UUID) (map[uuid.UUID]struct{}, error)
}
