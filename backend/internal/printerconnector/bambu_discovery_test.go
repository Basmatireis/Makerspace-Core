package printerconnector

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

// synthetic3MF builds a small Bambu-style archive whose slice_info names the
// project and its layer count and whose plate G-code supports an estimate.
func synthetic3MF(t *testing.T, jobName string, layers int) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	config := `<?xml version="1.0"?><config><plate id="1"/>` +
		`<filament id="1" type="PLA" used_mm="100" used_g="0.3" density="1.24" diameter="1.75" extruder="0"/>`
	if jobName != "" {
		config += `<metadata key="job_name" value="` + jobName + `"/>`
	}
	if layers > 0 {
		config += fmt.Sprintf(`<metadata key="layer_count" value="%d"/>`, layers)
	}
	config += `</config>`
	entries := map[string]string{
		"Metadata/slice_info.config": config,
		"Metadata/plate_1.gcode":     "M82\nG92 E0\n; layer: 0\nG1 E10\nM73 P25\n; layer: 1\nG1 E20\nM73 P80\n; layer: 2\n",
	}
	for name, content := range entries {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func artifactAdapter(t *testing.T, store *Store, server *fakeFTPS) *bambuH2DAdapter {
	t.Helper()
	return &bambuH2DAdapter{
		kind:                 AdapterBambuH2D,
		assignmentID:         ids.New(),
		configurationVersion: 2,
		store:                store,
		newFTPS:              func(context.Context) (bambuFTPS, error) { return server, nil },
	}
}

func saveRunFacts(t *testing.T, adapter *bambuH2DAdapter, runID uuid.UUID, facts bambuRunFacts) {
	t.Helper()
	state, _, err := adapter.store.BambuStateFor(context.Background(), adapter.assignmentID, adapter.kind)
	if err != nil {
		t.Fatal(err)
	}
	if state.RunFacts == nil {
		state.RunFacts = map[string]bambuRunFacts{}
	}
	state.RunFacts[runID.String()] = facts
	if err = adapter.store.SaveBambuStateFor(context.Background(), adapter.assignmentID, adapter.kind, state); err != nil {
		t.Fatal(err)
	}
}

func scheduleLookup(t *testing.T, adapter *bambuH2DAdapter, runID uuid.UUID, facts bambuRunFacts) {
	t.Helper()
	saveRunFacts(t, adapter, runID, facts)
	observation := Observation{Kind: ObservationProgress, RunID: &runID, Payload: mustJSON(map[string]any{"fileName": facts.PrintName})}
	if err := adapter.scheduleArtifactRetrievals(
		context.Background(), []Observation{observation}, map[string]bambuRunFacts{runID.String(): facts},
	); err != nil {
		t.Fatal(err)
	}
}

type retrievalRow struct {
	state, reason, candidate string
	attempts                 int
}

func lookupRow(t *testing.T, store *Store, runID uuid.UUID) retrievalRow {
	t.Helper()
	var row retrievalRow
	if err := store.db.QueryRow(
		`SELECT state,coalesce(reason_code,''),coalesce(candidate_path,''),attempt_count FROM artifact_retrievals WHERE run_id=?`,
		runID.String(),
	).Scan(&row.state, &row.reason, &row.candidate, &row.attempts); err != nil {
		t.Fatalf("retrieval row for %s: %v", runID, err)
	}
	return row
}

// dueNow makes the run's lookup due without waiting for its backoff.
func dueNow(t *testing.T, store *Store, runID uuid.UUID) {
	t.Helper()
	past := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	if _, err := store.db.Exec(`UPDATE artifact_retrievals SET next_attempt_at=? WHERE run_id=?`, past, runID.String()); err != nil {
		t.Fatal(err)
	}
}

func runEndedAgo(t *testing.T, store *Store, runID uuid.UUID, ago time.Duration) {
	t.Helper()
	at := time.Now().UTC().Add(-ago).Format(time.RFC3339Nano)
	if _, err := store.db.Exec(`UPDATE artifact_retrievals SET run_ended_at=? WHERE run_id=?`, at, runID.String()); err != nil {
		t.Fatal(err)
	}
}

// retrieveUntilSettled drives the worker until the run's retrieval left the
// pending state or the step budget is spent.
func retrieveUntilSettled(t *testing.T, adapter *bambuH2DAdapter, runID uuid.UUID, steps int) retrievalRow {
	t.Helper()
	for range steps {
		dueNow(t, adapter.store, runID)
		if _, err := adapter.retrieveOneArtifact(context.Background()); err != nil {
			t.Fatalf("retrieval step: %v", err)
		}
		if row := lookupRow(t, adapter.store, runID); row.state != "pending" {
			return row
		}
	}
	return lookupRow(t, adapter.store, runID)
}

func transfersFor(t *testing.T, store *Store, runID uuid.UUID) []ArtifactTransfer {
	t.Helper()
	rows, err := store.db.Query(
		`SELECT id,assignment_id,run_id,configuration_version,remote_path,file_name,staged_path,size_bytes,sha256,attempt_count,expires_at FROM artifact_transfers WHERE run_id=?`,
		runID.String(),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	transfers, err := scanArtifactTransfers(rows)
	if err != nil {
		t.Fatal(err)
	}
	return transfers
}

func consumptionReports(t *testing.T, store *Store, runID uuid.UUID) int {
	t.Helper()
	var count int
	if err := store.db.QueryRow(
		`SELECT count(*) FROM outbox WHERE run_id=? AND kind='consumption_report'`, runID.String(),
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestRunFactsKeepArchiveEvidenceWhateverThePrintSource(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	at := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	apply := func(t *testing.T, payloads ...string) bambuRunFacts {
		t.Helper()
		processor, err := newBambuProcessor(ctx, ids.New(), openTestStore(t))
		if err != nil {
			t.Fatal(err)
		}
		var runID *uuid.UUID
		for index, payload := range payloads {
			observations, _, applyErr := processor.apply(ctx, []byte(payload), at.Add(time.Duration(index)*time.Minute))
			if applyErr != nil {
				t.Fatal(applyErr)
			}
			for _, observation := range observations {
				if observation.RunID != nil {
					runID = observation.RunID
				}
			}
		}
		if runID == nil {
			t.Fatal("no run observed")
		}
		return processor.state.RunFacts[runID.String()]
	}

	// A print from internal storage keeps the name its archive would carry on external storage.
	internal := apply(t, `{"print":{"gcode_state":"RUNNING","task_id":"1","subtask_name":"Sticky Notes Holder.stl",`+
		`"gcode_file":"/data/Metadata/plate_1.gcode","total_layer_num":147,"mc_percent":3}}`)
	if internal.Source != bambuSourceInternal || internal.PrintName != "Sticky Notes Holder.stl" ||
		internal.ArchiveCandidate != "Sticky Notes Holder.stl.gcode.3mf" || internal.ArchivePath != "" ||
		internal.TotalLayers == nil || *internal.TotalLayers != 147 {
		t.Fatalf("internal print facts = %+v", internal)
	}
	// A USB print whose url names it yields the archive's FTPS path.
	usb := apply(t, `{"print":{"gcode_state":"RUNNING","task_id":"2","subtask_name":"Sticky Notes Holder.stl",`+
		`"gcode_file":"/data/Metadata/plate_1.gcode","url":"file:///media/usb0/cache/Sticky%20Notes%20Holder.stl.gcode.3mf"}}`)
	if usb.Source != bambuSourceExternal || usb.ArchivePath != "/cache/Sticky Notes Holder.stl.gcode.3mf" {
		t.Fatalf("usb print facts = %+v", usb)
	}
	// The previous print's url is no evidence for this print's location: only the name remains.
	stale := apply(t,
		`{"print":{"gcode_state":"FINISH","task_id":"3","subtask_name":"Ghostie","url":"file:///media/usb0/cache/Ghostie.gcode.3mf"}}`,
		`{"print":{"gcode_state":"RUNNING","task_id":"4","subtask_name":"Holder","gcode_file":"/data/Metadata/plate_1.gcode"}}`,
	)
	if stale.Source != bambuSourceInternal || stale.ArchivePath != "" || stale.ArchiveCandidate != "Holder.gcode.3mf" {
		t.Fatalf("stale url facts = %+v", stale)
	}
	// An X1C names only the file over ftp: external, but the directory is unknown.
	x1c := apply(t, `{"print":{"gcode_state":"RUNNING","task_id":"5","subtask_name":"T-Abstandhalter.stl",`+
		`"gcode_file":"/data/Metadata/plate_1.gcode","url":"ftp://T-Abstandhalter.stl.gcode.3mf"}}`)
	if x1c.Source != bambuSourceExternal || x1c.ArchivePath != "" || x1c.ArchiveCandidate != "T-Abstandhalter.stl.gcode.3mf" {
		t.Fatalf("x1c facts = %+v", x1c)
	}
}

func TestBambuFTPSArchivePathMapsExternalMediaOnly(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"file:///media/usb0/cache/Part.gcode.3mf":    "/cache/Part.gcode.3mf",
		"file:///media/usb0/Part.gcode.3mf":          "/Part.gcode.3mf",
		"file:///mnt/sdcard/cache/Part%20A.3mf":      "/cache/Part A.3mf",
		"file:///sdcard/Part.3mf":                    "/Part.3mf",
		"ftp://192.168.1.5/cache/Part.gcode.3mf":     "/cache/Part.gcode.3mf",
		"ftp://Part.gcode.3mf":                       "",
		"file:///media/usb0/deep/dir/Part.gcode.3mf": "",
		"file:///data/Metadata/plate_1.gcode":        "",
		"/data/Metadata/plate_1.gcode":               "",
		"/cache/Part.gcode.3mf":                      "/cache/Part.gcode.3mf",
		"Part.gcode.3mf":                             "",
		"http://media/usb0/Part.3mf":                 "",
	}
	for raw, want := range cases {
		if got := bambuFTPSArchivePath(raw); got != want {
			t.Errorf("%s: got %q, want %q", raw, got, want)
		}
	}
}

func TestArtifactDiscoveryFollowsTheEvidenceInOrder(t *testing.T) {
	t.Parallel()
	entry := func(name string, size int64) FTPEntry { return FTPEntry{Name: name, Size: size} }
	paths := func(candidates []ArtifactCandidate) string {
		var names []string
		for _, candidate := range candidates {
			names = append(names, candidate.RemotePath)
		}
		return strings.Join(names, ",")
	}
	cases := []struct {
		name     string
		evidence artifactEvidence
		listings map[string][]FTPEntry
		want     string
		err      error
	}{
		{
			"explicit path wins over a same-named file elsewhere",
			artifactEvidence{ExplicitPath: "/Part.gcode.3mf", Names: []string{"Part.gcode.3mf"}},
			map[string][]FTPEntry{"/cache": {entry("Part.gcode.3mf", 10)}, "/": {entry("Part.gcode.3mf", 20)}},
			"/Part.gcode.3mf", nil,
		},
		{
			"only in /cache",
			artifactEvidence{Names: []string{"Part.gcode.3mf"}},
			map[string][]FTPEntry{"/cache": {entry("Part.gcode.3mf", 10)}, "/": {entry("Other.gcode.3mf", 20)}},
			"/cache/Part.gcode.3mf", nil,
		},
		{
			"only in /",
			artifactEvidence{Names: []string{"Part.gcode.3mf"}},
			map[string][]FTPEntry{"/cache": {}, "/": {entry("Part.gcode.3mf", 20)}},
			"/Part.gcode.3mf", nil,
		},
		{
			"same name in both directories is a pair to compare",
			artifactEvidence{Names: []string{"Part.gcode.3mf"}},
			map[string][]FTPEntry{"/cache": {entry("Part.gcode.3mf", 10)}, "/": {entry("Part.gcode.3mf", 10)}},
			"/cache/Part.gcode.3mf,/Part.gcode.3mf", nil,
		},
		{
			"missing url: the print name finds the archive",
			artifactEvidence{Names: []string{"Käfig Teil.gcode.3mf"}, PrintName: "Käfig Teil"},
			map[string][]FTPEntry{"/cache": {entry("Käfig  Teil.3mf", 10)}},
			"/cache/Käfig  Teil.3mf", nil,
		},
		{
			"special characters compare literally",
			artifactEvidence{Names: []string{"A (v2) + B #3.gcode.3mf"}},
			map[string][]FTPEntry{"/": {entry("a (v2) + b #3.GCODE.3MF", 10), entry("A (v2) + B #4.gcode.3mf", 10)}},
			"/a (v2) + b #3.GCODE.3MF", nil,
		},
		{
			"similar names do not match each other",
			artifactEvidence{Names: []string{"Part A.gcode.3mf"}, PrintName: "Part A"},
			map[string][]FTPEntry{"/cache": {entry("Part AB.gcode.3mf", 10), entry("Part A2.gcode.3mf", 10)}},
			"", errArtifactNotAvailable,
		},
		{
			"truncated print name matches one archive as a prefix",
			artifactEvidence{PrintName: "Very long print name tha..."},
			map[string][]FTPEntry{"/cache": {entry("Very long print name that goes on.gcode.3mf", 10), entry("Other.3mf", 1)}},
			"/cache/Very long print name that goes on.gcode.3mf", nil,
		},
		{
			"truncated print name matching two archives is ambiguous",
			artifactEvidence{PrintName: "Very long print name tha..."},
			map[string][]FTPEntry{"/cache": {entry("Very long print name that goes on.gcode.3mf", 10), entry("Very long print name that ends.gcode.3mf", 10)}},
			"", errArtifactAmbiguous,
		},
		{
			"a name that is not an archive never matches",
			artifactEvidence{Names: []string{"Part.stl.gcode.3mf"}},
			map[string][]FTPEntry{"/cache": {entry("Part.stl", 10)}},
			"", errArtifactNotAvailable,
		},
		{
			"two spellings of the name in one directory are ambiguous",
			artifactEvidence{Names: []string{"Part.gcode.3mf"}},
			map[string][]FTPEntry{"/cache": {entry("part.gcode.3mf", 10), entry("PART.gcode.3mf", 11)}},
			"", errArtifactAmbiguous,
		},
	}
	for _, tc := range cases {
		candidates, err := discoverArtifacts(tc.evidence, tc.listings)
		if !errors.Is(err, tc.err) || paths(candidates) != tc.want {
			t.Errorf("%s: got %q err=%v, want %q err=%v", tc.name, paths(candidates), err, tc.want, tc.err)
		}
	}

	// The retrieval's own reported path and the run facts combine; an internal G-code path is never a location.
	facts := bambuRunFacts{
		PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf", ArchivePath: "/cache/Holder.gcode.3mf",
		InternalPath: "data_metadata_plate_1_gcode",
	}
	evidence := artifactEvidenceFor("Holder.gcode.3mf", facts, true)
	if evidence.ExplicitPath != "/cache/Holder.gcode.3mf" || len(evidence.Names) != 1 || evidence.PrintName != "Holder" {
		t.Fatalf("evidence = %+v", evidence)
	}
	if evidence = artifactEvidenceFor("/data/Metadata/plate_1.gcode", bambuRunFacts{}, false); evidence.ExplicitPath != "" ||
		len(evidence.Names) != 0 {
		t.Fatalf("internal path became evidence: %+v", evidence)
	}
}

func TestInternalPrintWithAnExternalArchiveIsRetrievedAndBookedOnce(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestStore(t)
	archive := synthetic3MF(t, "Sticky Notes Holder.stl + Sticky Notes Holder.stl", 0)
	server := &fakeFTPS{files: map[string][]byte{"/cache/Sticky Notes Holder.stl + Sticky Notes Holder.stl.gcode.3mf": archive}}
	adapter := artifactAdapter(t, store, server)
	processor, err := newBambuProcessor(ctx, adapter.assignmentID, store)
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	observations, _, err := processor.apply(ctx, []byte(internalStoragePrint), at)
	if err != nil {
		t.Fatal(err)
	}
	if err = processor.persist(ctx); err != nil {
		t.Fatal(err)
	}
	runID := *observations[0].RunID
	if err = adapter.reportInternalStorage(ctx, observations, processor.state.RunFacts); err != nil {
		t.Fatal(err)
	}
	if err = adapter.scheduleArtifactRetrievals(ctx, observations, processor.state.RunFacts); err != nil {
		t.Fatal(err)
	}
	if report := runReport(t, store, runID); *report.Consumption.Reason != "artifact_on_internal_storage" {
		t.Fatalf("report while looking = %+v", report.Consumption)
	}
	if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "staged" {
		t.Fatalf("retrieval = %+v", row)
	}
	transfers := transfersFor(t, store, runID)
	if len(transfers) != 1 || transfers[0].RemotePath != "/cache/Sticky Notes Holder.stl + Sticky Notes Holder.stl.gcode.3mf" ||
		transfers[0].SHA256 != sha256Hex(archive) {
		t.Fatalf("transfers = %+v", transfers)
	}
	if report := runReport(t, store, runID); report.Consumption.State != "pending" ||
		*report.Consumption.Reason != "consumption_pending" {
		t.Fatalf("report after staging = %+v", report.Consumption)
	}
	// Later progress neither reopens the lookup nor flips the report back to the storage diagnostic.
	progress, _, err := processor.apply(ctx, []byte(`{"print":{"mc_percent":40}}`), at.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if err = adapter.reportInternalStorage(ctx, progress, processor.state.RunFacts); err != nil {
		t.Fatal(err)
	}
	if err = adapter.scheduleArtifactRetrievals(ctx, progress, processor.state.RunFacts); err != nil {
		t.Fatal(err)
	}
	if row := lookupRow(t, store, runID); row.state != "staged" {
		t.Fatalf("progress reopened the retrieval: %+v", row)
	}
	if report := runReport(t, store, runID); *report.Consumption.Reason != "consumption_pending" {
		t.Fatalf("progress overwrote the report: %+v", report.Consumption)
	}
	// The run ends: the consumption is calculated from the archive exactly once.
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
	for range 2 {
		if err = adapter.processArtifactConsumptions(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if count := consumptionReports(t, store, runID); count != 1 {
		t.Fatalf("consumption reports = %d, want exactly one", count)
	}
	if report := runReport(t, store, runID); report.Consumption.State != "reported" {
		t.Fatalf("final report = %+v", report.Consumption)
	}
}

func TestArchiveIsFoundInEitherDirectory(t *testing.T) {
	t.Parallel()
	for _, directory := range []string{"/", "/cache"} {
		t.Run(directory, func(t *testing.T) {
			t.Parallel()
			archive := synthetic3MF(t, "Holder", 0)
			remote := strings.TrimSuffix(directory, "/") + "/Holder.gcode.3mf"
			server := &fakeFTPS{files: map[string][]byte{remote: archive, "/timelapse/video.mp4": []byte("x")}}
			adapter := artifactAdapter(t, openTestStore(t), server)
			runID := ids.New()
			scheduleLookup(t, adapter, runID, bambuRunFacts{
				Source: bambuSourceInternal, PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf",
			})
			if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "staged" {
				t.Fatalf("retrieval = %+v", row)
			}
			if transfers := transfersFor(t, adapter.store, runID); len(transfers) != 1 || transfers[0].RemotePath != remote {
				t.Fatalf("transfers = %+v", transfers)
			}
		})
	}
}

func TestIdenticalArchivesInBothDirectoriesAreOneArtifact(t *testing.T) {
	t.Parallel()
	archive := synthetic3MF(t, "Holder", 0)
	server := &fakeFTPS{files: map[string][]byte{"/cache/Holder.gcode.3mf": archive, "/Holder.gcode.3mf": archive}}
	adapter := artifactAdapter(t, openTestStore(t), server)
	runID := ids.New()
	scheduleLookup(t, adapter, runID, bambuRunFacts{PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf"})
	if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "staged" {
		t.Fatalf("retrieval = %+v", row)
	}
	transfers := transfersFor(t, adapter.store, runID)
	if len(transfers) != 1 || transfers[0].RemotePath != "/cache/Holder.gcode.3mf" || transfers[0].SHA256 != sha256Hex(archive) {
		t.Fatalf("transfers = %+v", transfers)
	}
}

func TestDifferentArchivesWithTheSameNameNeedRunEvidence(t *testing.T) {
	t.Parallel()
	short, long := synthetic3MF(t, "Holder", 120), synthetic3MF(t, "Holder", 200)
	files := func() map[string][]byte {
		return map[string][]byte{"/cache/Holder.gcode.3mf": short, "/Holder.gcode.3mf": long}
	}

	// The printer's layer count singles one archive out.
	layers := 200
	adapter := artifactAdapter(t, openTestStore(t), &fakeFTPS{files: files()})
	runID := ids.New()
	scheduleLookup(t, adapter, runID, bambuRunFacts{
		Source: bambuSourceInternal, PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf", TotalLayers: &layers,
	})
	if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "staged" {
		t.Fatalf("retrieval = %+v", row)
	}
	if transfers := transfersFor(t, adapter.store, runID); len(transfers) != 1 || transfers[0].RemotePath != "/Holder.gcode.3mf" ||
		transfers[0].SHA256 != sha256Hex(long) {
		t.Fatalf("transfers = %+v", transfers)
	}

	// Without evidence nothing is guessed, and the storage the print ran from is not blamed.
	adapter = artifactAdapter(t, openTestStore(t), &fakeFTPS{files: files()})
	runID = ids.New()
	scheduleLookup(t, adapter, runID, bambuRunFacts{
		Source: bambuSourceInternal, InternalPath: "data_metadata_plate_1_gcode", PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf",
	})
	if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "quarantined" || row.reason != "artifact_ambiguous" {
		t.Fatalf("retrieval = %+v", row)
	}
	if transfers := transfersFor(t, adapter.store, runID); len(transfers) != 0 {
		t.Fatalf("an ambiguous archive was staged: %+v", transfers)
	}
	report := runReport(t, adapter.store, runID)
	if report.Consumption.State != "unavailable" || *report.Consumption.Reason != "artifact_not_found_on_printer" ||
		*report.Consumption.Detail != "artifact_ambiguous" {
		t.Fatalf("report = %+v", report.Consumption)
	}
}

func TestArchiveAppearingAfterFailedLookupsIsRetrieved(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	server := &fakeFTPS{files: map[string][]byte{}}
	adapter := artifactAdapter(t, openTestStore(t), server)
	runID := ids.New()
	scheduleLookup(t, adapter, runID, bambuRunFacts{
		Source: bambuSourceInternal, InternalPath: "data_metadata_plate_1_gcode", PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf",
	})
	for attempt := 1; attempt <= 3; attempt++ {
		dueNow(t, adapter.store, runID)
		if _, err := adapter.retrieveOneArtifact(ctx); err != nil {
			t.Fatal(err)
		}
		row := lookupRow(t, adapter.store, runID)
		if row.state != "pending" || row.reason != "artifact_not_available" || row.attempts != attempt {
			t.Fatalf("after lookup %d: %+v", attempt, row)
		}
		report := runReport(t, adapter.store, runID)
		if report.Consumption.State != "pending" || *report.Consumption.Reason != "artifact_on_internal_storage" ||
			*report.Consumption.Detail != "data_metadata_plate_1_gcode" {
			t.Fatalf("report after lookup %d = %+v", attempt, report.Consumption)
		}
	}
	// Not yet due again: the backoff keeps FTPS polling bounded.
	if retrieval, err := adapter.store.PendingArtifactRetrieval(ctx, adapter.assignmentID); err != nil || retrieval != nil {
		t.Fatalf("lookup due before its backoff: %+v %v", retrieval, err)
	}
	server.mu.Lock()
	server.files["/cache/Holder.gcode.3mf"] = synthetic3MF(t, "Holder", 0)
	server.mu.Unlock()
	if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "staged" {
		t.Fatalf("retrieval = %+v", row)
	}
	if transfers := transfersFor(t, adapter.store, runID); len(transfers) != 1 {
		t.Fatalf("transfers = %+v", transfers)
	}
}

func TestArchiveStillBeingWrittenIsNotDownloaded(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	archive := synthetic3MF(t, "Holder", 0)
	server := &fakeFTPS{files: map[string][]byte{"/cache/Holder.gcode.3mf": archive[:len(archive)/2]}}
	adapter := artifactAdapter(t, openTestStore(t), server)
	runID := ids.New()
	scheduleLookup(t, adapter, runID, bambuRunFacts{PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf"})
	for _, content := range [][]byte{archive[:len(archive)/2], archive[:len(archive)-5], archive} {
		server.mu.Lock()
		server.files["/cache/Holder.gcode.3mf"] = content
		server.mu.Unlock()
		dueNow(t, adapter.store, runID)
		if _, err := adapter.retrieveOneArtifact(ctx); err != nil {
			t.Fatal(err)
		}
		if server.retrievals != 0 {
			t.Fatal("a growing file was downloaded")
		}
	}
	if row := retrieveUntilSettled(t, adapter, runID, 2); row.state != "staged" || server.retrievals != 1 {
		t.Fatalf("retrieval = %+v, downloads = %d", row, server.retrievals)
	}
}

func TestLookupGivesUpOnlyAfterThePostRunWindow(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	cases := []struct {
		name           string
		facts          bambuRunFacts
		reason, detail string
	}{
		{
			"internal print",
			bambuRunFacts{Source: bambuSourceInternal, InternalPath: "data_metadata_plate_1_gcode", PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf", Outcome: OutcomeCompleted},
			"artifact_on_internal_storage", "data_metadata_plate_1_gcode",
		},
		{
			"external print",
			bambuRunFacts{Source: bambuSourceExternal, PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf", Outcome: OutcomeCompleted},
			"artifact_not_found_on_printer", "artifact_not_available",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			adapter := artifactAdapter(t, openTestStore(t), &fakeFTPS{files: map[string][]byte{}})
			runID := ids.New()
			scheduleLookup(t, adapter, runID, tc.facts)
			// Shortly after the end the archive may still arrive.
			runEndedAgo(t, adapter.store, runID, time.Minute)
			dueNow(t, adapter.store, runID)
			if _, err := adapter.retrieveOneArtifact(ctx); err != nil {
				t.Fatal(err)
			}
			if row := lookupRow(t, adapter.store, runID); row.state != "pending" {
				t.Fatalf("gave up inside the window: %+v", row)
			}
			if report := runReport(t, adapter.store, runID); report.Consumption.State != "pending" {
				t.Fatalf("report inside the window = %+v", report.Consumption)
			}
			runEndedAgo(t, adapter.store, runID, postRunArtifactWindow+time.Minute)
			if row := retrieveUntilSettled(t, adapter, runID, 1); row.state != "quarantined" || row.reason != "artifact_not_available" {
				t.Fatalf("retrieval = %+v", row)
			}
			report := runReport(t, adapter.store, runID)
			if report.Consumption.State != "unavailable" || *report.Consumption.Reason != tc.reason || *report.Consumption.Detail != tc.detail {
				t.Fatalf("final report = %+v", report.Consumption)
			}
		})
	}
}

func TestInterruptedRetrievalIsRetriedWithoutDuplicates(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	server := &fakeFTPS{files: map[string][]byte{"/cache/Holder.gcode.3mf": synthetic3MF(t, "Holder", 0)}, failNext: 1}
	adapter := artifactAdapter(t, openTestStore(t), server)
	runID := ids.New()
	scheduleLookup(t, adapter, runID, bambuRunFacts{PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf"})
	dueNow(t, adapter.store, runID)
	if _, err := adapter.retrieveOneArtifact(ctx); err != nil {
		t.Fatal(err)
	}
	dueNow(t, adapter.store, runID)
	_, err := adapter.retrieveOneArtifact(ctx)
	if err == nil || server.retrievals != 1 {
		t.Fatalf("interrupted download was not reported: err=%v downloads=%d", err, server.retrievals)
	}
	if row := lookupRow(t, adapter.store, runID); row.state != "pending" || row.reason != "ftps_transfer_finish_failed" {
		t.Fatalf("retrieval after interruption = %+v", row)
	}
	if report := runReport(t, adapter.store, runID); *report.Consumption.Reason != "artifact_retrieval_failed" {
		t.Fatalf("report after interruption = %+v", report.Consumption)
	}
	if row := retrieveUntilSettled(t, adapter, runID, 4); row.state != "staged" {
		t.Fatalf("retrieval = %+v", row)
	}
	if transfers := transfersFor(t, adapter.store, runID); len(transfers) != 1 || server.retrievals != 2 {
		t.Fatalf("transfers = %+v, downloads = %d", transfers, server.retrievals)
	}
}

func TestPendingRetrievalSurvivesARestartAndAnOlderStateFile(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	dir := t.TempDir()
	store, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	server := &fakeFTPS{files: map[string][]byte{"/Holder.gcode.3mf": synthetic3MF(t, "Holder", 0)}}
	adapter := artifactAdapter(t, store, server)
	runID := ids.New()
	scheduleLookup(t, adapter, runID, bambuRunFacts{PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf"})
	dueNow(t, store, runID)
	if _, err = adapter.retrieveOneArtifact(ctx); err != nil {
		t.Fatal(err)
	}
	if err = adapter.store.MarkArtifactRunEnded(ctx, adapter.assignmentID, runID, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	// A state file written before the run-end column existed is upgraded on open.
	if _, err = store.db.Exec(`ALTER TABLE artifact_retrievals DROP COLUMN run_ended_at`); err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	if store, err = OpenStore(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	adapter.store = store
	if err = store.MarkArtifactRunEnded(ctx, adapter.assignmentID, runID, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	retrieval, err := store.PendingArtifactRetrieval(ctx, adapter.assignmentID)
	if err != nil || retrieval == nil || retrieval.RunEndedAt == nil {
		t.Fatalf("retrieval after restart = %+v err=%v", retrieval, err)
	}
	if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "staged" {
		t.Fatalf("retrieval = %+v", row)
	}
	if transfers := transfersFor(t, store, runID); len(transfers) != 1 {
		t.Fatalf("transfers = %+v", transfers)
	}
}

func TestRepeatedDiscoveryAndRefetchKeepOneArtifactAndOneBooking(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	archive := synthetic3MF(t, "Holder", 0)
	server := &fakeFTPS{files: map[string][]byte{"/cache/Holder.gcode.3mf": archive}}
	adapter := artifactAdapter(t, openTestStore(t), server)
	runID := ids.New()
	facts := bambuRunFacts{PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf", Outcome: OutcomeCompleted}
	scheduleLookup(t, adapter, runID, facts)
	if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "staged" {
		t.Fatalf("retrieval = %+v", row)
	}
	// Staff ask for the file again while the first copy still waits for Core.
	if err := adapter.store.RequeueArtifactRetrieval(ctx, adapter.assignmentID, runID, time.Now().UTC().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "staged" {
		t.Fatalf("retrieval after re-fetch = %+v", row)
	}
	if transfers := transfersFor(t, adapter.store, runID); len(transfers) != 1 || transfers[0].SHA256 != sha256Hex(archive) {
		t.Fatalf("transfers after re-fetch = %+v", transfers)
	}
	for range 2 {
		if err := adapter.processArtifactConsumptions(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if count := consumptionReports(t, adapter.store, runID); count != 1 {
		t.Fatalf("consumption reports = %d, want exactly one", count)
	}
}

func TestCorruptArchiveIsRejectedForGood(t *testing.T) {
	t.Parallel()
	server := &fakeFTPS{files: map[string][]byte{"/cache/Holder.gcode.3mf": []byte("this is not a zip archive at all")}}
	adapter := artifactAdapter(t, openTestStore(t), server)
	runID := ids.New()
	scheduleLookup(t, adapter, runID, bambuRunFacts{
		Source: bambuSourceInternal, InternalPath: "data_metadata_plate_1_gcode", PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf",
	})
	if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "quarantined" || row.reason != "artifact_invalid" {
		t.Fatalf("retrieval = %+v", row)
	}
	report := runReport(t, adapter.store, runID)
	if report.Consumption.State != "unavailable" || *report.Consumption.Reason != "artifact_rejected" ||
		*report.Consumption.Detail != "artifact_invalid" {
		t.Fatalf("report = %+v", report.Consumption)
	}
	if transfers := transfersFor(t, adapter.store, runID); len(transfers) != 0 {
		t.Fatalf("corrupt archive was staged: %+v", transfers)
	}
}

func TestArchiveOfAnotherPrintIsNotAttached(t *testing.T) {
	t.Parallel()
	// The printer named "other.gcode.3mf" without a directory while printing "Mine"; the archive's own
	// project name does not match the print either, so it is not attached.
	server := &fakeFTPS{files: map[string][]byte{"/cache/other.gcode.3mf": synthetic3MF(t, "Something else", 0)}}
	adapter := artifactAdapter(t, openTestStore(t), server)
	runID := ids.New()
	scheduleLookup(t, adapter, runID, bambuRunFacts{
		Source: bambuSourceInternal, InternalPath: "data_metadata_plate_1_gcode", PrintName: "Mine", ArchiveCandidate: "other.gcode.3mf",
	})
	if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "quarantined" || row.reason != "artifact_name_mismatch" {
		t.Fatalf("retrieval = %+v", row)
	}
	report := runReport(t, adapter.store, runID)
	if *report.Consumption.Reason != "artifact_not_found_on_printer" || *report.Consumption.Detail != "artifact_name_mismatch" {
		t.Fatalf("report = %+v", report.Consumption)
	}

	// The same archive whose project name is the print's is attached: users rename files.
	server = &fakeFTPS{files: map[string][]byte{"/cache/other.gcode.3mf": synthetic3MF(t, "Mine", 0)}}
	adapter = artifactAdapter(t, openTestStore(t), server)
	runID = ids.New()
	scheduleLookup(t, adapter, runID, bambuRunFacts{PrintName: "Mine", ArchiveCandidate: "other.gcode.3mf"})
	if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "staged" {
		t.Fatalf("retrieval = %+v", row)
	}

	// A path the printer named itself is trusted even when the names differ.
	server = &fakeFTPS{files: map[string][]byte{"/cache/other.gcode.3mf": synthetic3MF(t, "Something else", 0)}}
	adapter = artifactAdapter(t, openTestStore(t), server)
	runID = ids.New()
	scheduleLookup(t, adapter, runID, bambuRunFacts{PrintName: "Mine", ArchivePath: "/cache/other.gcode.3mf"})
	if row := retrieveUntilSettled(t, adapter, runID, 3); row.state != "staged" {
		t.Fatalf("retrieval = %+v", row)
	}
}

func TestRunEndSchedulesTheLookupAndTrustsCoreWhenItHasTheFile(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	// Core holds a manual upload: the pending lookup is settled without asking the printer again.
	store := openTestStore(t)
	server := &fakeFTPS{files: map[string][]byte{}}
	core := &coreArtifacts{store: store, archive: synthetic3MF(t, "Holder", 0)}
	adapter := artifactAdapter(t, store, server)
	adapter.features = core
	runID := ids.New()
	scheduleLookup(t, adapter, runID, bambuRunFacts{
		Source: bambuSourceInternal, PrintName: "Holder", ArchiveCandidate: "Holder.gcode.3mf", Outcome: OutcomeCompleted,
	})
	terminal := Observation{Kind: ObservationTerminalOutcome, RunID: &runID, Payload: mustJSON(map[string]any{"outcome": "completed"})}
	if err := adapter.noteRunsForRecordings(ctx, []Observation{terminal}); err != nil {
		t.Fatal(err)
	}
	if row := lookupRow(t, store, runID); row.state != "staged" || core.calls != 1 {
		t.Fatalf("retrieval after Core adoption = %+v, core calls = %d", row, core.calls)
	}
	if _, err := adapter.retrieveOneArtifact(ctx); err != nil || server.lists != 0 {
		t.Fatalf("printer was listed after Core settled the run: err=%v lists=%d", err, server.lists)
	}

	// A run without a retrieval so far (its name only became known at the end) gets one, due at once.
	adapter = artifactAdapter(t, openTestStore(t), &fakeFTPS{files: map[string][]byte{}})
	runID = ids.New()
	saveRunFacts(t, adapter, runID, bambuRunFacts{PrintName: "Late", ArchiveCandidate: "Late.gcode.3mf", Outcome: OutcomeCompleted})
	if err := adapter.noteRunsForRecordings(ctx, []Observation{{Kind: ObservationTerminalOutcome, RunID: &runID}}); err != nil {
		t.Fatal(err)
	}
	retrieval, err := adapter.store.PendingArtifactRetrieval(ctx, adapter.assignmentID)
	if err != nil || retrieval == nil || retrieval.ReportedPath != "Late.gcode.3mf" || retrieval.RunEndedAt == nil {
		t.Fatalf("retrieval scheduled at the end = %+v err=%v", retrieval, err)
	}
}
