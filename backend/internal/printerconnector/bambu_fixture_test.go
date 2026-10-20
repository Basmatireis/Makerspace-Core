package printerconnector

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestSanitizeBambuMQTTFixtureRedactsAndPreservesRelationships(t *testing.T) {
	t.Parallel()

	input := strings.Join([]string{
		`{"observedAt":"2026-09-20T12:34:00Z","payload":{"print":{"gcode_state":"RUNNING","local_task_id":"real-task-77","gcode_file":"/cache/Customer Prototype.3mf","serial_number":"00MREAL123","ip_address":"192.168.1.42","tag_uid":"AABBCCDDEEFF","tray_uuid":"018f5c62-1234-7000-8000-000000000001","lanAccessCode":"super-secret"}}}`,
		`{"payload":"{\"print\":{\"gcode_state\":\"FINISH\",\"local_task_id\":\"real-task-77\",\"gcode_file\":\"/cache/Customer Prototype.3mf\"}}"}`,
	}, "\n")
	var output bytes.Buffer
	if err := SanitizeBambuMQTTFixture(strings.NewReader(input), &output); err != nil {
		t.Fatalf("SanitizeBambuMQTTFixture: %v", err)
	}
	var repeated bytes.Buffer
	if err := SanitizeBambuMQTTFixture(strings.NewReader(input), &repeated); err != nil {
		t.Fatalf("repeat SanitizeBambuMQTTFixture: %v", err)
	}
	if output.String() != repeated.String() {
		t.Fatal("sanitization is not deterministic")
	}
	text := output.String()
	for _, sensitive := range []string{
		"real-task-77",
		"Customer Prototype",
		"00MREAL123",
		"192.168.1.42",
		"AABBCCDDEEFF",
		"018f5c62",
		"super-secret",
		"2026-09-20",
	} {
		if strings.Contains(text, sensitive) {
			t.Fatalf("sanitized fixture contains %q: %s", sensitive, text)
		}
	}
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines = %d", len(lines))
	}
	var first, second bambuFixtureMessage
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(lines[1]), &second); err != nil {
		t.Fatal(err)
	}
	var firstPayload, secondPayload map[string]any
	_ = json.Unmarshal(first.Payload, &firstPayload)
	_ = json.Unmarshal(second.Payload, &secondPayload)
	firstPrint := firstPayload["print"].(map[string]any)
	secondPrint := secondPayload["print"].(map[string]any)
	if firstPrint["local_task_id"] != secondPrint["local_task_id"] ||
		firstPrint["gcode_file"] != secondPrint["gcode_file"] {
		t.Fatal("stable values were not replaced consistently")
	}
	if firstPrint["gcode_file"] != "/cache/fixture-001.3mf" {
		t.Fatalf("filename = %v", firstPrint["gcode_file"])
	}
	if first.ObservedAt.Equal(second.ObservedAt) || first.SchemaVersion != BambuFixtureSchemaVersion {
		t.Fatalf("fixture envelopes = %+v %+v", first, second)
	}
}

func TestSanitizeBambuMQTTFixtureRejectsInvalidInput(t *testing.T) {
	t.Parallel()

	for _, input := range []string{
		"",
		"\n\n",
		"[]",
		"not-json",
		`{"payload":"not an object"}`,
		`{"payload":"{\"print\":{}} trailing"}`,
	} {
		var output bytes.Buffer
		if err := SanitizeBambuMQTTFixture(strings.NewReader(input), &output); err == nil {
			t.Fatalf("accepted invalid input %q", input)
		}
	}
}

func TestReplayBambuMQTTFixtureUsesReducerWithoutExternalIO(t *testing.T) {
	t.Parallel()

	raw := strings.Join([]string{
		`{"print":{"gcode_state":"RUNNING","local_task_id":"task-a","gcode_file":"part.3mf","mc_percent":25}}`,
		`{"print":{"gcode_state":"PAUSE","local_task_id":"task-a","mc_percent":25}}`,
		`{"print":{"gcode_state":"RUNNING","local_task_id":"task-a","mc_percent":50}}`,
		`{"print":{"gcode_state":"FINISH","local_task_id":"task-a","mc_percent":100}}`,
	}, "\n")
	var sanitized bytes.Buffer
	if err := SanitizeBambuMQTTFixture(strings.NewReader(raw), &sanitized); err != nil {
		t.Fatalf("sanitize: %v", err)
	}
	var replay bytes.Buffer
	if err := ReplayBambuMQTTFixture(&sanitized, &replay); err != nil {
		t.Fatalf("replay: %v", err)
	}
	text := replay.String()
	for _, kind := range []string{`"kind":"operational_state"`, `"kind":"progress"`, `"kind":"terminal_outcome"`} {
		if !strings.Contains(text, kind) {
			t.Fatalf("replay missing %s: %s", kind, text)
		}
	}
	if strings.Contains(text, "task-a") || strings.Contains(text, "part.3mf") {
		t.Fatalf("replay leaked unsanitized data: %s", text)
	}
}

func TestReplayBambuMQTTFixtureRejectsRawInput(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	if err := ReplayBambuMQTTFixture(strings.NewReader(`{"print":{"gcode_state":"RUNNING"}}`), &output); err == nil {
		t.Fatal("raw input was accepted as a sanitized fixture")
	}
}
