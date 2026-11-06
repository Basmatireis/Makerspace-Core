// Package inbox owns the in-app notifications shown in the application header: each account's own
// notifications, manual messages sent to roles, and the e-mail delivery job for queued notification
// mail. System events are raised by notifyrules, whose rules decide who is told what. It is unrelated
// to the mail and SMS messages composed by package notifications.
package inbox
