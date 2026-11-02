package signage

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

func timelapseJSON(source string, machines []uuid.UUID, count, maxAgeDays, maxSeconds int, extra string) string {
	encoded, _ := json.Marshal(machines)
	if machines == nil {
		encoded = []byte("[]")
	}
	return `{"type":"timelapse","source":"` + source + `","machineIds":` + string(encoded) +
		`,"count":` + itoa(count) + `,"maxAgeDays":` + itoa(maxAgeDays) + `,"maxSeconds":` + itoa(maxSeconds) +
		`,"transition":"fade","showCaption":true,"fit":"cover"` + extra + `}`
}

func itoa(value int) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func TestTimelapseWidgetValidation(t *testing.T) {
	first, second := ids.New(), ids.New()
	canonical, refs, err := ValidateWidget("main", []byte(timelapseJSON("machines", []uuid.UUID{first, second}, 5, 30, 60,
		`,"style":`+styleJSON("sans", "null"))))
	if err != nil {
		t.Fatal(err)
	}
	if len(refs.Machines) != 2 || refs.Machines[0] != first || refs.Machines[1] != second {
		t.Fatalf("refs = %#v", refs)
	}
	for _, field := range []string{`"source":"machines"`, `"count":5`, `"maxAgeDays":30`, `"maxSeconds":60`, `"transition":"fade"`,
		`"showCaption":true`, `"fit":"cover"`, `"style":{`} {
		if !strings.Contains(string(canonical), field) {
			t.Fatalf("canonical %s lacks %s", canonical, field)
		}
	}
	all, refs, err := ValidateWidget("main", []byte(timelapseJSON("all", nil, 1, 0, 5, "")))
	if err != nil || len(refs.Machines) != 0 || !strings.Contains(string(all), `"machineIds":[]`) {
		t.Fatalf("all source: %s %#v %v", all, refs, err)
	}
	if _, _, err := ValidateWidget("main", []byte(`{"type":"timelapse","source":"all","count":20,"maxAgeDays":365,`+
		`"maxSeconds":600,"transition":"cut","showCaption":false,"fit":"contain"}`)); err != nil {
		t.Fatalf("missing machineIds with all rejected: %v", err)
	}
	many := make([]uuid.UUID, 21)
	for index := range many {
		many[index] = ids.New()
	}
	valid := timelapseJSON("machines", []uuid.UUID{first}, 5, 30, 60, "")
	bad := map[string]string{
		"all with machines":     timelapseJSON("all", []uuid.UUID{first}, 5, 30, 60, ""),
		"machines without list": timelapseJSON("machines", nil, 5, 30, 60, ""),
		"duplicate machines":    timelapseJSON("machines", []uuid.UUID{first, first}, 5, 30, 60, ""),
		"too many machines":     timelapseJSON("machines", many, 5, 30, 60, ""),
		"unknown source":        strings.Replace(valid, `"machines"`, `"camera"`, 1),
		"count zero":            timelapseJSON("machines", []uuid.UUID{first}, 0, 30, 60, ""),
		"count too large":       timelapseJSON("machines", []uuid.UUID{first}, 21, 30, 60, ""),
		"negative age":          timelapseJSON("machines", []uuid.UUID{first}, 5, -1, 60, ""),
		"age too large":         timelapseJSON("machines", []uuid.UUID{first}, 5, 366, 60, ""),
		"seconds too small":     timelapseJSON("machines", []uuid.UUID{first}, 5, 30, 4, ""),
		"seconds too large":     timelapseJSON("machines", []uuid.UUID{first}, 5, 30, 601, ""),
		"bad transition":        strings.Replace(valid, `"fade"`, `"slide"`, 1),
		"bad fit":               strings.Replace(valid, `"cover"`, `"stretch"`, 1),
		"unknown field":         strings.Replace(valid, `"fit":"cover"`, `"fit":"cover","jobName":"x"`, 1),
		"bad style":             timelapseJSON("machines", []uuid.UUID{first}, 5, 30, 60, `,"style":{}`),
	}
	for name, raw := range bad {
		t.Run(name, func(t *testing.T) {
			if _, _, err := ValidateWidget("main", []byte(raw)); err == nil {
				t.Fatalf("invalid widget accepted: %s", raw)
			}
		})
	}
}

// Timelapse machines are checked to exist but never join the live machine list or the cameras.
func TestTimelapseMachinesStayOutOfLiveMachines(t *testing.T) {
	machine := ids.New()
	manifest := Manifest{Scenes: []ManifestScene{{Zones: map[string]json.RawMessage{
		"main": json.RawMessage(timelapseJSON("machines", []uuid.UUID{machine}, 3, 7, 30, "")),
	}}}}
	if got := ManifestMachineIDs(manifest); len(got) != 0 {
		t.Fatalf("live machines = %v", got)
	}
	if got, all := ManifestCameraMachineIDs(manifest); len(got) != 0 || all {
		t.Fatalf("cameras = %v all=%v", got, all)
	}
}

func TestTimelapseNeedsMergeByMachinesAndAge(t *testing.T) {
	first, second := ids.New(), ids.New()
	zones := func(widgets ...string) map[string]json.RawMessage {
		result := map[string]json.RawMessage{}
		for index, widget := range widgets {
			result[string(rune('a'+index))] = json.RawMessage(widget)
		}
		return result
	}
	manifest := Manifest{Scenes: []ManifestScene{
		{Zones: zones(
			timelapseJSON("machines", []uuid.UUID{first, second}, 2, 30, 60, ""),
			timelapseJSON("machines", []uuid.UUID{second, first}, 5, 30, 60, ""),
			timelapseJSON("machines", []uuid.UUID{first}, 4, 30, 60, ""),
		)},
		{Zones: zones(
			timelapseJSON("all", nil, 3, 0, 60, ""),
			timelapseJSON("all", nil, 3, 7, 60, ""),
			`{"type":"clock","mode":"time"}`,
		)},
	}}
	needs, present := timelapseNeedsOf(manifest)
	if !present || len(needs) != 4 {
		t.Fatalf("needs = %#v present=%v", needs, present)
	}
	counts := map[int]int{}
	for _, need := range needs {
		if !need.all && len(need.machines) == 2 {
			counts[2] = need.count
		}
	}
	if counts[2] != 5 {
		t.Fatalf("the same machines and age must share the largest count: %#v", needs)
	}
	if _, present := timelapseNeedsOf(Manifest{Scenes: []ManifestScene{{Zones: zones(`{"type":"empty"}`)}}}); present {
		t.Fatal("a publication without timelapse widget reports one")
	}
}
