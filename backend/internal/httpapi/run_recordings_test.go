package httpapi

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings"
)

func TestRunTimelapseDownloadServesRangesFromSeekableStorage(t *testing.T) {
	video := bytes.Repeat([]byte("0123456789"), 100)
	path := filepath.Join(t.TempDir(), "video.mp4")
	if err := os.WriteFile(path, video, 0o600); err != nil {
		t.Fatal(err)
	}
	file := runrecordings.FileContent{FileName: "R-2026-000001-timelapse.mp4", ContentType: "video/mp4", SizeBytes: int64(len(video))}
	open := func() io.ReadCloser {
		reader, err := os.Open(path) //nolint:gosec // test file in a temporary directory
		if err != nil {
			t.Fatal(err)
		}
		return reader
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/machine-runs/x/timelapse/content", nil)
	request.Header.Set("Range", "bytes=10-19")
	recorder := httptest.NewRecorder()
	if err := (runTimelapseResponse{file: file, reader: open(), request: request}).VisitDownloadMachineRunTimelapseResponse(recorder); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusPartialContent || recorder.Body.String() != "0123456789" ||
		recorder.Header().Get("Content-Range") != "bytes 10-19/1000" || recorder.Header().Get("Cache-Control") != "no-store" ||
		recorder.Header().Get("Content-Disposition") != `attachment; filename=R-2026-000001-timelapse.mp4` ||
		recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("range response %d %v %q", recorder.Code, recorder.Header(), recorder.Body.String())
	}
	request = httptest.NewRequest(http.MethodGet, "/api/v1/machine-runs/x/timelapse/content", nil)
	request.Header.Set("Range", "bytes=5000-")
	recorder = httptest.NewRecorder()
	_ = (runTimelapseResponse{file: file, reader: open(), request: request}).VisitDownloadMachineRunTimelapseResponse(recorder)
	if recorder.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("unsatisfiable range status = %d", recorder.Code)
	}
	// Storage that cannot seek streams the whole body and says so.
	recorder = httptest.NewRecorder()
	if err := (runTimelapseResponse{file: file, reader: io.NopCloser(bytes.NewReader(video)), request: request}).
		VisitDownloadMachineRunTimelapseResponse(recorder); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusOK || recorder.Header().Get("Accept-Ranges") != "none" || recorder.Body.Len() != len(video) {
		t.Fatalf("non-seekable response %d %v", recorder.Code, recorder.Header())
	}
}
