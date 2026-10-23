package signage

import (
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func styleJSON(family, asset string) string {
	return `{"textColor":"#ffffff","backgroundColor":null,"borderColor":"#000000","backgroundOpacity":50,` +
		`"padding":2,"radius":1,"borderWidth":5,"fontScale":150,"fontFamily":"` + family + `","fontAssetId":` + asset +
		`,"align":"center","verticalAlign":"inherit"}`
}

func TestWidgetStyleValidation(t *testing.T) {
	font := ids.New()
	ok, refs, err := ValidateWidget("main", []byte(`{"type":"empty","style":`+styleJSON("custom", `"`+font.String()+`"`)+`}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(refs.FontAssets) != 1 || refs.FontAssets[0] != font || !strings.Contains(string(ok), `"style":{`) {
		t.Fatalf("refs = %#v widget = %s", refs, ok)
	}
	if _, _, err := ValidateWidget("main", []byte(`{"type":"empty","style":`+styleJSON("sans", "null")+`}`)); err != nil {
		t.Fatalf("builtin family rejected: %v", err)
	}
	plain := styleJSON("sans", "null")
	bad := map[string]string{
		"custom without font":  styleJSON("custom", "null"),
		"font without custom":  styleJSON("serif", `"`+font.String()+`"`),
		"unknown family":       styleJSON("comic", "null"),
		"missing field":        strings.Replace(plain, `"padding":2,`, "", 1),
		"extra field":          strings.Replace(plain, `"padding":2,`, `"padding":2,"margin":1,`, 1),
		"null number":          strings.Replace(plain, `"padding":2`, `"padding":null`, 1),
		"padding too large":    strings.Replace(plain, `"padding":2`, `"padding":11`, 1),
		"font scale too small": strings.Replace(plain, `"fontScale":150`, `"fontScale":24`, 1),
		"opacity too large":    strings.Replace(plain, `"backgroundOpacity":50`, `"backgroundOpacity":101`, 1),
		"uppercase colour":     strings.Replace(plain, `#ffffff`, `#FFFFFF`, 1),
		"short colour":         strings.Replace(plain, `#ffffff`, `#fff`, 1),
		"bad alignment":        strings.Replace(plain, `"center"`, `"middle"`, 1),
	}
	for name, style := range bad {
		t.Run(name, func(t *testing.T) {
			if _, _, err := ValidateWidget("main", []byte(`{"type":"clock","mode":"time","style":`+style+`}`)); err == nil {
				t.Fatal("invalid style accepted")
			}
		})
	}
}

func TestAnnouncementWidgetUsesBoxStyleField(t *testing.T) {
	raw := `{"type":"announcement","templateIds":[],"style":"card","size":"m","whenNone":"empty","fallbackText":"",` +
		`"whenMany":"rotate","rotateSeconds":10,"boxStyle":` + styleJSON("mono", "null") + `}`
	canonical, _, err := ValidateWidget("main", []byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(canonical), `"style":"card"`) || !strings.Contains(string(canonical), `"boxStyle":{`) {
		t.Fatalf("canonical = %s", canonical)
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
		`{"type":"text","text":"# Hi","size":"m","align":"start","format":"markdown","css":"p{color:red}","fontAssetIds":` + fontList(1) + `}`,
		`{"type":"text","text":"` + strings.Repeat("a", 20000) + `","size":"m","align":"start","format":"html"}`,
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
		"format":            `{"type":"text","text":"x","size":"m","align":"start","format":"rtf"}`,
		"css too long":      `{"type":"text","text":"x","size":"m","align":"start","css":"` + strings.Repeat("a", 20001) + `"}`,
		"too many fonts":    `{"type":"text","text":"x","size":"m","align":"start","fontAssetIds":` + fontList(11) + `}`,
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
		`{"type":"text","text":"hi","size":"m","align":"start"}`,
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
