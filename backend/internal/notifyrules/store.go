package notifyrules

import (
	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
)

// store is a connection or transaction with the notification queries. The queries are promoted, so code reads
// q.SomeQuery(...) as before; the connection stays reachable for the staffing reader that shares it.
type store struct {
	*notifyrulesdb.Queries
	db notifyrulesdb.DBTX
}

func newStore(db notifyrulesdb.DBTX) *store {
	return &store{Queries: notifyrulesdb.New(db), db: db}
}
