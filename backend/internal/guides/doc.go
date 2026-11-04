// Package guides stores which in-app guided tours an account has completed or dismissed. Progress is a UI
// preference: it is always scoped to the account of the session, never to an id from the request, and its
// mutations write no audit events.
package guides
