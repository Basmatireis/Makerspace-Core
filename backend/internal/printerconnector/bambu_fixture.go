package printerconnector

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	BambuFixtureSchemaVersion = 1
	MaximumBambuFixtureBytes  = 50 << 20
	maximumFixtureLineBytes   = 4 << 20
)

var fixtureBaseTime = time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)

type bambuFixtureMessage struct {
	SchemaVersion int             `json:"schemaVersion"`
	ObservedAt    time.Time       `json:"observedAt"`
	Payload       json.RawMessage `json:"payload"`
}

// SanitizeBambuMQTTFixture converts a whitespace-separated JSON stream, NDJSON,
// or observedAt/payload envelopes into the bounded, redacted fixture format
// accepted by Replay. It
// intentionally normalizes timestamps so a committed fixture cannot reveal
// when a real user printed.
func SanitizeBambuMQTTFixture(input io.Reader, output io.Writer) error {
	if input == nil || output == nil {
		return errors.New("fixture input and output are required")
	}
	limited := &io.LimitedReader{R: input, N: MaximumBambuFixtureBytes + 1}
	decoder := json.NewDecoder(limited)
	decoder.UseNumber()
	encoder := json.NewEncoder(&boundedFixtureWriter{writer: output, remaining: MaximumBambuFixtureBytes})
	encoder.SetEscapeHTML(false)
	redactor := newFixtureRedactor()
	messageCount := 0
	for {
		var raw json.RawMessage
		if err := decoder.Decode(&raw); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return fmt.Errorf("fixture message %d is not a JSON object", messageCount+1)
		}
		messageCount++
		payload, err := fixturePayload(raw)
		if err != nil {
			return fmt.Errorf("fixture message %d is not a JSON object", messageCount)
		}
		decoded, err := decodeFixtureJSON(payload)
		if err != nil {
			return fmt.Errorf("fixture message %d has an invalid payload", messageCount)
		}
		object, ok := decoded.(map[string]any)
		if !ok {
			return fmt.Errorf("fixture message %d payload must be a JSON object", messageCount)
		}
		sanitized, err := redactor.value("", object, 0)
		if err != nil {
			return fmt.Errorf("fixture message %d: %w", messageCount, err)
		}
		encodedPayload, err := json.Marshal(sanitized)
		if err != nil {
			return fmt.Errorf("encode fixture message %d: %w", messageCount, err)
		}
		message := bambuFixtureMessage{
			SchemaVersion: BambuFixtureSchemaVersion,
			ObservedAt:    fixtureBaseTime.Add(time.Duration(messageCount-1) * time.Second),
			Payload:       encodedPayload,
		}
		if err = encoder.Encode(message); err != nil {
			return fmt.Errorf("write sanitized fixture: %w", err)
		}
	}
	if limited.N <= 0 {
		return fmt.Errorf("fixture exceeds %d bytes", MaximumBambuFixtureBytes)
	}
	if messageCount == 0 {
		return errors.New("fixture contains no JSON messages")
	}
	return nil
}

func decodeFixtureJSON(data []byte) (any, error) {
	var decoded any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		return nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("payload contains trailing JSON data")
	}
	return decoded, nil
}

func fixturePayload(line []byte) ([]byte, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(line, &object); err != nil || object == nil {
		return nil, errors.New("invalid JSON object")
	}
	raw, exists := object["payload"]
	if !exists {
		return append([]byte(nil), line...), nil
	}
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err == nil {
		encoded = strings.TrimSpace(encoded)
		if !strings.HasPrefix(encoded, "{") {
			return nil, errors.New("payload string is not a JSON object")
		}
		return []byte(encoded), nil
	}
	return append([]byte(nil), raw...), nil
}

type fixtureRedactor struct {
	values   map[string]map[string]string
	counters map[string]int
}

func newFixtureRedactor() *fixtureRedactor {
	return &fixtureRedactor{values: make(map[string]map[string]string), counters: make(map[string]int)}
}

func (r *fixtureRedactor) value(key string, value any, depth int) (any, error) {
	if depth > 32 {
		return nil, errors.New("JSON nesting is too deep")
	}
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		keys := make([]string, 0, len(typed))
		for childKey := range typed {
			keys = append(keys, childKey)
		}
		sort.Strings(keys)
		for _, childKey := range keys {
			childValue := typed[childKey]
			redacted, err := r.value(childKey, childValue, depth+1)
			if err != nil {
				return nil, err
			}
			result[childKey] = redacted
		}
		return result, nil
	case []any:
		result := make([]any, len(typed))
		for i, item := range typed {
			redacted, err := r.value(key, item, depth+1)
			if err != nil {
				return nil, err
			}
			result[i] = redacted
		}
		return result, nil
	case string:
		return r.stringValue(normalizedFixtureKey(key), typed), nil
	case json.Number:
		normalizedKey := normalizedFixtureKey(key)
		if isFixtureTimeKey(normalizedKey) {
			return json.Number("1767225600"), nil
		}
		if isFixtureIdentifierKey(normalizedKey) {
			if typed.String() == "0" {
				return typed, nil
			}
			return json.Number(r.replacement("identifier", typed.String(), func(index int) string { return strconv.Itoa(1000 + index) })), nil
		}
		return value, nil
	default:
		return value, nil
	}
}

func normalizedFixtureKey(key string) string {
	key = strings.ToLower(key)
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, key)
}

func (r *fixtureRedactor) stringValue(key, value string) string {
	if value == "" {
		return value
	}
	switch key {
	case "lanaccesscode", "accesscode", "password", "passwd", "token", "accesstoken", "authorization", "cookie", "secret":
		return "<redacted>"
	case "serial", "serialnumber", "printerserial", "sn", "devicesn", "deviceid":
		return r.replacement("serial", value, func(index int) string { return fmt.Sprintf("FIXTURE%08d", index) })
	case "ip", "ipaddress", "hostip", "printerip":
		return r.replacement("ip", value, func(index int) string { return fmt.Sprintf("192.0.2.%d", 1+(index-1)%253) })
	case "mac", "macaddress", "bssid":
		return r.replacement("mac", value, func(index int) string { return fmt.Sprintf("02:00:00:00:%02X:%02X", (index/256)%256, index%256) })
	case "hostname", "host", "ssid", "wifissid":
		return r.replacement("host", value, func(index int) string { return fmt.Sprintf("fixture-host-%03d", index) })
	case "taguid", "rfid", "rfiduid":
		return r.replacement("tag", value, func(index int) string { return fmt.Sprintf("%016X", index) })
	case "trayuuid", "uuid", "deviceuuid":
		return r.replacement("uuid", value, func(index int) string { return fmt.Sprintf("00000000-0000-7000-8000-%012d", index) })
	case "localtaskid", "lantaskid", "taskid", "jobid", "subtaskid", "userid", "accountid":
		if value == "0" {
			return value
		}
		return r.replacement("identifier", value, func(index int) string { return strconv.Itoa(1000 + index) })
	case "gcodefile", "file", "filename", "filepath", "projectname", "subtaskname", "taskname", "jobname":
		return r.fileReplacement(value)
	case "email", "username", "user", "owner", "creator":
		return r.replacement("person", value, func(index int) string { return fmt.Sprintf("fixture-person-%03d", index) })
	case "timestamp", "time", "datetime", "createdat", "updatedat":
		return "2026-01-01T00:00:00Z"
	}
	trimmed := strings.TrimSpace(value)
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		if nested, decodeErr := decodeFixtureJSON([]byte(trimmed)); decodeErr == nil {
			if sanitized, err := r.value(key, nested, 1); err == nil {
				if encoded, marshalErr := json.Marshal(sanitized); marshalErr == nil {
					return string(encoded)
				}
			}
		}
	}
	return value
}

func isFixtureTimeKey(key string) bool {
	switch key {
	case "timestamp", "time", "datetime", "createdat", "updatedat":
		return true
	default:
		return false
	}
}

func isFixtureIdentifierKey(key string) bool {
	switch key {
	case "localtaskid", "lantaskid", "taskid", "jobid", "subtaskid", "userid", "accountid":
		return true
	default:
		return false
	}
}

func (r *fixtureRedactor) replacement(category, value string, format func(int) string) string {
	if r.values[category] == nil {
		r.values[category] = make(map[string]string)
	}
	if replacement, ok := r.values[category][value]; ok {
		return replacement
	}
	r.counters[category]++
	replacement := format(r.counters[category])
	r.values[category][value] = replacement
	return replacement
}

func fixtureFileReplacement(index int, original string) string {
	ext := strings.ToLower(path.Ext(original))
	switch ext {
	case ".3mf", ".gcode", ".png", ".jpg", ".jpeg":
	default:
		ext = ".dat"
	}
	base := fmt.Sprintf("fixture-%03d%s", index, ext)
	if strings.HasPrefix(strings.ReplaceAll(original, "\\", "/"), "/cache/") {
		return "/cache/" + base
	}
	return base
}

func (r *fixtureRedactor) fileReplacement(value string) string {
	const category = "filename"
	if r.values[category] == nil {
		r.values[category] = make(map[string]string)
	}
	if replacement, ok := r.values[category][value]; ok {
		return replacement
	}
	r.counters[category]++
	replacement := fixtureFileReplacement(r.counters[category], value)
	r.values[category][value] = replacement
	return replacement
}

// ReplayBambuMQTTFixture applies a sanitized NDJSON fixture to the H2D
// reducer and writes deterministic normalized observations as NDJSON. It does
// not open SQLite, contact Core, or connect to a printer.
func ReplayBambuMQTTFixture(input io.Reader, output io.Writer) error {
	return ReplayBambuMQTTFixtureFor(input, output, bambuH2DAdapterKind)
}

// ReplayBambuMQTTFixtureFor replays the same sanitized transport fixture with
// the selected model's reducer semantics. Transport fields stay shared while
// tray routing and live nozzle normalization remain model-specific.
func ReplayBambuMQTTFixtureFor(input io.Reader, output io.Writer, adapterKind string) error {
	if input == nil || output == nil {
		return errors.New("fixture input and output are required")
	}
	if !isBambuAdapterKind(adapterKind) {
		return errors.New("unsupported Bambu adapter kind")
	}
	limited := &io.LimitedReader{R: input, N: MaximumBambuFixtureBytes + 1}
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 64<<10), maximumFixtureLineBytes)
	encoder := json.NewEncoder(&boundedFixtureWriter{writer: output, remaining: MaximumBambuFixtureBytes})
	encoder.SetEscapeHTML(false)
	processor := &bambuProcessor{adapterKind: adapterKind, state: bambuPersistedState{
		Document: map[string]any{}, Sessions: map[string]string{}, LastSlots: map[string]string{}, ActiveErrors: map[string]bool{},
	}}
	lineNumber := 0
	messageCount := 0
	for scanner.Scan() {
		lineNumber++
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		messageCount++
		var message bambuFixtureMessage
		if err := json.Unmarshal(line, &message); err != nil || message.SchemaVersion != BambuFixtureSchemaVersion || message.ObservedAt.IsZero() || len(message.Payload) == 0 {
			return fmt.Errorf("fixture line %d is not a sanitized schema-version %d message", lineNumber, BambuFixtureSchemaVersion)
		}
		observations, ready, err := processor.apply(context.Background(), message.Payload, message.ObservedAt.UTC())
		if err != nil {
			return fmt.Errorf("replay fixture line %d: %w", lineNumber, err)
		}
		normalized := make([]bambuReplayObservation, 0, len(observations))
		for _, observation := range observations {
			normalized = append(normalized, bambuReplayObservation{
				Kind: observation.Kind, Payload: observation.Payload, HasRunID: observation.RunID != nil,
				HistoryComplete: observation.HistoryComplete, ExternalPrintID: observation.ExternalPrintID,
			})
		}
		if err = encoder.Encode(bambuReplayLine{Line: lineNumber, ObservedAt: message.ObservedAt.UTC(), Ready: ready, Observations: normalized}); err != nil {
			return fmt.Errorf("write replay output: %w", err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read fixture: %w", err)
	}
	if limited.N <= 0 {
		return fmt.Errorf("fixture exceeds %d bytes", MaximumBambuFixtureBytes)
	}
	if messageCount == 0 {
		return errors.New("fixture contains no messages")
	}
	return nil
}

type bambuReplayLine struct {
	Line         int                      `json:"line"`
	ObservedAt   time.Time                `json:"observedAt"`
	Ready        bool                     `json:"ready"`
	Observations []bambuReplayObservation `json:"observations"`
}

type bambuReplayObservation struct {
	Kind            string          `json:"kind"`
	Payload         json.RawMessage `json:"payload"`
	HasRunID        bool            `json:"hasRunId"`
	HistoryComplete bool            `json:"historyComplete"`
	ExternalPrintID *string         `json:"externalPrintId,omitempty"`
}

type boundedFixtureWriter struct {
	writer    io.Writer
	remaining int
}

func (w *boundedFixtureWriter) Write(data []byte) (int, error) {
	if len(data) > w.remaining {
		return 0, fmt.Errorf("fixture output exceeds %d bytes", MaximumBambuFixtureBytes)
	}
	n, err := w.writer.Write(data)
	w.remaining -= n
	if n != len(data) && err == nil {
		err = io.ErrShortWrite
	}
	return n, err
}
