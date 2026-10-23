// Package inbox owns the in-app notifications shown in the application header: each account's own
// notifications, manual messages sent to roles, and the Emitter that other features call inside
// their own transaction to notify people about system events. It is unrelated to the mail and SMS
// messages composed by package notifications.
package inbox
