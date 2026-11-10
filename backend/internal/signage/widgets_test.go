package signage

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func TestWidgetsCarryNoStyleOfTheirOwn(t *testing.T) {
	for name, raw := range map[string]string{
		"announcement": `{"type":"announcement","templateIds":[],"style":"card","whenNone":"empty","fallbackText":"",` +
			`"whenMany":"rotate","rotateSeconds":10}`,
		"text": `{"type":"text","text":"Hi","fit":true}`,
		"camera": `{"type":"camera","source":"auto","machineId":null,"multi":"split","showProgress":false,` +
			`"showRemaining":false,"fallback":"hide","fallbackMediaId":null,"machineIds":[],"showLive":false,"showName":true}`,
		"image": `{"type":"image","mediaId":null,"fit":"cover","dim":45}`,
	} {
		canonical, _, err := ValidateWidget("main", []byte(raw))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var original, decoded map[string]any
		_ = json.Unmarshal([]byte(raw), &original)
		if err := json.Unmarshal(canonical, &decoded); err != nil || !reflect.DeepEqual(original, decoded) {
			t.Fatalf("%s re-encoded as %s", name, canonical)
		}
	}
}

func fontList(n int) string {
	items := make([]string, 0, n)
	for index := 0; index < n; index++ {
		items = append(items, `"`+ids.New().String()+`"`)
	}
	return "[" + strings.Join(items, ",") + "]"
}

func TestRichTextAndListWidgets(t *testing.T) {
	good := []string{
		`{"type":"text","text":"# Hi","fit":false,"format":"markdown","css":"p{color:red}","fontAssetIds":` + fontList(1) + `}`,
		`{"type":"text","text":"` + strings.Repeat("a", 20000) + `","fit":false,"format":"html"}`,
		`{"type":"open_days","count":20,"title":"","emptyText":"none","entryTemplate":"{date} {start}","format":"html","css":"b{}"}`,
		`{"type":"events","count":1}`,
		`{"type":"agenda","count":5,"includeOpenDays":true,"includeEvents":false,"openDayTemplate":"{kind}","eventTemplate":"{title}"}`,
		`{"type":"calendar","view":"weeks","weeks":3,"showHolidays":true,"showBreaks":true,"showOpenDays":true,"showEvents":false,` +
			`"colors":{"holiday":"#ff0000","break":"#00ff00","openDay":"#0000ff","event":"#ffff00"},"showWeekNumbers":true,"title":""}`,
	}
	for _, raw := range good {
		if _, _, err := ValidateWidget("main", []byte(raw)); err != nil {
			t.Errorf("%.60s: %v", raw, err)
		}
	}
	colors := `"colors":{"holiday":"#ff0000","break":"#00ff00","openDay":"#0000ff","event":"#ffff00"},"showWeekNumbers":false`
	flags := `"showHolidays":true,"showBreaks":true,"showOpenDays":true,"showEvents":true,`
	bad := map[string]string{
		"format":            `{"type":"text","text":"x","fit":false,"format":"rtf"}`,
		"css too long":      `{"type":"text","text":"x","fit":false,"css":"` + strings.Repeat("a", 20001) + `"}`,
		"too many fonts":    `{"type":"text","text":"x","fit":false,"fontAssetIds":` + fontList(11) + `}`,
		"template too long": `{"type":"events","count":2,"entryTemplate":"` + strings.Repeat("a", 5001) + `"}`,
		"title too long":    `{"type":"events","count":2,"title":"` + strings.Repeat("a", 201) + `"}`,
		"agenda count":      `{"type":"agenda","count":21,"includeOpenDays":true,"includeEvents":true}`,
		"agenda unknown":    `{"type":"agenda","count":2,"includeOpenDays":true,"includeEvents":true,"limit":3}`,
		"calendar view":     `{"type":"calendar","view":"year","weeks":1,` + flags + colors + `}`,
		"calendar weeks":    `{"type":"calendar","view":"weeks","weeks":7,` + flags + colors + `}`,
		"calendar colour": `{"type":"calendar","view":"month","weeks":1,` + flags +
			`"colors":{"holiday":"red","break":"#00ff00","openDay":"#0000ff","event":"#ffff00"},"showWeekNumbers":false}`,
	}
	for name, raw := range bad {
		t.Run(name, func(t *testing.T) {
			if _, _, err := ValidateWidget("main", []byte(raw)); err == nil {
				t.Fatal("invalid widget accepted")
			}
		})
	}
}

func TestOldWidgetsKeepTheirCanonicalForm(t *testing.T) {
	for _, raw := range []string{
		`{"type":"empty"}`,
		`{"type":"text","text":"hi","fit":false}`,
		`{"type":"open_days","count":3}`,
		`{"type":"events","count":3}`,
	} {
		canonical, _, err := ValidateWidget("main", []byte(raw))
		if err != nil || string(canonical) != raw {
			t.Errorf("%s re-encoded as %s (%v)", raw, canonical, err)
		}
	}
}

func TestShowCompetenciesIsOptionalAndOnlyForOpenDays(t *testing.T) {
	calendar := `{"type":"calendar","view":"weeks","weeks":2,"showHolidays":true,"showBreaks":true,"showOpenDays":true,` +
		`"showEvents":false,"colors":{"holiday":"#111111","break":"#222222","openDay":"#333333","event":"#444444"},` +
		`"showWeekNumbers":false`
	for name, raw := range map[string]string{
		"open days": `{"type":"open_days","count":5,"showCompetencies":true}`,
		"agenda":    `{"type":"agenda","count":5,"includeOpenDays":true,"includeEvents":true,"showCompetencies":true}`,
		"calendar":  calendar + `,"showCompetencies":true}`,
	} {
		canonical, _, err := ValidateWidget("main", []byte(raw))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !strings.Contains(string(canonical), `"showCompetencies":true`) {
			t.Fatalf("%s lost the flag: %s", name, canonical)
		}
	}
	// Existing widgets stay byte-for-byte the same: the flag is omitted while false.
	for name, raw := range map[string]string{
		"open days": `{"type":"open_days","count":5}`,
		"agenda":    `{"type":"agenda","count":5,"includeOpenDays":true,"includeEvents":false,"showCompetencies":false}`,
		"calendar":  calendar + `}`,
	} {
		canonical, _, err := ValidateWidget("main", []byte(raw))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if strings.Contains(string(canonical), "showCompetencies") {
			t.Fatalf("%s gained the flag: %s", name, canonical)
		}
	}
	if _, _, err := ValidateWidget("main", []byte(`{"type":"events","count":5,"showCompetencies":true}`)); err == nil {
		t.Fatal("events widget accepted showCompetencies")
	}
	if _, _, err := ValidateWidget("main", []byte(`{"type":"open_days","count":5,"showCompetencies":"yes"}`)); err == nil {
		t.Fatal("non-boolean showCompetencies accepted")
	}
}

func TestCalendarHideLegendIsOptional(t *testing.T) {
	base := `{"type":"calendar","view":"month","weeks":4,"showHolidays":true,"showBreaks":true,"showOpenDays":true,` +
		`"showEvents":true,"colors":{"holiday":"#111111","break":"#222222","openDay":"#333333","event":"#444444"},` +
		`"showWeekNumbers":false`
	canonical, _, err := ValidateWidget("main", []byte(base+`,"hideLegend":true}`))
	if err != nil || !strings.Contains(string(canonical), `"hideLegend":true`) {
		t.Fatalf("flag lost: %s (%v)", canonical, err)
	}
	// Existing calendars stay byte-for-byte the same: the flag is omitted while false.
	canonical, _, err = ValidateWidget("main", []byte(base+`,"hideLegend":false}`))
	if err != nil || strings.Contains(string(canonical), "hideLegend") {
		t.Fatalf("false flag kept: %s (%v)", canonical, err)
	}
}
