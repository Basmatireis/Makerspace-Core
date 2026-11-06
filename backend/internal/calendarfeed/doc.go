// Package calendarfeed serves a person's private calendar subscription: the open-day timeslots they hold and the
// event shifts they signed up for, as iCalendar behind a secret link. The link's token is shown once and only its
// digest is stored. Management is always scoped to the person of the session; reading needs only the token.
package calendarfeed
