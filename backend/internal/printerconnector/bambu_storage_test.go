package printerconnector

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
)

func TestClassifyBambuPrintSource(t *testing.T) {
	t.Parallel()
	const stale = "file:///media/usb0/cache/FlipOff_Ghostie.stl.gcode.3mf"
	const internalName = "Sticky Notes Holder.stl + Sticky Notes Holder.stl + Sticky Notes Holder.stl"
	cases := []struct {
		name, url, subtask string
		want               bambuPrintSource
	}{
		{"stale url of the previous print", stale, internalName, bambuSourceInternal},
		{"no url this session", "", internalName, bambuSourceInternal},
		{"fresh matching usb url", "file:///media/usb0/cache/Sticky%20Notes%20Holder.stl.gcode.3mf", "Sticky Notes Holder.stl", bambuSourceExternal},
		{"matching without extension in subtask", stale, "FlipOff_Ghostie.stl", bambuSourceExternal},
		{"matching case-insensitively", stale, "flipoff_ghostie.STL.gcode.3mf", bambuSourceExternal},
		{"sd card", "file:///mnt/sdcard/a.3mf", "a", bambuSourceExternal},
		{"sdcard root", "file:///sdcard/cache/a.gcode.3mf", "a", bambuSourceExternal},
		{"ftp path", "ftp://192.168.1.5/sdcard/a.gcode.3mf", "a", bambuSourceExternal},
		{"internal path url", "file:///data/Metadata/a.gcode.3mf", "a", bambuSourceInternal},
		{"unknown scheme", "http://media/usb0/a.3mf", "a", bambuSourceInternal},
		{"no subtask name trusts media url", stale, "", bambuSourceExternal},
		// Observed on an X1C: a print sent to its SD card over FTP reports only the file name.
		{"x1c ftp file name", "ftp://T-Abstandhalter_Dielen.stl + T-Abstandh....gcode.3mf", "T-Abstandhalter_Dielen.stl + T-Abstandh...", bambuSourceExternal},
		{"ftp file name of another print", "ftp://Other.gcode.3mf", internalName, bambuSourceInternal},
	}
	for _, tc := range cases {
		if got := classifyBambuPrintSource(tc.url, tc.subtask); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
}

func TestBambuInternalPath(t *testing.T) {
	t.Parallel()
	got := bambuInternalPath(map[string]any{"gcode_file": "/data/Metadata/plate_1.gcode", "file": "/data/Metadata/plate_1.gcode"})
	if got != "data_metadata_plate_1_gcode" {
		t.Fatalf("internal path: %q", got)
	}
}

const internalStoragePrint = `{"print":{"gcode_state":"RUNNING","task_id":"6585","job_id":"0","subtask_id":"0",` +
	`"subtask_name":"Sticky Notes Holder.stl + Sticky Notes Holder.stl","gcode_file":"/data/Metadata/plate_1.gcode",` +
	`"file":"/data/Metadata/plate_1.gcode","print_type":"local","mc_percent":3}}`

func artifactPaths(t *testing.T, observations []Observation) []string {
	t.Helper()
	var paths []string
	for _, observation := range observations {
		if observation.Kind != ObservationOperationalState && observation.Kind != ObservationProgress {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(observation.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		path, _ := payload["artifactPath"].(string)
		paths = append(paths, path)
	}
	return paths
}

func TestInternalStoragePrintIsReportedWhileRunningAndLookedUpOnceAfterwards(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestStore(t)
	assignmentID := ids.New()
	processor, err := newBambuProcessor(ctx, assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	// The previous print was a USB print; its url stays in the merged document.
	previous := `{"print":{"gcode_state":"FINISH","task_id":"6584","subtask_name":"FlipOff_Ghostie.stl",` +
		`"url":"file:///media/usb0/cache/FlipOff_Ghostie.stl.gcode.3mf"}}`
	if _, _, err = processor.apply(ctx, []byte(previous), at); err != nil {
		t.Fatal(err)
	}
	observations, _, err := processor.apply(ctx, []byte(internalStoragePrint), at.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if paths := artifactPaths(t, observations); len(paths) == 0 || strings.Join(paths, "") != "" {
		t.Fatalf("internal print must not schedule an archive path: %q", paths)
	}
	runID := *observations[0].RunID
	facts := processor.state.RunFacts[runID.String()]
	if facts.Source != bambuSourceInternal || facts.InternalPath != "data_metadata_plate_1_gcode" ||
		!strings.HasSuffix(facts.ArchiveCandidate, ".stl.gcode.3mf") {
		t.Fatalf("facts = %+v", facts)
	}

	adapter := &bambuH2DAdapter{assignmentID: assignmentID, configurationVersion: 1, store: store}
	if err = adapter.reportInternalStorage(ctx, observations, processor.state.RunFacts); err != nil {
		t.Fatal(err)
	}
	report := runReport(t, store, runID)
	if report.Consumption == nil || report.Consumption.State != "pending" ||
		*report.Consumption.Reason != "artifact_on_internal_storage" ||
		*report.Consumption.Detail != "data_metadata_plate_1_gcode" {
		t.Fatalf("running report = %+v", report.Consumption)
	}

	// The run ends: the archive is looked up by name once.
	ended, _, err := processor.apply(ctx, []byte(`{"print":{"gcode_state":"FINISH"}}`), at.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if err = processor.persist(ctx); err != nil {
		t.Fatal(err)
	}
	if err = adapter.noteRunsForRecordings(ctx, ended); err != nil {
		t.Fatal(err)
	}
	retrieval, err := store.PendingArtifactRetrieval(ctx, assignmentID)
	if err != nil || retrieval == nil || retrieval.ReportedPath != facts.ArchiveCandidate {
		t.Fatalf("fallback retrieval = %+v err=%v", retrieval, err)
	}
	// Not found on external storage: the run ends with the internal-storage reason.
	if err = adapter.reportArtifactProblem(ctx, runID, "unavailable", "artifact_not_available"); err != nil {
		t.Fatal(err)
	}
	report = runReport(t, store, runID)
	if report.Consumption.State != "unavailable" || *report.Consumption.Reason != "artifact_on_internal_storage" ||
		*report.Consumption.Detail != "data_metadata_plate_1_gcode" {
		t.Fatalf("final report = %+v", report.Consumption)
	}
}

func TestFreshUSBURLKeepsTheArchivePath(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	processor, err := newBambuProcessor(ctx, ids.New(), openTestStore(t))
	if err != nil {
		t.Fatal(err)
	}
	payload := `{"print":{"gcode_state":"RUNNING","task_id":"7","subtask_name":"Sticky Notes Holder.stl",` +
		`"gcode_file":"/data/Metadata/plate_1.gcode","url":"file:///media/usb0/cache/Sticky Notes Holder.stl.gcode.3mf"}}`
	observations, _, err := processor.apply(ctx, []byte(payload), time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range artifactPaths(t, observations) {
		if path != "Sticky Notes Holder.stl.gcode.3mf" {
			t.Fatalf("artifact path = %q", path)
		}
	}
	if facts := processor.state.RunFacts[observations[0].RunID.String()]; facts.Source != bambuSourceExternal {
		t.Fatalf("source = %q", facts.Source)
	}
}

// A connector started during an X1C print sent to the SD card over FTP missed the message carrying the url; the
// merged document's url names this print, so the print stays external.
func TestPrintStaysExternalWhenTheConnectorMissedTheURL(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestStore(t)
	processor, err := newBambuProcessor(ctx, ids.New(), store)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
	start := `{"print":{"gcode_state":"RUNNING","task_id":"7001","subtask_name":"T-Abstandhalter_Dielen.stl",` +
		`"gcode_file":"/data/Metadata/plate_1.gcode","print_type":"local","mc_percent":1,` +
		`"url":"ftp://T-Abstandhalter_Dielen.stl.gcode.3mf"}}`
	observations, _, err := processor.apply(ctx, []byte(start), at)
	if err != nil {
		t.Fatal(err)
	}
	runID := *observations[0].RunID
	// Run facts written before the url was tracked per run.
	facts := processor.state.RunFacts[runID.String()]
	facts.ReportedURL, facts.Source = "", ""
	processor.state.RunFacts[runID.String()] = facts

	if _, _, err = processor.apply(ctx, []byte(`{"print":{"mc_percent":22}}`), at.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if got := processor.state.RunFacts[runID.String()].Source; got != bambuSourceExternal {
		t.Fatalf("source = %q, want external", got)
	}
}
