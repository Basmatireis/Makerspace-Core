package engine

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/shopspring/decimal"
)

// Data is the data of one rendering. Values are string, bool, int, float64, decimal.Decimal (money), time.Time,
// civil dates as "YYYY-MM-DD" strings, []map[string]any, []string, []any and map[string]any (or Data).
type Data = map[string]any

// Expression limits.
const (
	maxPatternLength  = 40
	maxNumberDecimals = 6
	maxTruncate       = 1000
	defaultTruncate   = 40
	defaultJoin       = ", "
)

const (
	tokenOpen  = "{{"
	tokenClose = "}}"
)

var (
	pathPattern   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$`)
	filterPattern = regexp.MustCompile(`^([A-Za-z]+)\s*(?:\((.*)\))?$`)
	numberArg     = regexp.MustCompile(`^-?[0-9]+(\.[0-9]+)?$`)
)

type filterCall struct {
	name string
	args []string
}

type expression struct {
	path    string
	filters []filterCall
}

// segment is literal text or a token of a template text.
type segment struct {
	literal string
	token   bool
	source  string
	expr    expression
	err     string
}

// parseText splits text into literals and tokens. A token that does not parse keeps its error; a lone "{{" or "}}"
// is an error too, so a typo never reaches a document unnoticed.
func parseText(text string) []segment {
	var out []segment
	rest := text
	for rest != "" {
		open := strings.Index(rest, tokenOpen)
		closeAt := strings.Index(rest, tokenClose)
		if open < 0 {
			if closeAt >= 0 {
				out = append(out, segment{literal: rest, err: "A }} has no matching {{"})
				return out
			}
			out = append(out, segment{literal: rest})
			return out
		}
		if closeAt >= 0 && closeAt < open {
			out = append(out, segment{literal: rest[:open], err: "A }} has no matching {{"})
			rest = rest[open:]
			continue
		}
		if open > 0 {
			out = append(out, segment{literal: rest[:open]})
		}
		rest = rest[open+len(tokenOpen):]
		end := strings.Index(rest, tokenClose)
		if end < 0 {
			out = append(out, segment{token: true, source: tokenOpen + rest, err: "A {{ is not closed by }}"})
			return out
		}
		inner := rest[:end]
		rest = rest[end+len(tokenClose):]
		seg := segment{token: true, source: tokenOpen + inner + tokenClose}
		if strings.ContainsAny(inner, "{}") {
			seg.err = "Expressions cannot be nested"
		} else if expr, err := parseExpression(inner); err != nil {
			seg.err = err.Error()
		} else {
			seg.expr = expr
		}
		out = append(out, seg)
	}
	return out
}

func parseExpression(source string) (expression, error) {
	parts, err := splitOutsideQuotes(source, '|')
	if err != nil {
		return expression{}, err
	}
	path := strings.TrimSpace(parts[0])
	if !pathPattern.MatchString(path) {
		if path == "" {
			return expression{}, userError("An expression needs a variable")
		}
		return expression{}, userErrorf("“%s” is not a variable name", truncateRunes(path, 40))
	}
	expr := expression{path: path}
	for _, part := range parts[1:] {
		match := filterPattern.FindStringSubmatch(strings.TrimSpace(part))
		if match == nil {
			return expression{}, userErrorf("“%s” is not a filter", truncateRunes(strings.TrimSpace(part), 40))
		}
		call := filterCall{name: match[1]}
		if strings.TrimSpace(match[2]) != "" {
			args, err := splitOutsideQuotes(match[2], ',')
			if err != nil {
				return expression{}, err
			}
			for _, arg := range args {
				value, err := parseArg(strings.TrimSpace(arg))
				if err != nil {
					return expression{}, err
				}
				call.args = append(call.args, value)
			}
		}
		expr.filters = append(expr.filters, call)
	}
	return expr, nil
}

// parseArg reads a quoted text or a number; quotes cannot be escaped, so a text cannot contain its own quote.
func parseArg(arg string) (string, error) {
	if len(arg) >= 2 && (arg[0] == '"' || arg[0] == '\'') && arg[len(arg)-1] == arg[0] {
		inner := arg[1 : len(arg)-1]
		if strings.ContainsRune(inner, rune(arg[0])) {
			return "", userError("A filter argument contains its own quote")
		}
		return inner, nil
	}
	if numberArg.MatchString(arg) {
		return arg, nil
	}
	return "", userError("Filter arguments are quoted texts or numbers")
}

func splitOutsideQuotes(source string, separator rune) ([]string, error) {
	var parts []string
	var current strings.Builder
	var quote rune
	for _, r := range source {
		switch {
		case quote != 0:
			current.WriteRune(r)
			if r == quote {
				quote = 0
			}
		case r == '"' || r == '\'':
			quote = r
			current.WriteRune(r)
		case r == separator:
			parts = append(parts, current.String())
			current.Reset()
		default:
			current.WriteRune(r)
		}
	}
	if quote != 0 {
		return nil, userError("A quote is not closed")
	}
	return append(parts, current.String()), nil
}

// filterArity is the number of arguments each filter takes: minimum and maximum.
var filterArity = map[string][2]int{
	"currency": {0, 0}, "amount": {0, 0}, "number": {0, 1}, "date": {0, 1}, "datetime": {0, 1}, "time": {0, 1},
	"upper": {0, 0}, "lower": {0, 0}, "capitalize": {0, 0}, "default": {1, 1}, "prefix": {1, 1}, "suffix": {1, 1},
	"truncate": {0, 1}, "join": {0, 1}, "count": {0, 0}, "sum": {0, 1}, "first": {0, 0}, "last": {0, 0},
}

// checkFilter validates the arguments of one filter call.
func checkFilter(call filterCall) error {
	arity, ok := filterArity[call.name]
	if !ok {
		return userErrorf("Unknown filter “%s”", truncateRunes(call.name, 40))
	}
	if len(call.args) < arity[0] || len(call.args) > arity[1] {
		if arity[0] == arity[1] {
			return userErrorf("The filter %s takes %d argument(s)", call.name, arity[0])
		}
		return userErrorf("The filter %s takes at most %d argument(s)", call.name, arity[1])
	}
	if len(call.args) == 0 {
		return nil
	}
	arg := call.args[0]
	switch call.name {
	case "number":
		if n, err := strconv.Atoi(arg); err != nil || n < 0 || n > maxNumberDecimals {
			return userErrorf("number(n) takes 0 to %d decimals", maxNumberDecimals)
		}
	case "truncate":
		if n, err := strconv.Atoi(arg); err != nil || n < 1 || n > maxTruncate {
			return userErrorf("truncate(n) takes 1 to %d characters", maxTruncate)
		}
	case "date", "datetime", "time":
		if utf8.RuneCountInString(arg) > maxPatternLength {
			return userErrorf("A date pattern has at most %d characters", maxPatternLength)
		}
	case "sum":
		if !identPattern.MatchString(arg) {
			return userError(`sum("field") names a field of the list entries`)
		}
	}
	return nil
}

// scope is the chain of loop aliases and locals an expression resolves against.
type scope struct {
	parent   *scope
	alias    string
	listPath string
	entry    any
	locals   map[string]any
}

func (s *scope) loop(alias, listPath string, entry any, index int) *scope {
	return &scope{parent: s, alias: alias, listPath: listPath, entry: entry, locals: map[string]any{"index": index}}
}

func (s *scope) with(locals map[string]any) *scope {
	return &scope{parent: s, locals: locals}
}

type evalConfig struct {
	kind      Kind
	locale    string
	location  *time.Location
	blankZero bool
	can       func(permission string) bool
}

// evaluator resolves variables and applies filters. It reports problems through report and remembers the redacted
// canonical paths.
type evaluator struct {
	cfg      evalConfig
	schema   *schemaIndex
	root     Data
	redacted map[string]bool
	report   func(nodeID, message string)
}

func newEvaluator(cfg evalConfig, root Data) *evaluator {
	if cfg.location == nil {
		cfg.location = viennaLocation
	}
	if cfg.can == nil {
		cfg.can = func(string) bool { return false }
	}
	return &evaluator{
		cfg:      cfg,
		schema:   schemaIndexes[cfg.kind],
		root:     root,
		redacted: map[string]bool{},
		report:   func(string, string) {},
	}
}

// resolved is a variable after scoping.
type resolved struct {
	field    fieldDef
	value    any
	redacted bool
}

// resolve finds a path: a loop alias first, then a local, then the export data. Unknown paths are errors.
func (e *evaluator) resolve(path string, sc *scope) (resolved, error) {
	segments := strings.Split(path, ".")
	head, rest := segments[0], segments[1:]
	canonical := path
	var value any
	found, local := false, false
	for s := sc; s != nil && !found; s = s.parent {
		if s.alias != "" && s.alias == head {
			canonical = strings.Join(append([]string{s.listPath + "[]"}, rest...), ".")
			value, found = walk(s.entry, rest), true
			continue
		}
		if v, ok := s.locals[head]; ok {
			value, found, local = walk(v, rest), true, true
		}
	}
	if !found {
		value = walk(e.root, segments)
	}
	field, known := e.schema.lookup(canonical)
	if !known {
		if local && path == "index" {
			return resolved{field: fieldDef{path: "index", typ: FieldNumber}, value: value}, nil
		}
		return resolved{}, userErrorf("Unknown variable “%s”", truncateRunes(path, 60))
	}
	if field.permission != "" && !e.cfg.can(field.permission) {
		e.redacted[canonical] = true
		return resolved{field: field, redacted: true}, nil
	}
	return resolved{field: field, value: value}, nil
}

// text evaluates a template text. Values are inserted as plain text and never evaluated again.
func (e *evaluator) text(nodeID, text string, sc *scope) string {
	if !strings.Contains(text, tokenOpen) && !strings.Contains(text, tokenClose) {
		return text
	}
	var out strings.Builder
	for _, seg := range parseText(text) {
		if seg.err != "" {
			e.report(nodeID, seg.err)
			if seg.token {
				out.WriteString(seg.source)
			} else {
				out.WriteString(seg.literal)
			}
			continue
		}
		if !seg.token {
			out.WriteString(seg.literal)
			continue
		}
		value, err := e.eval(seg.expr, sc)
		if err != nil {
			e.report(nodeID, err.Error())
			out.WriteString(seg.source)
			continue
		}
		out.WriteString(value)
	}
	return out.String()
}

// value resolves a bare path for conditions, switches and loops; redacted or unknown paths are empty.
func (e *evaluator) value(nodeID, path string, sc *scope) (any, string) {
	r, err := e.resolve(path, sc)
	if err != nil {
		e.report(nodeID, err.Error())
		return nil, ""
	}
	if r.redacted {
		return nil, r.field.path
	}
	return r.value, r.field.path
}

// list resolves a loop source into its entries.
func (e *evaluator) list(nodeID, path string, sc *scope) ([]any, string) {
	value, canonical := e.value(nodeID, path, sc)
	if canonical != "" && !e.schema.isList(canonical) {
		e.report(nodeID, fmt.Sprintf("“%s” is not a list", truncateRunes(path, 60)))
		return nil, canonical
	}
	entries, _ := asList(value)
	return entries, canonical
}

// eval applies the filters of one expression.
func (e *evaluator) eval(expr expression, sc *scope) (string, error) {
	r, err := e.resolve(expr.path, sc)
	if err != nil {
		return "", err
	}
	for _, call := range expr.filters {
		if err := checkFilter(call); err != nil {
			return "", err
		}
		if call.name == "sum" && len(call.args) == 1 && r.field.typ == FieldList {
			if _, ok := e.schema.lookup(r.field.path + "[]." + call.args[0]); !ok {
				return "", userErrorf("“%s” is not a field of %s", call.args[0], r.field.path)
			}
		}
	}
	if r.redacted {
		return "", nil
	}
	value, typ := r.value, r.field.typ
	for _, call := range expr.filters {
		value, typ = e.apply(call, value, typ, r.field.path)
	}
	return e.display(value, typ), nil
}

func (e *evaluator) apply(call filterCall, value any, typ FieldType, canonical string) (any, FieldType) {
	arg := ""
	if len(call.args) > 0 {
		arg = call.args[0]
	}
	switch call.name {
	case "currency":
		text, _ := e.currency(value)
		return text, FieldText
	case "amount":
		d, ok := toDecimal(value)
		if !ok || (e.cfg.blankZero && d.IsZero()) {
			return "", FieldText
		}
		return formatGrouped(d, 2, e.cfg.locale), FieldText
	case "number":
		d, ok := toDecimal(value)
		if !ok {
			return "", FieldText
		}
		places, _ := strconv.ParseInt(arg, 10, 8) // checkFilter bounds it to 0..maxNumberDecimals
		return formatGrouped(d, int32(places), e.cfg.locale), FieldText
	case "date", "datetime", "time":
		pattern := map[string]string{"date": "dd.MM.yyyy", "datetime": "dd.MM.yyyy HH:mm", "time": "HH:mm"}[call.name]
		if arg != "" {
			pattern = arg
		}
		t, ok := e.toTime(value)
		if !ok {
			return e.display(value, typ), FieldText
		}
		return formatPattern(t, pattern), FieldText
	case "upper":
		return strings.ToUpper(e.display(value, typ)), FieldText
	case "lower":
		return strings.ToLower(e.display(value, typ)), FieldText
	case "capitalize":
		text := e.display(value, typ)
		first, size := utf8.DecodeRuneInString(text)
		if size == 0 {
			return text, FieldText
		}
		return string(unicode.ToUpper(first)) + text[size:], FieldText
	case "default":
		if isEmpty(value) {
			return arg, FieldText
		}
		return value, typ
	case "prefix":
		if isEmpty(value) {
			return "", FieldText
		}
		return arg + e.display(value, typ), FieldText
	case "suffix":
		if isEmpty(value) {
			return "", FieldText
		}
		return e.display(value, typ) + arg, FieldText
	case "truncate":
		n := defaultTruncate
		if arg != "" {
			n, _ = strconv.Atoi(arg)
		}
		return truncateRunes(e.display(value, typ), n), FieldText
	case "join":
		separator := defaultJoin
		if len(call.args) > 0 {
			separator = arg
		}
		entries, ok := asList(value)
		if !ok {
			return value, typ
		}
		texts := make([]string, 0, len(entries))
		for _, entry := range entries {
			if text := e.display(entry, FieldText); text != "" {
				texts = append(texts, text)
			}
		}
		return strings.Join(texts, separator), FieldText
	case "count":
		entries, _ := asList(value)
		return len(entries), FieldNumber
	case "sum":
		return e.sum(value, arg, canonical), FieldNumber
	case "first", "last":
		entries, ok := asList(value)
		if !ok {
			return value, typ
		}
		if len(entries) == 0 {
			return nil, FieldText
		}
		elementType := FieldText
		if field, ok := e.schema.lookup(canonical + "[]"); ok {
			elementType = field.typ
		}
		if call.name == "first" {
			return entries[0], elementType
		}
		return entries[len(entries)-1], elementType
	}
	return value, typ
}

// sum adds a field over the entries of a list; a field the reader may not see sums to nothing.
func (e *evaluator) sum(value any, field, canonical string) any {
	entries, ok := asList(value)
	if !ok {
		return nil
	}
	if field != "" {
		def, known := e.schema.lookup(canonical + "[]." + field)
		if known && def.permission != "" && !e.cfg.can(def.permission) {
			e.redacted[def.path] = true
			return nil
		}
	}
	total := decimal.Zero
	for _, entry := range entries {
		if field != "" {
			entry = member(entry, field)
		}
		if d, ok := toDecimal(entry); ok {
			total = total.Add(d)
		}
	}
	return total
}

// currency formats money: de 1.234,50 €, en EUR 1,234.50.
func (e *evaluator) currency(value any) (string, bool) {
	d, ok := toDecimal(value)
	if !ok {
		return "", false
	}
	if e.cfg.locale == "de" {
		return formatGrouped(d, 2, "de") + " €", true
	}
	sign := ""
	if d.IsNegative() {
		sign = "-"
	}
	return sign + "EUR " + formatGrouped(d.Abs(), 2, "en"), true
}

// display turns a value into text; without filters money and dates take their default format.
func (e *evaluator) display(value any, typ FieldType) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		if typ == FieldDate {
			if t, ok := e.toTime(v); ok {
				return formatPattern(t, "dd.MM.yyyy")
			}
		}
		if typ == FieldMoney {
			if d, ok := toDecimal(v); ok {
				return formatGrouped(d, 2, e.cfg.locale)
			}
		}
		return v
	case bool:
		if v {
			return "true"
		}
		return ""
	case time.Time:
		return formatPattern(v.In(e.cfg.location), "dd.MM.yyyy")
	case []string:
		return strings.Join(v, defaultJoin)
	}
	if d, ok := toDecimal(value); ok {
		if typ == FieldMoney {
			return formatGrouped(d, 2, e.cfg.locale)
		}
		text := d.String()
		if e.cfg.locale == "de" {
			text = strings.Replace(text, ".", ",", 1)
		}
		return text
	}
	return ""
}

// toTime reads a time.Time (shown in the configured time zone), a civil date "YYYY-MM-DD" (shown as is) or an
// RFC 3339 timestamp.
func (e *evaluator) toTime(value any) (time.Time, bool) {
	switch v := value.(type) {
	case time.Time:
		if v.IsZero() {
			return time.Time{}, false
		}
		return v.In(e.cfg.location), true
	case string:
		if t, err := time.Parse(time.DateOnly, v); err == nil {
			return t, true
		}
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			return t.In(e.cfg.location), true
		}
	}
	return time.Time{}, false
}

// formatPattern writes a date with the tokens yyyy, MM, dd, HH and mm; everything else is literal.
func formatPattern(t time.Time, pattern string) string {
	var out strings.Builder
	for i := 0; i < len(pattern); {
		switch {
		case strings.HasPrefix(pattern[i:], "yyyy"):
			fmt.Fprintf(&out, "%04d", t.Year())
			i += 4
		case strings.HasPrefix(pattern[i:], "MM"):
			fmt.Fprintf(&out, "%02d", int(t.Month()))
			i += 2
		case strings.HasPrefix(pattern[i:], "dd"):
			fmt.Fprintf(&out, "%02d", t.Day())
			i += 2
		case strings.HasPrefix(pattern[i:], "HH"):
			fmt.Fprintf(&out, "%02d", t.Hour())
			i += 2
		case strings.HasPrefix(pattern[i:], "mm"):
			fmt.Fprintf(&out, "%02d", t.Minute())
			i += 2
		default:
			out.WriteByte(pattern[i])
			i++
		}
	}
	return out.String()
}

// formatGrouped writes a number with fixed decimals and thousands separators: de 1.234,50, en 1,234.50.
func formatGrouped(d decimal.Decimal, places int32, locale string) string {
	group, point := ",", "."
	if locale == "de" {
		group, point = ".", ","
	}
	fixed := d.Abs().StringFixed(places)
	whole, fraction, _ := strings.Cut(fixed, ".")
	var grouped strings.Builder
	for i, digit := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			grouped.WriteString(group)
		}
		grouped.WriteRune(digit)
	}
	sign := ""
	if d.Round(places).IsNegative() {
		sign = "-"
	}
	if fraction == "" {
		return sign + grouped.String()
	}
	return sign + grouped.String() + point + fraction
}

func toDecimal(value any) (decimal.Decimal, bool) {
	switch v := value.(type) {
	case decimal.Decimal:
		return v, true
	case *decimal.Decimal:
		if v == nil {
			return decimal.Decimal{}, false
		}
		return *v, true
	case int:
		return decimal.NewFromInt(int64(v)), true
	case int32:
		return decimal.NewFromInt32(v), true
	case int64:
		return decimal.NewFromInt(v), true
	case float64:
		return decimal.NewFromFloat(v), true
	case float32:
		return decimal.NewFromFloat32(v), true
	case json.Number:
		d, err := decimal.NewFromString(v.String())
		return d, err == nil
	case string:
		text := strings.TrimSpace(v)
		if text == "" {
			return decimal.Decimal{}, false
		}
		d, err := decimal.NewFromString(text)
		return d, err == nil
	}
	return decimal.Decimal{}, false
}

// isEmpty is the condition "empty": nothing, empty text, false or an empty list.
func isEmpty(value any) bool {
	switch v := value.(type) {
	case nil:
		return true
	case Image:
		return len(v.Data) == 0
	case string:
		return v == ""
	case bool:
		return !v
	}
	if entries, ok := asList(value); ok {
		return len(entries) == 0
	}
	return false
}

func asList(value any) ([]any, bool) {
	switch v := value.(type) {
	case []any:
		return v, true
	case []map[string]any:
		out := make([]any, len(v))
		for i := range v {
			out[i] = v[i]
		}
		return out, true
	case []string:
		out := make([]any, len(v))
		for i := range v {
			out[i] = v[i]
		}
		return out, true
	}
	return nil, false
}

func member(value any, name string) any {
	if m, ok := value.(map[string]any); ok {
		return m[name]
	}
	return nil
}

func walk(value any, segments []string) any {
	for _, segment := range segments {
		value = member(value, segment)
	}
	return value
}

func firstEntry(value any) any {
	entries, ok := asList(value)
	if !ok || len(entries) == 0 {
		return nil
	}
	return entries[0]
}

// truncateRunes cuts text to n characters, the last being an ellipsis.
func truncateRunes(text string, n int) string {
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	if n <= 1 {
		return "…"
	}
	return string(runes[:n-1]) + "…"
}

// stringValue is the text a condition compares: numbers without formatting, booleans as "true" or "".
func stringValue(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return ""
	case time.Time:
		return v.Format(time.RFC3339)
	}
	if d, ok := toDecimal(value); ok {
		return d.String()
	}
	return ""
}

// test evaluates a condition; a missing condition is true.
func (e *evaluator) test(nodeID string, c *Condition, sc *scope) bool {
	if c == nil || c.Path == "" {
		return true
	}
	value, _ := e.value(nodeID, c.Path, sc)
	switch c.Op {
	case OpExists:
		return !isEmpty(value)
	case OpEmpty:
		return isEmpty(value)
	case OpEq:
		return stringValue(value) == c.Value
	case OpNe:
		return stringValue(value) != c.Value
	case OpGt, OpLt:
		left, okLeft := toDecimal(value)
		right, okRight := toDecimal(c.Value)
		if !okLeft || !okRight {
			return false
		}
		if c.Op == OpGt {
			return left.GreaterThan(right)
		}
		return left.LessThan(right)
	}
	return true
}

// userError is a problem message shown to template authors; it reads as a sentence.
type userError string

func (m userError) Error() string { return string(m) }

func userErrorf(format string, args ...any) error { return userError(fmt.Sprintf(format, args...)) }
