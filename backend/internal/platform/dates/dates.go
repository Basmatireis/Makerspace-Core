// Package dates holds helpers for calendar-date columns.
package dates

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// TodayUTC is the current UTC calendar day, used for columns the application sets explicitly on creation.
func TodayUTC() pgtype.Date { return FromTime(time.Now()) }

// FromTime keeps only the UTC calendar day of value.
func FromTime(value time.Time) pgtype.Date {
	value = value.UTC()
	return pgtype.Date{Time: time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC), Valid: true}
}
