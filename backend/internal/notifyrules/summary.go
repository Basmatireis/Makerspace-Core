package notifyrules

import (
	"fmt"
	"strings"
)

// TriggerSummary is the plain-words "When" line of a rule: the trigger's label, the schedule in words or "When
// someone presses Run now", followed by " · For each <one>" (or " · Summary of <plural>") when the rule loops. The
// rules list and the person's notification settings show the same text.
func TriggerSummary(definition Definition) string {
	var text string
	switch definition.Trigger.Type {
	case TriggerManual:
		text = "When someone presses Run now"
	case TriggerSchedule:
		text = scheduleSummary(definition.Trigger.Schedule)
	default:
		text = definition.Trigger.Event
		if trigger, ok := LookupTrigger(definition.Trigger.Event); ok {
			text = trigger.Label
		}
	}
	if definition.Loop != nil {
		if collection, ok := LookupCollection(definition.Loop.Collection); ok {
			if definition.Loop.Mode == ModeEach {
				text += " · For each " + collection.One
			} else {
				text += " · Summary of " + collection.Plural
			}
		}
	}
	return text
}

func scheduleSummary(schedule *Schedule) string {
	if schedule == nil {
		return ""
	}
	at := ""
	if schedule.Time != "" {
		at = " at " + schedule.Time
	}
	hours := 0
	if schedule.Hours != nil {
		hours = *schedule.Hours
	}
	switch schedule.Repeat {
	case RepeatDaily:
		return "Every day" + at
	case RepeatWeekdays:
		return "Weekdays" + at
	case RepeatWeekly:
		days := make([]string, 0, len(schedule.Weekdays))
		for _, day := range schedule.Weekdays {
			if day != "" {
				days = append(days, strings.ToUpper(day[:1])+day[1:])
			}
		}
		list := "(no day)"
		if len(days) > 0 {
			list = strings.Join(days, ", ")
		}
		return "Every " + list + at
	case RepeatMonthly:
		day := schedule.DayOfMonth
		if day == 0 {
			day = 1
		}
		return fmt.Sprintf("Monthly on day %d%s", day, at)
	case RepeatBeforeOpenDay:
		return fmt.Sprintf("%d h before each open day", hours)
	case RepeatAfterOpenDay:
		return fmt.Sprintf("%d h after each open day", hours)
	default:
		return string(schedule.Repeat)
	}
}
