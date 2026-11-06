package notifyrules

import (
	"strings"
)

// Context holds the values conditions are evaluated against, keyed like the conditions' fields ("e.level",
// "i.unpaid", "r.openDays"). Values are string, float64 (or any Go number), bool and []string. A field missing from
// the context is "not applicable" and its condition is ignored.
type Context map[string]any

// FieldLookup finds a field by its prefixed key. Ordered fields need it to compare options by position.
type FieldLookup func(key string) (Field, bool)

// ItemContext prefixes the values of one collection item with "i.".
func ItemContext(item map[string]any) Context {
	ctx := make(Context, len(item))
	for key, value := range item {
		ctx[PrefixItem+"."+key] = value
	}
	return ctx
}

// SummaryContext aggregates the items of a collection into the s. values: the count, the total of every money field
// and the highest value of every duration field. Items hold bare field keys.
func SummaryContext(collection Collection, items []map[string]any) Context {
	ctx := Context{PrefixSummary + ".count": float64(len(items))}
	for _, field := range SummaryFields(collection) {
		kind, source, found := strings.Cut(field.Key, ".")
		if !found {
			continue
		}
		var total float64
		for _, item := range items {
			value, ok := toFloat(item[source])
			if !ok {
				continue
			}
			if kind == "sum" {
				total += value
			} else if value > total {
				total = value
			}
		}
		if kind == "sum" {
			total = float64(int64(total*100+0.5*sign(total))) / 100
		}
		ctx[PrefixSummary+"."+field.Key] = total
	}
	return ctx
}

func sign(value float64) float64 {
	if value < 0 {
		return -1
	}
	return 1
}

// Evaluate reports whether the set holds. Conditions on fields the context lacks are ignored; a set without any
// applicable condition is true, so a rule is not silenced by a part of its context that does not exist yet.
func (s ConditionSet) Evaluate(ctx Context, lookup FieldLookup) bool {
	var results []bool
	for _, item := range s.Items {
		switch {
		case item.Group != nil:
			var inner []bool
			for _, condition := range item.Group.Items {
				if applicable, ok := condition.Evaluate(ctx, lookup); applicable {
					inner = append(inner, ok)
				}
			}
			if len(inner) > 0 {
				results = append(results, combine(item.Group.Mode, inner))
			}
		case item.Condition != nil:
			if applicable, ok := item.Condition.Evaluate(ctx, lookup); applicable {
				results = append(results, ok)
			}
		}
	}
	if len(results) == 0 {
		return true
	}
	return combine(s.Mode, results)
}

func combine(mode Mode, results []bool) bool {
	for _, result := range results {
		if mode == ModeAny && result {
			return true
		}
		if mode != ModeAny && !result {
			return false
		}
	}
	return mode != ModeAny
}

// Evaluate checks one condition. applicable is false when the context lacks the field (or the compared field).
func (c Condition) Evaluate(ctx Context, lookup FieldLookup) (applicable, result bool) {
	value, present := ctx[c.Field]
	if !present || value == nil {
		return false, false
	}
	field, known := lookup(c.Field)
	if !known {
		return false, false
	}
	switch c.Op {
	case OpYes:
		return true, truthy(value)
	case OpNo:
		return true, !truthy(value)
	case OpEmpty:
		return true, isEmpty(value)
	case OpNotEmpty:
		return true, !isEmpty(value)
	}
	switch field.Type {
	case FieldNumber:
		return c.number(ctx, value)
	case FieldOrdered:
		return c.ordered(field, value)
	case FieldText:
		text, _ := value.(string)
		want, _ := c.Value.(string)
		text, want = strings.ToLower(text), strings.ToLower(want)
		switch c.Op {
		case OpContains:
			return true, strings.Contains(text, want)
		case OpNotContains:
			return true, !strings.Contains(text, want)
		case OpEq:
			return true, text == want
		case OpStarts:
			return true, strings.HasPrefix(text, want)
		}
	case FieldList:
		held, _ := value.([]string)
		want, _ := c.Value.(string)
		has := false
		for _, item := range held {
			has = has || item == want
		}
		switch c.Op {
		case OpIncludes:
			return true, has
		case OpExcludes:
			return true, !has
		}
	default:
		text, _ := value.(string)
		switch c.Op {
		case OpIs:
			want, _ := c.Value.(string)
			return true, text == want
		case OpNot:
			want, _ := c.Value.(string)
			return true, text != want
		case OpAny:
			return true, contains(c.Value, text)
		case OpNone:
			return true, !contains(c.Value, text)
		}
	}
	return false, false
}

func (c Condition) number(ctx Context, value any) (applicable, result bool) {
	have, ok := toFloat(value)
	if !ok {
		return false, false
	}
	var want float64
	if c.Ref != "" {
		other, present := ctx[c.Ref]
		if !present {
			return false, false
		}
		if want, ok = toFloat(other); !ok {
			return false, false
		}
	} else if want, ok = toFloat(c.Value); !ok {
		return false, false
	}
	switch c.Op {
	case OpGt:
		return true, have > want
	case OpGte:
		return true, have >= want
	case OpLt:
		return true, have < want
	case OpLte:
		return true, have <= want
	case OpEq:
		return true, have == want
	case OpBetween:
		if c.Value2 == nil {
			return false, false
		}
		return true, have >= want && have <= *c.Value2
	}
	return false, false
}

func (c Condition) ordered(field Field, value any) (applicable, result bool) {
	have, want := optionIndex(field, value), optionIndex(field, c.Value)
	if have < 0 || want < 0 {
		return false, false
	}
	switch c.Op {
	case OpGte:
		return true, have >= want
	case OpLte:
		return true, have <= want
	case OpIs:
		return true, have == want
	case OpNot:
		return true, have != want
	}
	return false, false
}

func optionIndex(field Field, value any) int {
	text, ok := value.(string)
	if !ok {
		return -1
	}
	for index, option := range field.Options {
		if option.Value == text {
			return index
		}
	}
	return -1
}

func contains(list any, text string) bool {
	switch typed := list.(type) {
	case []string:
		for _, item := range typed {
			if item == text {
				return true
			}
		}
	case []any:
		for _, item := range typed {
			if s, ok := item.(string); ok && s == text {
				return true
			}
		}
	}
	return false
}

func truthy(value any) bool {
	flag, _ := value.(bool)
	return flag
}

func isEmpty(value any) bool {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed) == ""
	case []string:
		return len(typed) == 0
	case nil:
		return true
	}
	return false
}

func toFloat(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	}
	return 0, false
}

// FieldLookupFor returns the lookup for the fields a definition's conditions and filter may refer to. Database
// options are not resolved; evaluation only needs the order of ordered fields, which is static.
func FieldLookupFor(d Definition) FieldLookup {
	table := map[string]Field{}
	add := func(prefix string, fields []Field) {
		for _, field := range fields {
			table[prefix+"."+field.Key] = field
		}
	}
	switch d.Trigger.Type {
	case TriggerEvent:
		if trigger, ok := LookupTrigger(d.Trigger.Event); ok {
			add(PrefixEvent, trigger.Fields)
		}
	case TriggerSchedule:
		if d.Trigger.Schedule != nil &&
			(d.Trigger.Schedule.Repeat == RepeatBeforeOpenDay || d.Trigger.Schedule.Repeat == RepeatAfterOpenDay) {
			add(PrefixEvent, OpenDayFields(true))
		}
	}
	if d.Loop != nil {
		if collection, ok := LookupCollection(d.Loop.Collection); ok {
			add(PrefixItem, collection.Fields)
			add(PrefixSummary, SummaryFields(collection))
		}
	}
	add(PrefixRecipient, RecipientFields())
	add(PrefixNow, NowFields())
	return func(key string) (Field, bool) {
		field, ok := table[key]
		return field, ok
	}
}
