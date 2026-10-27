package printerconnector

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
)

func TestTimelapseCandidateSelectionIsExact(t *testing.T) {
	t.Parallel()
	baseline := map[string]int64{"video_2026-10-01_10-00-00.mp4": 5000, "video_growing.mp4": 100}
	entry := func(name string, size int64) FTPEntry { return FTPEntry{Name: name, Size: size} }
	cases := []struct {
		name    string
		listing []FTPEntry
		claimed map[string]bool
		want    string
		err     error
	}{
		{"new file", []FTPEntry{entry("video_2026-10-01_10-00-00.mp4", 5000), entry("video_new.mp4", 900)}, nil, "video_new.mp4", nil},
		{"grown file", []FTPEntry{entry("video_growing.mp4", 800)}, nil, "video_growing.mp4", nil},
		{"unchanged only", []FTPEntry{entry("video_2026-10-01_10-00-00.mp4", 5000)}, nil, "", errTimelapseNotFound},
		{"claimed by another run", []FTPEntry{entry("video_new.mp4", 900)}, map[string]bool{"video_new.mp4": true}, "", errTimelapseNotFound},
		{"two candidates", []FTPEntry{entry("video_a.mp4", 1), entry("video_b.mp4", 2)}, nil, "", errTimelapseAmbiguous},
		{"directories, thumbnails and empty files", []FTPEntry{
			{Name: "thumbnail", IsDir: true},
			entry("video_a.jpg", 10),
			entry("video_empty.mp4", 0),
			entry("../escape.mp4", 10),
		}, nil, "", errTimelapseNotFound},
		{"upper-case extension", []FTPEntry{entry("VIDEO_X.MP4", 3)}, nil, "VIDEO_X.MP4", nil},
	}
	for _, tc := range cases {
		match, err := SelectTimelapseCandidate(baseline, tc.listing, tc.claimed)
		if !errors.Is(err, tc.err) || match.Name != tc.want {
			t.Fatalf("%s: match=%+v err=%v, want %q %v", tc.name, match, err, tc.want, tc.err)
		}
	}
}

func TestConsumptionReportNamesTheUnresolvedCause(t *testing.T) {
	t.Parallel()
	unresolved := json.RawMessage(`{"items":[{"quality":"unresolved"}]}`)
	layer, progress := 0, 0.0
	twelve := 12
	cases := []struct {
		facts  bambuRunFacts
		body   json.RawMessage
		reason string
	}{
		{bambuRunFacts{Outcome: OutcomeCompleted}, json.RawMessage(`{"items":[{"quality":"high"}]}`), ""},
		{bambuRunFacts{Outcome: OutcomeCompleted}, unresolved, "no_slicer_weights_in_artifact"},
		{bambuRunFacts{Outcome: OutcomeFailed}, unresolved, "cancelled_before_first_layer"},
		{bambuRunFacts{Outcome: OutcomeFailed, LastLayer: &layer, LastProgress: &progress}, unresolved, "cancelled_before_first_layer"},
		{bambuRunFacts{Outcome: OutcomeUnknown, LastLayer: &twelve}, unresolved, "gcode_estimate_unavailable"},
	}
	for _, tc := range cases {
		state, reason := consumptionReportFor(tc.facts, tc.body)
		got := ""
		if reason != nil {
			got = *reason
		}
		if state != "reported" || got != tc.reason {
			t.Fatalf("facts %+v: state=%s reason=%q, want %q", tc.facts, state, got, tc.reason)
		}
	}
}

type staticFeatures struct{ value *RecordingFeatures }

func (s staticFeatures) RecordingFeatures() *RecordingFeatures { return s.value }

// fakeTimelapseFTPS serves a scripted /timelapse directory.
type fakeTimelapseFTPS struct {
	mu      sync.Mutex
	files   map[string][]byte
	listErr error
}

func (f *fakeTimelapseFTPS) List(_ context.Context, directory string) ([]FTPEntry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if directory != bambuTimelapseDirectory {
		return nil, errors.New("unexpected directory")
	}
	if f.listErr != nil {
		return nil, f.listErr
	}
	var entries []FTPEntry
	for name, content := range f.files {
		entries = append(entries, FTPEntry{Name: name, Size: int64(len(content))})
	}
	return entries, nil
}

func (f *fakeTimelapseFTPS) RetrieveLimited(_ context.Context, remotePath string, writer io.Writer, limit int64) error {
	f.mu.Lock()
	content, ok := f.files[path.Base(remotePath)]
	f.mu.Unlock()
	if !ok || path.Dir(remotePath) != bambuTimelapseDirectory {
		return errors.New("550 not found")
	}
	_, err := io.Copy(writer, io.LimitReader(bytes.NewReader(content), limit))
	return err
}

func (f *fakeTimelapseFTPS) Close() error { return nil }

func timelapseAdapter(t *testing.T, store *Store, server *fakeTimelapseFTPS, features *RecordingFeatures) *bambuH2DAdapter {
	t.Helper()
	return &bambuH2DAdapter{
		kind:                 AdapterBambuX1C,
		assignmentID:         ids.New(),
		configurationVersion: 2,
		store:                store,
		features:             staticFeatures{value: features},
		newTimelapseFTPS:     func(context.Context) (timelapseFTPS, error) { return server, nil },
	}
}

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

// ageTimelapseObservation lets the stable-size check pass without waiting.
func ageTimelapseObservation(t *testing.T, store *Store, runID uuid.UUID) {
	t.Helper()
	old := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	if _, err := store.db.Exec(`UPDATE timelapse_retrievals SET updated_at=?,next_attempt_at=? WHERE run_id=?`, old, old, runID.String()); err != nil {
		t.Fatal(err)
	}
}

func runReport(t *testing.T, store *Store, runID uuid.UUID) PendingRunReport {
	t.Helper()
	reports, err := store.PendingRunReports(context.Background(), 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, report := range reports {
		if report.RunID == runID {
			return report
		}
	}
	t.Fatalf("no pending report for run %s: %+v", runID, reports)
	return PendingRunReport{}
}

func TestTimelapseRetrievalMatchesTheNewVideoAndUploadsIt(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestStore(t)
	server := &fakeTimelapseFTPS{files: map[string][]byte{"video_old.mp4": []byte("previous print")}}
	adapter := timelapseAdapter(t, store, server, &RecordingFeatures{TimelapseEnabled: true, TimelapseMaxBytes: 1 << 20})
	runID := ids.New()
	active := Observation{Kind: ObservationOperationalState, RunID: &runID, Payload: json.RawMessage(`{}`)}
	if err := adapter.noteRunsForRecordings(ctx, []Observation{active}); err != nil {
		t.Fatal(err)
	}
	// The baseline is listed while the print runs.
	if err := adapter.processTimelapses(ctx); err != nil {
		t.Fatal(err)
	}
	video := append([]byte("\x00\x00\x00\x18ftypmp42"), bytes.Repeat([]byte("frame"), 200)...)
	server.mu.Lock()
	server.files["video_2026-10-27_09-00-00.mp4"] = video
	server.mu.Unlock()
	if err := store.ScheduleArtifactRetrieval(ctx, adapter.assignmentID, runID, 2, "/cache/part.gcode.3mf", time.Time{}); err != nil {
		t.Fatal(err)
	}
	terminal := Observation{Kind: ObservationTerminalOutcome, RunID: &runID, Payload: json.RawMessage(`{"outcome":"completed"}`)}
	if err := adapter.noteRunsForRecordings(ctx, []Observation{terminal}); err != nil {
		t.Fatal(err)
	}
	if report := runReport(t, store, runID); report.Timelapse == nil || report.Timelapse.State != timelapseReportPending ||
		report.Consumption != nil {
		t.Fatalf("report after end = %+v %+v", report.Timelapse, report.Consumption)
	}
	// First sighting only records the candidate; a later identical listing retrieves it.
	if err := adapter.processTimelapses(ctx); err != nil {
		t.Fatal(err)
	}
	uploads, err := store.StagedTimelapses(ctx, 5)
	if err != nil || len(uploads) != 0 {
		t.Fatalf("video was retrieved before its size was stable: %+v %v", uploads, err)
	}
	ageTimelapseObservation(t, store, runID)
	if err = adapter.processTimelapses(ctx); err != nil {
		t.Fatal(err)
	}
	uploads, err = store.StagedTimelapses(ctx, 5)
	if err != nil || len(uploads) != 1 || uploads[0].FileName != "video_2026-10-27_09-00-00.mp4" ||
		uploads[0].SizeBytes != int64(len(video)) {
		t.Fatalf("staged uploads = %+v %v", uploads, err)
	}
	digest := sha256.Sum256(video)
	if uploads[0].SHA256 != hex.EncodeToString(digest[:]) {
		t.Fatal("staged timelapse digest differs")
	}
	var received []byte
	var headers http.Header
	client, err := NewClient("http://core.test", true)
	if err != nil {
		t.Fatal(err)
	}
	client.http.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		headers = request.Header.Clone()
		received, _ = io.ReadAll(request.Body)
		if !strings.HasSuffix(request.URL.Path, "/runs/"+runID.String()+"/timelapse") || request.Method != http.MethodPut {
			t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		return &http.Response{
			StatusCode: http.StatusCreated,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"runId":"` + runID.String() + `","disposition":"created","sizeBytes":1}`)),
			Request:    request,
		}, nil
	})
	runtime := &Runtime{client: client, store: store, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err = runtime.deliverTimelapses(ctx, Identity{CredentialSecret: "token"}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(received, video) || headers.Get("X-Timelapse-SHA256") != hex.EncodeToString(digest[:]) ||
		headers.Get("X-Timelapse-Filename") != "video_2026-10-27_09-00-00.mp4" {
		t.Fatalf("upload headers %v, %d bytes", headers, len(received))
	}
	if _, err = os.Stat(uploads[0].StagedPath); !os.IsNotExist(err) {
		t.Fatalf("staged video kept after upload: %v", err)
	}
	if report := runReport(t, store, runID); report.Timelapse == nil || report.Timelapse.State != timelapseReportUploaded {
		t.Fatalf("report after upload = %+v", report.Timelapse)
	}
	// The uploaded video is claimed: the next run of the assignment cannot take it.
	claimed, err := store.ClaimedTimelapseNames(ctx, adapter.assignmentID, ids.New())
	if err != nil || !claimed["video_2026-10-27_09-00-00.mp4"] {
		t.Fatalf("claimed = %v %v", claimed, err)
	}
}

func TestTimelapseRetrievalGivesUpWithoutGuessing(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	features := &RecordingFeatures{TimelapseEnabled: true, TimelapseMaxBytes: 1 << 20}
	end := func(adapter *bambuH2DAdapter, runID uuid.UUID) {
		t.Helper()
		terminal := Observation{Kind: ObservationTerminalOutcome, RunID: &runID, Payload: json.RawMessage(`{}`)}
		if err := adapter.noteRunsForRecordings(ctx, []Observation{terminal}); err != nil {
			t.Fatal(err)
		}
	}

	// A print first seen at its end has no baseline.
	store := openTestStore(t)
	adapter := timelapseAdapter(t, store, &fakeTimelapseFTPS{files: map[string][]byte{}}, features)
	runID := ids.New()
	end(adapter, runID)
	report := runReport(t, store, runID)
	if report.Timelapse == nil || report.Timelapse.State != timelapseReportNotFound ||
		*report.Timelapse.Reason != reasonTimelapseBaselineMissing {
		t.Fatalf("missing baseline report = %+v", report.Timelapse)
	}
	// No archive was ever named for that print either.
	if report.Consumption == nil || report.Consumption.State != "unavailable" ||
		*report.Consumption.Reason != "artifact_not_found_on_printer" || *report.Consumption.Detail != "no_archive_reported" {
		t.Fatalf("missing archive report = %+v", report.Consumption)
	}

	// Two new videos are ambiguous.
	server := &fakeTimelapseFTPS{files: map[string][]byte{}}
	adapter = timelapseAdapter(t, openTestStore(t), server, features)
	runID = ids.New()
	if err := adapter.noteRunsForRecordings(ctx, []Observation{{Kind: ObservationProgress, RunID: &runID}}); err != nil {
		t.Fatal(err)
	}
	if err := adapter.processTimelapses(ctx); err != nil {
		t.Fatal(err)
	}
	server.files["video_a.mp4"], server.files["video_b.mp4"] = []byte("a"), []byte("b")
	end(adapter, runID)
	if err := adapter.processTimelapses(ctx); err != nil {
		t.Fatal(err)
	}
	if report = runReport(t, adapter.store, runID); report.Timelapse == nil || *report.Timelapse.Reason != reasonTimelapseAmbiguous {
		t.Fatalf("ambiguous report = %+v", report.Timelapse)
	}

	// Nothing new appears within the search window.
	server = &fakeTimelapseFTPS{files: map[string][]byte{}}
	adapter = timelapseAdapter(t, openTestStore(t), server, features)
	runID = ids.New()
	if err := adapter.noteRunsForRecordings(ctx, []Observation{{Kind: ObservationProgress, RunID: &runID}}); err != nil {
		t.Fatal(err)
	}
	if err := adapter.processTimelapses(ctx); err != nil {
		t.Fatal(err)
	}
	end(adapter, runID)
	past := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	if _, err := adapter.store.db.Exec(`UPDATE timelapse_retrievals SET deadline_at=?,next_attempt_at=?`, past, past); err != nil {
		t.Fatal(err)
	}
	if err := adapter.processTimelapses(ctx); err != nil {
		t.Fatal(err)
	}
	if report = runReport(t, adapter.store, runID); report.Timelapse == nil || *report.Timelapse.Reason != reasonTimelapseNotRecorded {
		t.Fatalf("not recorded report = %+v", report.Timelapse)
	}

	// Disabled collection is reported as skipped and never lists the printer.
	server = &fakeTimelapseFTPS{listErr: errors.New("must not list")}
	adapter = timelapseAdapter(t, openTestStore(t), server, &RecordingFeatures{TimelapseEnabled: false})
	runID = ids.New()
	end(adapter, runID)
	if err := adapter.processTimelapses(ctx); err != nil {
		t.Fatal(err)
	}
	if report = runReport(t, adapter.store, runID); report.Timelapse == nil || report.Timelapse.State != timelapseReportSkipped {
		t.Fatalf("disabled report = %+v", report.Timelapse)
	}
}

// fakeCore answers the command endpoints and serves one archive.
type fakeCore struct {
	mu       sync.Mutex
	commands []CoreCommand
	statuses map[uuid.UUID][]string
	archive  []byte
}

func (f *fakeCore) roundTrip(request *http.Request) (*http.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	respond := func(status int, body string, header http.Header) (*http.Response, error) {
		if header == nil {
			header = make(http.Header)
		}
		return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	}
	switch {
	case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/printer-connector/self/commands"):
		encoded, _ := json.Marshal(map[string]any{"items": f.commands})
		return respond(http.StatusOK, string(encoded), nil)
	case request.Method == http.MethodPut && strings.HasSuffix(request.URL.Path, "/status"):
		var body struct {
			State string `json:"state"`
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		id, _ := uuid.Parse(path.Base(path.Dir(request.URL.Path)))
		f.statuses[id] = append(f.statuses[id], body.State)
		return respond(http.StatusNoContent, "", nil)
	case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/artifact/content"):
		digest := sha256.Sum256(f.archive)
		header := make(http.Header)
		header.Set("X-Artifact-SHA256", hex.EncodeToString(digest[:]))
		return respond(http.StatusOK, string(f.archive), header)
	}
	return respond(http.StatusNotFound, `{"code":"not_found"}`, nil)
}

func TestRuntimeExecutesRunCommandsAndReportsTheirOutcome(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := openTestStore(t)
	assignmentID := ids.New()
	refetchRun, unknownRun, recomputeRun := ids.New(), ids.New(), ids.New()
	if err := store.SaveBambuStateFor(ctx, assignmentID, AdapterBambuH2D, bambuPersistedState{
		Document: map[string]any{}, Ready: true, RunFacts: map[string]bambuRunFacts{
			recomputeRun.String(): {Outcome: OutcomeCompleted, HistoryComplete: true, ExternalPrintID: "task-9"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	// The refetched run's retrieval had given up.
	if err := store.ScheduleArtifactRetrieval(ctx, assignmentID, refetchRun, 4, "/cache/part.gcode.3mf", time.Time{}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE artifact_retrievals SET state='quarantined',reason_code='artifact_retry_expired'`); err != nil {
		t.Fatal(err)
	}
	core := &fakeCore{statuses: map[uuid.UUID][]string{}, archive: syntheticBambuConsumptionZIP(t)}
	refetch, unknown, recompute := ids.New(), ids.New(), ids.New()
	core.commands = []CoreCommand{
		{ID: refetch, AssignmentID: assignmentID, RunID: refetchRun, Kind: "refetch_artifact", State: "requested"},
		{ID: unknown, AssignmentID: assignmentID, RunID: unknownRun, Kind: "refetch_artifact", State: "requested"},
		{ID: recompute, AssignmentID: assignmentID, RunID: recomputeRun, Kind: "recompute_consumption", State: "requested"},
	}
	client, err := NewClient("http://core.test", true)
	if err != nil {
		t.Fatal(err)
	}
	client.http.Transport = roundTripFunc(core.roundTrip)
	runtime := &Runtime{
		client:  client,
		store:   store,
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		running: map[uuid.UUID]runningAssignment{assignmentID: {kind: AdapterBambuH2D, configurationVersion: 4}},
	}
	identity := Identity{CredentialSecret: "token"}
	if err = runtime.syncCommands(ctx, identity); err != nil {
		t.Fatal(err)
	}
	// A repeated poll does not create a second local command.
	if err = runtime.syncCommands(ctx, identity); err != nil {
		t.Fatal(err)
	}
	if err = runtime.processCommands(ctx, identity); err != nil {
		t.Fatal(err)
	}
	core.mu.Lock()
	if got := core.statuses[unknown]; len(got) != 1 || got[0] != commandFailed {
		t.Fatalf("unknown archive path statuses = %v", got)
	}
	if got := core.statuses[refetch]; len(got) != 1 || got[0] != commandRunning {
		t.Fatalf("refetch statuses = %v", got)
	}
	if got := core.statuses[recompute]; len(got) != 1 || got[0] != commandRunning {
		t.Fatalf("recompute statuses = %v", got)
	}
	core.mu.Unlock()
	state, _, _, err := store.ArtifactRetrievalState(ctx, assignmentID, refetchRun)
	if err != nil || state != "pending" {
		t.Fatalf("refetched retrieval state = %q %v", state, err)
	}
	// The adapter retrieves the archive again; the transfer is settled once Core acknowledged it.
	if _, err = store.db.Exec(`UPDATE artifact_retrievals SET state='staged' WHERE run_id=?`, refetchRun.String()); err != nil {
		t.Fatal(err)
	}
	// The adapter recalculates the downloaded archive with the next report revision.
	adapter := &bambuH2DAdapter{assignmentID: assignmentID, configurationVersion: 4, store: store}
	if err = adapter.processArtifactConsumptions(ctx); err != nil {
		t.Fatal(err)
	}
	events, err := store.Pending(ctx, 10)
	if err != nil || len(events) != 1 || events[0].ReportRevision == nil || *events[0].ReportRevision != 1 {
		t.Fatalf("first calculation = %+v %v", events, err)
	}
	if err = runtime.processCommands(ctx, identity); err != nil {
		t.Fatal(err)
	}
	core.mu.Lock()
	if got := core.statuses[refetch]; got[len(got)-1] != commandSucceeded {
		t.Fatalf("refetch statuses = %v", got)
	}
	if got := core.statuses[recompute]; got[len(got)-1] != commandSucceeded {
		t.Fatalf("recompute statuses = %v", got)
	}
	core.mu.Unlock()
	// A second recompute of the same archive yields revision 2, replacing the first report in Core.
	second := ids.New()
	if err = store.AcceptRunCommand(ctx, RunCommand{ID: second, AssignmentID: assignmentID, RunID: recomputeRun, Kind: "recompute_consumption"}); err != nil {
		t.Fatal(err)
	}
	if err = runtime.processCommands(ctx, identity); err != nil {
		t.Fatal(err)
	}
	if err = adapter.processArtifactConsumptions(ctx); err != nil {
		t.Fatal(err)
	}
	events, err = store.Pending(ctx, 10)
	if err != nil || len(events) != 2 || events[1].ReportRevision == nil || *events[1].ReportRevision != 2 {
		t.Fatalf("recomputed calculation = %+v %v", events, err)
	}
}
