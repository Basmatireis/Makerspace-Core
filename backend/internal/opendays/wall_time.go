package opendays

import (
	"fmt"
	"time"
)

// resolveWallTime requires exactly one instant for the supplied calendar fields.
// Check the adjacent zone intervals rather than letting time.Date normalize a
// spring gap or choose one of the two occurrences in an autumn overlap.
func (s *Service) resolveWallTime(wall time.Time) (time.Time, error) {
	naive := time.Date(wall.Year(), wall.Month(), wall.Day(), wall.Hour(), wall.Minute(), wall.Second(), wall.Nanosecond(), time.UTC)
	offsets := map[int]bool{}
	for cursor, limit := naive.Add(-48*time.Hour), naive.Add(48*time.Hour); !cursor.After(limit); {
		zoned := cursor.In(s.location)
		_, offset := zoned.Zone()
		offsets[offset] = true
		_, end := zoned.ZoneBounds()
		if end.IsZero() || !end.After(cursor) {
			break
		}
		cursor = end
	}
	var matches []time.Time
	for offset := range offsets {
		candidate := naive.Add(-time.Duration(offset) * time.Second)
		local := candidate.In(s.location)
		represented := time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), local.Minute(), local.Second(), local.Nanosecond(), time.UTC)
		if represented.Equal(naive) {
			matches = append(matches, candidate)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	reason := "does not exist"
	if len(matches) > 1 {
		reason = "is ambiguous"
	}
	return time.Time{}, validation(fmt.Sprintf("Local time %s %s in %s because of a clock change; choose a different time", naive.Format("2006-01-02 15:04"), reason, s.location))
}

func (s *Service) validateSlotInstant(instant time.Time) error {
	local := instant.In(s.location)
	_, suppliedOffset := instant.Zone()
	_, localOffset := local.Zone()
	// UTC is the canonical transport representation. A supplied local offset
	// must match the configured zone; otherwise a gap could be disguised as an
	// instant by retaining the pre-transition offset.
	if suppliedOffset != 0 && suppliedOffset != localOffset {
		return validation("The supplied local time offset does not match the makerspace timezone; choose a valid local time or send UTC")
	}
	_, err := s.resolveWallTime(local)
	return err
}
