package staffing

import "time"

// ResolveSemester picks the semester for today from non-draft, non-archived periods: the one whose date range
// contains today (the latest start when several do), else the next upcoming one, else the most recent past one.
// today is a calendar date at UTC midnight. The result is nil when there is no candidate.
func ResolveSemester(candidates []Semester, today time.Time) *Semester {
	var current, upcoming, past *Semester
	for index := range candidates {
		candidate := &candidates[index]
		switch {
		case !candidate.StartsOn.After(today) && !candidate.EndsOn.Before(today):
			if current == nil || !candidate.StartsOn.Before(current.StartsOn) {
				current = candidate
			}
		case candidate.StartsOn.After(today):
			if upcoming == nil || candidate.StartsOn.Before(upcoming.StartsOn) {
				upcoming = candidate
			}
		default:
			if past == nil || !candidate.EndsOn.Before(past.EndsOn) {
				past = candidate
			}
		}
	}
	for _, found := range []*Semester{current, upcoming, past} {
		if found != nil {
			result := *found
			return &result
		}
	}
	return nil
}

// DateOf returns the calendar date of instant in location as a UTC-midnight time.
func DateOf(instant time.Time, location *time.Location) time.Time {
	local := instant.In(location)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
}
