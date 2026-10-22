package signage

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Built-in announcement variables, in the order the admin UI lists them.
var builtInKeys = []string{"ends_at", "ends_on", "ends", "starts_at", "today", "display", "location"}

func isBuiltInKey(key string) bool {
	for _, builtIn := range builtInKeys {
		if builtIn == key {
			return true
		}
	}
	return false
}

// RenderField is the part of a template field the renderer needs.
type RenderField struct {
	Key  string
	Type FieldType
}

// RenderTemplate is the part of an announcement template the renderer needs. BodyFormat empty means
// plain.
type RenderTemplate struct {
	Fields      []RenderField
	Title, Body string
	BodyFormat  RichTextFormat
	BodyCSS     string
	Tone        Tone
}

// RenderTiming is the announcement window.
type RenderTiming struct {
	StartsAt time.Time
	EndsAt   *time.Time
}

// RenderContext carries everything outside the announcement itself. Times are formatted in
// TimeZone (the makerspace time zone). MachineNames maps a machine id (as text) to its name.
type RenderContext struct {
	Now          time.Time
	TimeZone     *time.Location
	DisplayName  string
	Location     string
	MachineNames map[string]string
}

// Rendered is the final message text. Placeholder values in Body are escaped for BodyFormat, so the
// browser can interpret the whole body as that format without a value injecting markup.
type Rendered struct {
	Title, Body, Tone string
	BodyFormat        RichTextFormat
	BodyCSS           string
}

var (
	placeholderPattern = regexp.MustCompile(`\{([A-Za-z0-9_]+)\}`)
	localValuePattern  = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$`)
	weekdayShort       = [...]string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}
	monthShort         = [...]string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}
)

func pad2(value int) string {
	if value < 10 {
		return "0" + strconv.Itoa(value)
	}
	return strconv.Itoa(value)
}

func formatTime(moment time.Time) string {
	return pad2(moment.Hour()) + ":" + pad2(moment.Minute())
}

func formatDate(moment time.Time) string {
	return weekdayShort[moment.Weekday()] + " " + strconv.Itoa(moment.Day()) + " " + monthShort[moment.Month()-1]
}

// calendarDay maps the calendar date of a wall-clock reading to UTC midnight, so day differences
// are exact across daylight-saving changes.
func calendarDay(moment time.Time) time.Time {
	year, month, day := moment.Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

func dayDifference(moment, now time.Time) int {
	return int(calendarDay(moment).Sub(calendarDay(now)).Hours() / 24)
}

// describeMoment returns "at 14:30" for today and "on Mon 21 Oct at 10:00" otherwise.
func describeMoment(moment, now time.Time) string {
	if dayDifference(moment, now) == 0 {
		return "at " + formatTime(moment)
	}
	return "on " + formatDate(moment) + " at " + formatTime(moment)
}

// parseLocal reads `YYYY-MM-DD[THH:MM]` as a wall-clock reading. Out-of-range parts roll over
// exactly like the JavaScript Date constructor; ok is false when the text has another shape.
func parseLocal(value string) (time.Time, bool) {
	match := localValuePattern.FindStringSubmatch(value)
	if match == nil {
		return time.Time{}, false
	}
	number := func(text string) int {
		parsed, _ := strconv.Atoi(text)
		return parsed
	}
	return time.Date(
		number(match[1]),
		time.Month(number(match[2])),
		number(match[3]),
		number(match[4]),
		number(match[5]),
		0,
		0,
		time.UTC,
	), true
}

func formatFieldValue(field RenderField, value string, now time.Time, machines map[string]string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	switch field.Type {
	case FieldDate:
		if date, ok := parseLocal(value); ok {
			return formatDate(date)
		}
	case FieldDateTime:
		date, ok := parseLocal(value)
		if !ok {
			return value
		}
		switch dayDifference(date, now) {
		case 0:
			return "today at " + formatTime(date)
		case 1:
			return "tomorrow at " + formatTime(date)
		default:
			return "on " + formatDate(date) + " at " + formatTime(date)
		}
	case FieldMachine:
		if name, ok := machines[value]; ok {
			return name
		}
	}
	return value
}

// PlaceholdersIn lists the keys of all `{placeholders}` in text, in order of appearance.
func PlaceholdersIn(text string) []string {
	matches := placeholderPattern.FindAllStringSubmatch(text, -1)
	keys := make([]string, 0, len(matches))
	for _, match := range matches {
		keys = append(keys, match[1])
	}
	return keys
}

// UnknownPlaceholders returns the sorted placeholders in title and body that are neither a field
// key nor a built-in variable.
func UnknownPlaceholders(fieldKeys []string, title, body string) []string {
	known := make(map[string]struct{}, len(fieldKeys)+len(builtInKeys))
	for _, key := range builtInKeys {
		known[key] = struct{}{}
	}
	for _, key := range fieldKeys {
		known[key] = struct{}{}
	}
	seen := map[string]struct{}{}
	unknown := []string{}
	for _, key := range append(PlaceholdersIn(title), PlaceholdersIn(body)...) {
		if _, ok := known[key]; ok {
			continue
		}
		if _, ok := seen[key]; !ok {
			seen[key] = struct{}{}
			unknown = append(unknown, key)
		}
	}
	sort.Strings(unknown)
	return unknown
}

// RenderAnnouncement fills a template. Missing optional values become empty and unknown
// placeholders stay visible as typed. Go is authoritative; the TypeScript copy in the admin
// preview runs the same vectors (api/testdata/signage-announcement-render.json).
func RenderAnnouncement(
	template RenderTemplate,
	values map[string]string,
	timing RenderTiming,
	context RenderContext,
) Rendered {
	zone := context.TimeZone
	if zone == nil {
		zone = time.UTC
	}
	now := context.Now.In(zone)
	startsAt := timing.StartsAt.In(zone)
	lookup := map[string]string{
		"ends_at":   "",
		"ends_on":   "",
		"ends":      "until further notice",
		"starts_at": formatTime(startsAt),
		"today":     formatDate(now),
		"display":   context.DisplayName,
		"location":  context.Location,
	}
	if timing.EndsAt != nil {
		endsAt := timing.EndsAt.In(zone)
		lookup["ends_at"], lookup["ends_on"], lookup["ends"] = formatTime(
			endsAt,
		), formatDate(
			endsAt,
		), describeMoment(
			endsAt,
			now,
		)
	}
	for _, field := range template.Fields {
		lookup[field.Key] = formatFieldValue(field, values[field.Key], now, context.MachineNames)
	}
	fill := func(text string, escape func(string) string) string {
		return placeholderPattern.ReplaceAllStringFunc(text, func(match string) string {
			if replacement, ok := lookup[match[1:len(match)-1]]; ok {
				return escape(replacement)
			}
			return match
		})
	}
	format := template.BodyFormat
	if format == "" {
		format = FormatPlain
	}
	return Rendered{
		Title:      fill(template.Title, func(value string) string { return value }),
		Body:       fill(template.Body, escaperFor(format)),
		Tone:       string(template.Tone),
		BodyFormat: format,
		BodyCSS:    template.BodyCSS,
	}
}

// markdownPunctuation is backslash-escaped in placeholder values of markdown bodies. Any ASCII punctuation
// character may be escaped in markdown; these are the ones that start inline or block constructs, links
// and autolinks.
const markdownPunctuation = "\\`*_{}[]()#+-.!|~=:"

func escaperFor(format RichTextFormat) func(string) string {
	switch format {
	case FormatHTML:
		return escapeHTML
	case FormatMarkdown:
		return escapeMarkdown
	default:
		return func(value string) string { return value }
	}
}

// escapeHTML escapes the characters that matter in HTML text and attribute values.
func escapeHTML(value string) string {
	var out strings.Builder
	for _, r := range value {
		switch r {
		case '&':
			out.WriteString("&amp;")
		case '<':
			out.WriteString("&lt;")
		case '>':
			out.WriteString("&gt;")
		case '"':
			out.WriteString("&quot;")
		case '\'':
			out.WriteString("&#39;")
		default:
			out.WriteRune(r)
		}
	}
	return out.String()
}

// escapeMarkdown makes a value literal in markdown: `&`, `<` and `>` become entities (so no raw HTML can
// appear) and markdown punctuation is backslash-escaped in the same pass, which keeps the entities intact.
func escapeMarkdown(value string) string {
	var out strings.Builder
	for _, r := range value {
		switch {
		case r == '&':
			out.WriteString("&amp;")
		case r == '<':
			out.WriteString("&lt;")
		case r == '>':
			out.WriteString("&gt;")
		case strings.ContainsRune(markdownPunctuation, r):
			out.WriteByte('\\')
			out.WriteRune(r)
		default:
			out.WriteRune(r)
		}
	}
	return out.String()
}
