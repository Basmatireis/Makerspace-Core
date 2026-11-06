package notifyrules

import (
	"slices"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
)

// FieldType decides which operators a condition on the field may use and what its value looks like.
type FieldType string

const (
	// FieldEnum is one of a fixed set of values (operators is, not, any, none).
	FieldEnum FieldType = "enum"
	// FieldOrdered is an enum whose options are ordered from low to high (gte, lte, is, not).
	FieldOrdered FieldType = "ordered"
	// FieldNumber is a number (gt, gte, lt, lte, eq, between).
	FieldNumber FieldType = "number"
	// FieldText is free text (contains, notcontains, eq, starts, empty, notempty).
	FieldText FieldType = "text"
	// FieldBool is a yes/no fact (yes, no).
	FieldBool FieldType = "bool"
	// FieldList is a set of values the field holds (includes, excludes).
	FieldList FieldType = "list"
)

// OptionSource names a set of options that lives in the database. The service resolves it when it serves the catalog
// and when it validates a definition; the registry itself stays static.
type OptionSource string

const (
	SourceMachines      OptionSource = "machines"
	SourcePrinters      OptionSource = "printers"
	SourceRoles         OptionSource = "roles"
	SourceTrainings     OptionSource = "trainings"
	SourceProcesses     OptionSource = "processes"
	SourceFilamentTypes OptionSource = "filament_types"
	SourceMaterialTypes OptionSource = "material_types"
)

// Option is one value of an enum, ordered or list field. Dynamic options use the row's identifier as value.
type Option struct {
	Value string
	Label string
}

// Field is a value a condition may look at.
type Field struct {
	// Key is the bare key; the context adds its prefix (e., i., r., n.) in conditions.
	Key   string
	Label string
	Type  FieldType
	// Options lists the fixed values of enum, ordered and list fields; OptionsFrom replaces it for database options.
	Options     []Option
	OptionsFrom OptionSource
	Unit        string
	// Permission, when set, is needed to see the field in the editor and to use it in a personal rule.
	Permission authorization.Permission
}

// Choice is a recipient, resolution or throttle subject a trigger offers.
type Choice struct {
	Key   string
	Label string
}

// Placeholder is a {key} the trigger fills into titles and bodies.
type Placeholder struct {
	Key     string
	Label   string
	Example string
}

// Subject says whom an event concerns, which decides who a personal rule may match.
type Subject string

const (
	// SubjectLab events concern the makerspace as a whole; anyone allowed to see their data may subscribe.
	SubjectLab Subject = "lab"
	// SubjectSelf events concern one person (the recipient key "self"); a personal rule only fires for that person.
	SubjectSelf Subject = "self"
)

// Trigger is an event feature code can emit, with everything the editor and the validator need to know about it.
type Trigger struct {
	Key  string
	Area string
	// Label is phrased as the sentence the rule starts with ("A printer reports an error").
	Label string
	Help  string
	// Subject decides which personal rules an event reaches.
	Subject Subject
	// Permission is needed to see the trigger and its data in a personal rule; empty means any staff session.
	Permission       authorization.Permission
	Fields           []Field
	Recipients       []Choice
	Placeholders     []Placeholder
	Resolutions      []Choice
	ThrottleSubjects []Choice
}

// Collection is a set of things a rule can loop over.
type Collection struct {
	Key   string
	Label string
	// One and Plural name the items in sentences.
	One    string
	Plural string
	// PlaceholderPrefix prefixes the item fields in placeholders ({person.unpaid}).
	PlaceholderPrefix string
	// Permission is needed to loop over the collection in a personal rule.
	Permission authorization.Permission
	Fields     []Field
	// Recipients are the people an item points to, offered as "item:<key>" in each-mode loops.
	Recipients []Choice
}

// Condition context prefixes. A condition's field is the prefix, a dot and the field's key.
const (
	PrefixEvent     = "e"
	PrefixItem      = "i"
	PrefixSummary   = "s"
	PrefixRecipient = "r"
	PrefixNow       = "n"
)

// Generic resolutions every rule offers, and the one a rule looping over items adds.
const (
	ResolutionOpened              = "opened"
	ResolutionAcknowledged        = "acknowledged"
	ResolutionSeen                = "seen"
	ResolutionItemNoLongerMatches = "item_no_longer_matches"
)

// GenericResolutions are the escalation stop conditions available for every rule.
func GenericResolutions() []Choice {
	return []Choice{
		{ResolutionOpened, "Someone opens the notification"},
		{ResolutionAcknowledged, "Someone acknowledges it"},
		{ResolutionSeen, "Someone has seen it"},
	}
}

// RecipientRole is the dynamic recipient key a trigger offers with this label.
func (t Trigger) recipientKeys() []string {
	keys := make([]string, 0, len(t.Recipients))
	for _, choice := range t.Recipients {
		keys = append(keys, choice.Key)
	}
	return keys
}

func (t Trigger) hasRecipient(key string) bool {
	return slices.Contains(t.recipientKeys(), key)
}

func (c Collection) hasRecipient(key string) bool {
	for _, choice := range c.Recipients {
		if choice.Key == key {
			return true
		}
	}
	return false
}

// Field returns the collection's field with the given bare key.
func (c Collection) Field(key string) (Field, bool) {
	return findField(c.Fields, key)
}

func findField(fields []Field, key string) (Field, bool) {
	for _, field := range fields {
		if field.Key == key {
			return field, true
		}
	}
	return Field{}, false
}

// Field returns the trigger's field with the given bare key.
func (t Trigger) Field(key string) (Field, bool) {
	return findField(t.Fields, key)
}

// Options builds an option list from alternating value and label arguments.
func options(pairs ...string) []Option {
	result := make([]Option, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		result = append(result, Option{Value: pairs[i], Label: pairs[i+1]})
	}
	return result
}

// Weekdays are the keys schedules and weekday fields use.
var weekdays = []string{"mon", "tue", "wed", "thu", "fri", "sat", "sun"}

var weekdayOptions = options("mon", "Mon", "tue", "Tue", "wed", "Wed", "thu", "Thu", "fri", "Fri", "sat", "Sat", "sun", "Sun")

var membershipOptions = options("supervisor", "Supervisor", "trainee", "Trainee", "visitor", "Visitor")

func triggerSubjects(keys ...string) []Choice {
	choices := make([]Choice, 0, len(keys)/2)
	for i := 0; i+1 < len(keys); i += 2 {
		choices = append(choices, Choice{Key: keys[i], Label: keys[i+1]})
	}
	return choices
}

// Triggers returns every event a rule can start from, grouped by area in display order. Each one has a real event
// source in feature code; a trigger is added together with the code that emits it, never ahead of it.
func Triggers() []Trigger {
	return slices.Clone(triggers)
}

// LookupTrigger returns the trigger with the key.
func LookupTrigger(key string) (Trigger, bool) {
	for _, trigger := range triggers {
		if trigger.Key == key {
			return trigger, true
		}
	}
	return Trigger{}, false
}

// Collections returns every collection a rule can loop over.
func Collections() []Collection {
	return slices.Clone(collections)
}

// LookupCollection returns the collection with the key.
func LookupCollection(key string) (Collection, bool) {
	for _, collection := range collections {
		if collection.Key == key {
			return collection, true
		}
	}
	return Collection{}, false
}

// RecipientFields are the facts about each recipient that conditions may test (prefix r.); in a personal rule they
// describe the owner.
func RecipientFields() []Field { return slices.Clone(recipientFields) }

// NowFields are the facts about the moment of evaluation (prefix n.).
func NowFields() []Field { return slices.Clone(nowFields) }

// OpenDayFields are the facts about the open day a before/after-open-day schedule is looking at (prefix e.). The
// "mine" field exists for personal rules only.
func OpenDayFields(personal bool) []Field {
	fields := slices.Clone(openDayFields)
	if personal {
		fields = append(fields, Field{Key: "mine", Label: "You're signed up for it", Type: FieldBool})
	}
	return fields
}

// OpenDayPlaceholders are the placeholders of a rule that runs before or after each open day.
func OpenDayPlaceholders() []Placeholder { return slices.Clone(openDayPlaceholders) }

// OpenDayRecipients are the recipients a rule that runs before or after each open day offers.
func OpenDayRecipients() []Choice { return slices.Clone(openDayRecipients) }

// SummaryFields are the fields a summary-mode loop over the collection offers (prefix s.): the number of matching
// items, the total of every money field and the highest value of every duration field.
func SummaryFields(collection Collection) []Field {
	fields := []Field{{Key: "count", Label: "Matching " + collection.Plural, Type: FieldNumber}}
	for _, field := range collection.Fields {
		if field.Type == FieldNumber && field.Unit == "€" {
			fields = append(fields, Field{
				Key: "sum." + field.Key, Label: "Total " + lowerFirst(field.Label), Type: FieldNumber, Unit: field.Unit,
			})
		}
	}
	for _, field := range collection.Fields {
		if field.Type == FieldNumber && (field.Unit == "days" || field.Unit == "h") {
			fields = append(fields, Field{
				Key: "max." + field.Key, Label: "Highest " + lowerFirst(field.Label), Type: FieldNumber, Unit: field.Unit,
			})
		}
	}
	return fields
}

func lowerFirst(text string) string {
	if text == "" {
		return text
	}
	return strings.ToLower(text[:1]) + text[1:]
}

var recipientFields = []Field{
	{Key: "openDays", Label: "Open days this period", Type: FieldNumber},
	{Key: "minimum", Label: "Semester minimum", Type: FieldNumber},
	{Key: "belowMinimum", Label: "Below the semester minimum", Type: FieldBool},
	{Key: "signedUpNext14", Label: "Signed up for an open day in the next 14 days", Type: FieldBool},
	{Key: "unpaid", Label: "Unpaid amount", Type: FieldNumber, Unit: "€"},
	{Key: "systemRole", Label: "System role", Type: FieldEnum, Options: membershipOptions},
	{Key: "roles", Label: "Roles", Type: FieldList, OptionsFrom: SourceRoles},
	{Key: "checkedIn", Label: "Checked in right now", Type: FieldBool},
	{Key: "lastVisit", Label: "Days since last visit", Type: FieldNumber, Unit: "days"},
	{Key: "appOpen", Label: "Has the app open", Type: FieldBool},
}

var nowFields = []Field{
	{Key: "weekday", Label: "Weekday", Type: FieldEnum, Options: weekdayOptions},
	{Key: "hour", Label: "Hour of the day", Type: FieldNumber, Unit: "h"},
	{Key: "holiday", Label: "Today is a holiday or break", Type: FieldBool},
	{Key: "openDayRunning", Label: "An open day is running", Type: FieldBool},
	{Key: "present", Label: "People checked in", Type: FieldNumber},
	{Key: "supervisorsOnline", Label: "Supervisors with the app open", Type: FieldNumber},
}

var openDayFields = []Field{
	{Key: "supervisors", Label: "Supervisors signed up", Type: FieldNumber},
	{Key: "free", Label: "Free supervisor places", Type: FieldNumber},
	{Key: "trainees", Label: "Trainees signed up", Type: FieldNumber},
	{Key: "weekday", Label: "Weekday", Type: FieldEnum, Options: weekdayOptions},
}

var openDayPlaceholders = []Placeholder{
	{"day", "Date of the open day", "Tue 11 Nov"},
	{"time", "Time of the open day", "16:00–20:00"},
	{"supervisors", "Supervisors signed up", "1"},
	{"trainees", "Trainees signed up", "2"},
	{"free", "Free supervisor places", "1"},
}

var openDayRecipients = []Choice{{"day_team", "Everyone signed up for that open day"}}

// ownPersonOpenDayNotice describes the open-day change triggers: each tells one person what changed in their own
// staffing, so the person is the only recipient and the only subject of a personal rule.
func openDayChange(key, label, help string, extra ...Placeholder) Trigger {
	placeholders := append([]Placeholder{
		{"day", "Date of the open day", "Tue 11 Nov 2026"},
		{"time", "Times of your timeslots (a moved one says what it was)", "16:00–20:00"},
		{"slots", "\"timeslot\" or \"timeslots\"", "timeslot"},
	}, extra...)
	return Trigger{
		Key: key, Area: "Open Days", Label: label, Help: help, Subject: SubjectSelf,
		Fields: []Field{
			{Key: "daysUntil", Label: "Days until the open day", Type: FieldNumber, Unit: "days"},
			{Key: "weekday", Label: "Weekday", Type: FieldEnum, Options: weekdayOptions},
		},
		Recipients:   triggerSubjects("self", "The person it concerns"),
		Placeholders: placeholders,
	}
}

var coreTriggers = []Trigger{
	{
		Key: "printer_error", Area: "Workshop", Label: "A printer reports an error",
		Help: "Fires when a connector reports a new printer error. Repeats of an error that is still open stay quiet; " +
			"the same code fires again once it was cleared.",
		Subject: SubjectLab, Permission: authorization.MachinesRead,
		Fields: []Field{
			{Key: "level", Label: "Level", Type: FieldOrdered, Options: options(
				"info", "Info", "common", "Common", "serious", "Serious", "fatal", "Fatal",
			)},
			{Key: "machine", Label: "Machine", Type: FieldEnum, OptionsFrom: SourcePrinters},
			{Key: "code", Label: "Error code", Type: FieldText},
			{Key: "printing", Label: "A print is running", Type: FieldBool},
			{Key: "operatorRole", Label: "Operator's system role", Type: FieldEnum, Options: membershipOptions},
		},
		Recipients: triggerSubjects(
			"operator", "Operator of the print", "recipient", "Job's recipient", "present", "Everyone checked in right now",
		),
		Placeholders: []Placeholder{
			{"machine", "Machine", "Bambu Lab H2D"},
			{"code", "Error code", "0300-0100-0003-0001"},
			{"level", "Level", "serious"},
			{"meaning", "What the code means", "The nozzle temperature is abnormal"},
			{"run", "Run being printed", "R-2026-000418"},
			{"job", "Job being printed", "Gear housing"},
			{"levelNote", "Level in brackets, empty without a level", " (serious)"},
			{"meaningNote", "Colon and meaning, empty when the code is unknown", ": The nozzle temperature is abnormal"},
			{"runNote", "\" during run …\", empty when nothing is printing", " during run R-2026-000418"},
		},
		Resolutions:      []Choice{{"error_cleared", "The error is cleared"}},
		ThrottleSubjects: triggerSubjects("machine", "machine", "code", "error code"),
	},
	{
		Key: "run_finished", Area: "Workshop", Label: "A print or run finishes",
		Help: "Fires when the machine's final report sets the run's outcome, or when a running manual run is cancelled. " +
			"Runs without a job notify nobody.",
		Subject: SubjectLab, Permission: authorization.MachineJobsRead,
		Fields: []Field{
			{Key: "machine", Label: "Machine", Type: FieldEnum, OptionsFrom: SourceMachines},
			{Key: "outcome", Label: "Outcome", Type: FieldEnum, Options: options(
				"successful", "Successful", "partial_failure", "Finished with problems", "failed", "Failed", "cancelled", "Cancelled",
			)},
			{Key: "duration", Label: "Duration", Type: FieldNumber, Unit: "h"},
			{Key: "recipientType", Label: "Job's recipient is", Type: FieldEnum, Options: options(
				"person", "A person", "organization", "An organization",
			)},
		},
		Recipients: triggerSubjects("operator", "Operator of the job", "recipient", "Job's recipient"),
		Placeholders: []Placeholder{
			{"run", "Run", "R-2026-000421"},
			{"job", "Job", "Lamp shade"},
			{"machine", "Machine", "Bambu Lab X1C #1"},
			{"ending", "How it ended", "finished"},
			{"duration", "Duration", "5 h 40 min"},
			{"jobNote", "\" of \"job title\"\", empty without a title", " of \"Lamp shade\""},
		},
		ThrottleSubjects: triggerSubjects("machine", "machine"),
	},
	{
		Key: "filament_change", Area: "Workshop", Label: "Filament changes in a printer",
		Help: "Fires on a live slot change reported by a printer connector while a run is printing: a known spool is " +
			"loaded or removed, or the slot holds material without a known spool.",
		Subject: SubjectLab, Permission: authorization.MachinesRead,
		Fields: []Field{
			{Key: "change", Label: "Change", Type: FieldEnum, Options: options(
				"loaded", "Known spool loaded", "unloaded", "Spool removed",
				"unknown_tag", "Unknown tag", "no_tag", "Material without a tag",
			)},
			{Key: "machine", Label: "Machine", Type: FieldEnum, OptionsFrom: SourcePrinters},
		},
		Recipients: triggerSubjects(
			"operator", "Operator of the print", "recipient", "Job's recipient", "present", "Everyone checked in right now",
		),
		Placeholders: []Placeholder{
			{"machine", "Machine", "Bambu Lab H2D"},
			{"slot", "Slot", "AMS A · 1"},
			{"spool", "Spool", "S-2026-000112 (PETG, Black)"},
			{"material", "Material read by the printer", "PETG, Black"},
			{"run", "Run being printed", "R-2026-000418"},
			{"materialNote", "Material in brackets, empty when unknown", " (PETG, Black)"},
		},
		ThrottleSubjects: triggerSubjects("machine", "machine"),
	},
	{
		Key: "place_freed", Area: "Open Days", Label: "A place on an open day becomes free",
		Help: "Fires when someone leaves, or is removed from, a supervisor place of a scheduled open day that starts " +
			"within the warning window of the staffing rules.",
		Subject: SubjectLab, Permission: authorization.OpenDaysRead,
		Fields: []Field{
			{Key: "daysUntil", Label: "Days until the open day", Type: FieldNumber, Unit: "days"},
			{Key: "weekday", Label: "Weekday", Type: FieldEnum, Options: weekdayOptions},
		},
		Recipients: triggerSubjects(
			"free_supervisors", "Supervisors not on that open day", "day_team", "Everyone signed up for that open day",
		),
		Placeholders: []Placeholder{
			{"day", "Date of the open day", "Thu 13 Nov"},
			{"time", "Time of the timeslot", "16:00–20:00"},
			{"daysUntil", "Days until the open day", "7"},
		},
		Resolutions:      []Choice{{"place_taken", "The place is taken again"}},
		ThrottleSubjects: triggerSubjects("open_day", "open day"),
	},
	openDayChange(
		"open_day_cancelled", "An open day you staff is cancelled",
		"Fires for each person signed up for an open day when it is cancelled.",
	),
	openDayChange(
		"open_day_timeslot_changed", "A timeslot you staff changes its times",
		"Fires for each person signed up for a timeslot whose times moved.",
		Placeholder{"changed", "\"has changed\" or \"have changed\"", "has changed"},
	),
	openDayChange(
		"open_day_timeslot_removed", "A timeslot you staff is removed",
		"Fires for each person signed up for a timeslot that was removed from an open day.",
		Placeholder{"wasWere", "\"was\" or \"were\"", "was"},
		Placeholder{"them", "\"it\" or \"them\"", "it"},
	),
	openDayChange(
		"open_day_assigned_by_other", "Someone signs you up for an open day",
		"Fires when somebody else puts a person on an open day.",
	),
	openDayChange(
		"open_day_unassigned_by_other", "Someone removes you from an open day",
		"Fires when somebody else takes a person off an open day.",
	),
	{
		Key: "period_opens", Area: "Open Days", Label: "Sign-up opens for a period",
		Help:    "Fires when a period moves from draft to staffing. Reopening a published period stays quiet.",
		Subject: SubjectLab, Permission: authorization.OpenDaysRead,
		Recipients: triggerSubjects("staffing_people", "Everyone who staffs open days"),
		Placeholders: []Placeholder{
			{"period", "Name of the period", "Winter term 2026/27"},
			{"deadline", "Sign-up deadline", "20 Nov"},
		},
	},
	{
		Key: "lab_rules_published", Area: "People", Label: "New Lab Rules take effect",
		Help:       "Fires once per version, when it becomes effective.",
		Subject:    SubjectLab,
		Recipients: triggerSubjects("need_confirm", "Everyone who still has to confirm"),
		Placeholders: []Placeholder{
			{"version", "Revision of the Lab Rules", "Version 7"},
		},
	},
}

var collections = []Collection{
	{
		Key: "people", Label: "Every person", One: "person", Plural: "people", PlaceholderPrefix: "person",
		Permission: authorization.PeopleReadAll,
		Fields: []Field{
			{Key: "name", Label: "Name", Type: FieldText},
			{Key: "systemRole", Label: "System role", Type: FieldEnum, Options: membershipOptions},
			{Key: "roles", Label: "Roles", Type: FieldList, OptionsFrom: SourceRoles},
			{Key: "hasAccount", Label: "Has an account", Type: FieldBool},
			{Key: "unpaid", Label: "Unpaid amount", Type: FieldNumber, Unit: "€", Permission: authorization.OrdersRead},
			{Key: "unpaidOrders", Label: "Unpaid orders", Type: FieldNumber, Permission: authorization.OrdersRead},
			{Key: "oldestUnpaid", Label: "Oldest unpaid order", Type: FieldNumber, Unit: "days", Permission: authorization.OrdersRead},
			{Key: "openDays", Label: "Open days this period", Type: FieldNumber, Permission: authorization.OpenDaysReadAssignments},
			{Key: "minimum", Label: "Semester minimum", Type: FieldNumber, Permission: authorization.OpenDaysReadAssignments},
			{Key: "lastVisit", Label: "Days since last visit", Type: FieldNumber, Unit: "days", Permission: authorization.AttendanceRead},
			{Key: "labRules", Label: "Lab Rules", Type: FieldEnum, Options: options(
				"confirmed", "Confirmed", "not_confirmed", "Not confirmed",
			), Permission: authorization.LaborordnungConfirmationsRead},
			{Key: "running", Label: "Runs going right now", Type: FieldNumber, Permission: authorization.MachineJobsRead},
		},
		Recipients: triggerSubjects("item", "This person"),
	},
	{
		Key: "open_days", Label: "Every open day of the current period", One: "open day", Plural: "open days",
		PlaceholderPrefix: "openday", Permission: authorization.OpenDaysRead,
		Fields: []Field{
			{Key: "weekday", Label: "Weekday", Type: FieldEnum, Options: weekdayOptions},
			{Key: "startsIn", Label: "Starts in", Type: FieldNumber, Unit: "days"},
			{Key: "supervisors", Label: "Supervisors signed up", Type: FieldNumber},
			{Key: "free", Label: "Free supervisor places", Type: FieldNumber},
			{Key: "trainees", Label: "Trainees signed up", Type: FieldNumber},
			{Key: "timeslots", Label: "Timeslots", Type: FieldNumber},
			{Key: "cancelled", Label: "Cancelled", Type: FieldBool},
		},
		Recipients: triggerSubjects(
			"team", "Everyone signed up for this open day", "supervisors_on", "Supervisors on this open day",
		),
	},
	{
		Key: "machines", Label: "Every machine", One: "machine", Plural: "machines", PlaceholderPrefix: "machine",
		Permission: authorization.MachinesRead,
		Fields: []Field{
			{Key: "name", Label: "Name", Type: FieldText},
			{Key: "process", Label: "Process", Type: FieldEnum, OptionsFrom: SourceProcesses},
			{Key: "status", Label: "Status", Type: FieldEnum, Options: options(
				"active", "Active", "maintenance", "Maintenance", "retired", "Retired",
			)},
			{Key: "runsToday", Label: "Runs today", Type: FieldNumber, Permission: authorization.MachineJobsRead},
			{Key: "errorsWeek", Label: "Printer errors this week", Type: FieldNumber},
			{Key: "online", Label: "Connector online", Type: FieldBool},
		},
	},
	{
		Key: "spools", Label: "Every spool", One: "spool", Plural: "spools", PlaceholderPrefix: "spool",
		Permission: authorization.InventoryRead,
		Fields: []Field{
			{Key: "name", Label: "Spool", Type: FieldText},
			{Key: "material", Label: "Material", Type: FieldEnum, OptionsFrom: SourceFilamentTypes},
			{Key: "remaining", Label: "Remaining", Type: FieldNumber, Unit: "g"},
			{Key: "loaded", Label: "Loaded in a printer", Type: FieldBool},
			{Key: "idle", Label: "Days since last use", Type: FieldNumber, Unit: "days"},
		},
	},
	{
		Key: "orders", Label: "Every order", One: "order", Plural: "orders", PlaceholderPrefix: "order",
		Permission: authorization.OrdersRead,
		Fields: []Field{
			{Key: "number", Label: "Number", Type: FieldText},
			{Key: "customerType", Label: "Customer is", Type: FieldEnum, Options: options(
				"person", "A person", "organization", "An organization",
			)},
			{Key: "amount", Label: "Amount", Type: FieldNumber, Unit: "€"},
			{Key: "outstanding", Label: "Outstanding", Type: FieldNumber, Unit: "€"},
			{Key: "daysOpen", Label: "Open for", Type: FieldNumber, Unit: "days"},
			{Key: "status", Label: "Status", Type: FieldEnum, Options: options(
				"draft", "Draft", "open", "Open", "paid", "Paid", "reversed", "Reversed", "cancelled", "Cancelled",
			)},
			{Key: "invoice", Label: "Paid by wiRef invoice", Type: FieldBool, Permission: authorization.ExternalInvoiceRequestsRead},
		},
		Recipients: triggerSubjects("customer", "Customer of this order", "creator", "Who created this order"),
	},
	{
		Key: "jobs", Label: "Every job", One: "job", Plural: "jobs", PlaceholderPrefix: "job",
		Permission: authorization.MachineJobsRead,
		Fields: []Field{
			{Key: "name", Label: "Name", Type: FieldText},
			{Key: "status", Label: "Status", Type: FieldEnum, Options: options(
				"planned", "Planned", "running", "Running", "needs_outcome", "Needs an outcome",
				"successful", "Successful", "partial_failure", "Finished with problems", "failed", "Failed",
				"cancelled", "Cancelled",
			)},
			{Key: "pricing", Label: "Price", Type: FieldEnum, Options: options(
				"pending", "Pending", "incomplete", "Incomplete", "complete", "Complete",
			)},
			{Key: "waiting", Label: "Waiting for", Type: FieldNumber, Unit: "days"},
			{Key: "machine", Label: "Machine", Type: FieldEnum, OptionsFrom: SourceMachines},
			{Key: "onOrder", Label: "On an order", Type: FieldBool},
		},
		Recipients: triggerSubjects("operator", "Operator of this job", "recipient", "This job's recipient"),
	},
	{
		Key: "articles", Label: "Every inventory article", One: "article", Plural: "articles", PlaceholderPrefix: "article",
		Permission: authorization.InventoryRead,
		Fields: []Field{
			{Key: "name", Label: "Name", Type: FieldText},
			{Key: "category", Label: "Category", Type: FieldEnum, OptionsFrom: SourceMaterialTypes},
			{Key: "stock", Label: "Stock", Type: FieldNumber},
			{Key: "minimum", Label: "Minimum", Type: FieldNumber},
			{Key: "location", Label: "Location", Type: FieldText},
		},
	},
	{
		Key: "trainings", Label: "Every training of every person", One: "training", Plural: "trainings",
		PlaceholderPrefix: "training", Permission: authorization.TrainingRecordsReadAll,
		Fields: []Field{
			{Key: "person", Label: "Person", Type: FieldText},
			{Key: "training", Label: "Training", Type: FieldEnum, OptionsFrom: SourceTrainings},
			{Key: "status", Label: "Status", Type: FieldEnum, Options: options("trained", "Trained", "trainer", "Trainer")},
			{Key: "completedAgo", Label: "Completed", Type: FieldNumber, Unit: "days"},
		},
		Recipients: triggerSubjects("item", "The trained person", "trainers", "Trainers of this training"),
	},
}
