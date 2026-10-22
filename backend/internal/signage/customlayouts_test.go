package signage

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func gridZone(id string, col, row, colSpan, rowSpan int) CustomZone {
	return CustomZone{ID: id, Label: strings.ToUpper(id), Grid: &GridPlacement{Col: col, Row: row, ColSpan: colSpan, RowSpan: rowSpan}}
}

func freeZone(id string, x, y, width, height float64) CustomZone {
	return CustomZone{ID: id, Label: strings.ToUpper(id), Rect: &FreeRect{X: x, Y: y, Width: width, Height: height}}
}

func TestValidateCustomLayoutGrid(t *testing.T) {
	valid := CustomLayoutInput{
		Name:    "  Wall  ",
		Mode:    LayoutModeGrid,
		Columns: []int{2, 1},
		Rows:    []int{1, 1},
		Zones:   []CustomZone{gridZone("a", 1, 1, 1, 2), gridZone("b", 2, 1, 1, 1)}, // cell (2,2) stays empty
	}
	checked, err := validateCustomLayout(valid)
	if err != nil {
		t.Fatal(err)
	}
	if checked.Name != "Wall" || len(checked.Zones) != 2 {
		t.Fatalf("checked = %#v", checked)
	}
	cases := map[string]func(*CustomLayoutInput){
		"no zones":        func(l *CustomLayoutInput) { l.Zones = nil },
		"too many zones":  func(l *CustomLayoutInput) { l.Zones = manyGridZones(13) },
		"bad mode":        func(l *CustomLayoutInput) { l.Mode = "diagonal" },
		"empty name":      func(l *CustomLayoutInput) { l.Name = "  " },
		"no columns":      func(l *CustomLayoutInput) { l.Columns = nil },
		"zero weight":     func(l *CustomLayoutInput) { l.Columns = []int{0, 1} },
		"heavy weight":    func(l *CustomLayoutInput) { l.Rows = []int{101} },
		"thirteen tracks": func(l *CustomLayoutInput) { l.Rows = make([]int, 13) },
		"overlap": func(l *CustomLayoutInput) {
			l.Zones = []CustomZone{gridZone("a", 1, 1, 2, 1), gridZone("b", 2, 1, 1, 2)}
		},
		"out of columns": func(l *CustomLayoutInput) { l.Zones = []CustomZone{gridZone("a", 2, 1, 2, 1)} },
		"out of rows":    func(l *CustomLayoutInput) { l.Zones = []CustomZone{gridZone("a", 1, 2, 1, 2)} },
		"zero span":      func(l *CustomLayoutInput) { l.Zones = []CustomZone{gridZone("a", 1, 1, 0, 1)} },
		"duplicate id": func(l *CustomLayoutInput) {
			l.Zones = []CustomZone{gridZone("a", 1, 1, 1, 1), gridZone("a", 2, 1, 1, 1)}
		},
		"bad id":       func(l *CustomLayoutInput) { l.Zones = []CustomZone{gridZone("A-1", 1, 1, 1, 1)} },
		"missing grid": func(l *CustomLayoutInput) { l.Zones = []CustomZone{{ID: "a", Label: "A"}} },
		"rect in grid": func(l *CustomLayoutInput) { l.Zones = []CustomZone{freeZone("a", 0, 0, 10, 10)} },
		"empty label": func(l *CustomLayoutInput) {
			l.Zones = []CustomZone{{ID: "a", Label: " ", Grid: &GridPlacement{1, 1, 1, 1}}}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			input := valid
			input.Columns, input.Rows = []int{2, 1}, []int{1, 1}
			mutate(&input)
			if _, err := validateCustomLayout(input); err == nil {
				t.Fatal("invalid layout accepted")
			}
		})
	}
}

func manyGridZones(n int) []CustomZone {
	zones := make([]CustomZone, 0, n)
	for index := 0; index < n; index++ {
		zones = append(zones, gridZone("z"+string(rune('a'+index)), index+1, 1, 1, 1))
	}
	return zones
}

func TestValidateCustomLayoutFree(t *testing.T) {
	valid := CustomLayoutInput{
		Name:    "Free",
		Mode:    LayoutModeFree,
		Columns: []int{5, 5},
		Rows:    []int{7},
		Zones:   []CustomZone{freeZone("a", 0, 0, 60.5, 100), freeZone("b", 50, 10.25, 49.75, 30)}, // overlap is allowed
	}
	checked, err := validateCustomLayout(valid)
	if err != nil {
		t.Fatal(err)
	}
	if len(checked.Columns) != 1 || checked.Columns[0] != 1 || len(checked.Rows) != 1 || checked.Rows[0] != 1 {
		t.Fatalf("free layouts must store {1}/{1}, got %v %v", checked.Columns, checked.Rows)
	}
	cases := map[string]CustomZone{
		"three decimals": freeZone("a", 0.125, 0, 10, 10),
		"negative x":     freeZone("a", -1, 0, 10, 10),
		"too narrow":     freeZone("a", 0, 0, 0.99, 10),
		"too short":      freeZone("a", 0, 0, 10, 0.5),
		"beyond right":   freeZone("a", 90.01, 0, 10, 10),
		"beyond bottom":  freeZone("a", 0, 99.5, 10, 1),
		"grid in free":   {ID: "a", Label: "A", Grid: &GridPlacement{1, 1, 1, 1}},
		"both":           {ID: "a", Label: "A", Rect: &FreeRect{0, 0, 10, 10}, Grid: &GridPlacement{1, 1, 1, 1}},
	}
	for name, zone := range cases {
		t.Run(name, func(t *testing.T) {
			input := valid
			input.Zones = []CustomZone{zone}
			if _, err := validateCustomLayout(input); err == nil {
				t.Fatal("invalid free layout accepted")
			}
		})
	}
	edge := valid
	edge.Zones = []CustomZone{freeZone("a", 0.1, 0.2, 99.9, 99.8)}
	if _, err := validateCustomLayout(edge); err != nil {
		t.Fatalf("exact edge rejected: %v", err)
	}
}

func TestReconcileZonesKeepsExistingAndFillsNew(t *testing.T) {
	clock := RawWidget(`{"type":"clock","mode":"time"}`)
	stored := map[string]RawWidget{"a": clock, "gone": clock}
	got, changed := reconcileZones(stored, []string{"a", "fresh"})
	if !changed || string(got["a"]) != string(clock) || string(got["fresh"]) != string(emptyWidget) || len(got) != 2 {
		t.Fatalf("reconciled = %v changed = %v", got, changed)
	}
	if _, changed := reconcileZones(map[string]RawWidget{"a": clock}, []string{"a"}); changed {
		t.Fatal("unchanged zone set reported as changed")
	}
}

func TestCalendarRangeAt(t *testing.T) {
	vienna, err := time.LoadLocation("Europe/Vienna")
	if err != nil {
		t.Fatal(err)
	}
	// 2026-10-22 22:30 UTC is already 23 Oct 00:30 in Vienna (CEST, +2).
	span := calendarRangeAt(time.Date(2026, 10, 22, 22, 30, 0, 0, time.UTC), vienna)
	if got := span.From.Format("2006-01-02"); got != "2026-09-24" {
		t.Fatalf("from = %s, want 7 days before 1 Oct", got)
	}
	if got := span.To.Format("2006-01-02"); got != "2026-12-11" {
		t.Fatalf("to = %s, want 49 days after 23 Oct", got)
	}
	if !span.Start.Equal(time.Date(2026, 9, 23, 22, 0, 0, 0, time.UTC)) {
		t.Fatalf("start = %s", span.Start.UTC())
	}
	// The end is exclusive: local midnight after 11 Dec (CET, +1).
	if !span.End.Equal(time.Date(2026, 12, 11, 23, 0, 0, 0, time.UTC)) {
		t.Fatalf("end = %s", span.End.UTC())
	}
	january := calendarRangeAt(time.Date(2027, 1, 1, 12, 0, 0, 0, time.UTC), vienna)
	if january.From.Format("2006-01-02") != "2026-12-25" || january.To.Format("2006-01-02") != "2027-02-19" {
		t.Fatalf("january range = %v..%v", january.From, january.To)
	}
}

func TestCalendarCategoriesOnlyFromPublishedCalendarWidgets(t *testing.T) {
	scene := func(zones ...string) ManifestScene {
		result := ManifestScene{ID: ids.New(), Zones: map[string]json.RawMessage{}}
		for index, zone := range zones {
			result.Zones[string(rune('a'+index))] = json.RawMessage(zone)
		}
		return result
	}
	if _, present := calendarCategoriesOf(Manifest{Scenes: []ManifestScene{scene(`{"type":"events","count":3}`)}}); present {
		t.Fatal("a manifest without calendar widget must not get a calendar block")
	}
	manifest := Manifest{Scenes: []ManifestScene{
		scene(`{"type":"calendar","showHolidays":true,"showBreaks":false,"showOpenDays":false,"showEvents":false}`),
		scene(`{"type":"calendar","showHolidays":false,"showBreaks":false,"showOpenDays":true,"showEvents":false}`),
	}}
	categories, present := calendarCategoriesOf(manifest)
	if !present || !categories.holidays || !categories.openDays || categories.breaks || categories.events {
		t.Fatalf("categories = %#v present = %v", categories, present)
	}
}
