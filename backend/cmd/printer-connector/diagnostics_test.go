package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInspect3MFCommand(t *testing.T) {
	t.Parallel()

	directory := t.TempDir()
	artifactPath := filepath.Join(directory, "fixture.3mf")
	writeDiagnosticArchive(t, artifactPath)
	var output bytes.Buffer
	handled, err := runOfflineCommand([]string{"inspect-3mf", "--file", artifactPath}, &output)
	if err != nil {
		t.Fatalf("inspect-3mf: %v", err)
	}
	if !handled || !strings.Contains(output.String(), `"parserVersion": "bambu-3mf-v1"`) || strings.Contains(output.String(), "Bytes") {
		t.Fatalf("output = %s", output.String())
	}
}

func TestCalculateConsumptionCommand(t *testing.T) {
	t.Parallel()

	directory := t.TempDir()
	artifactPath := filepath.Join(directory, "fixture.3mf")
	writeDiagnosticArchive(t, artifactPath)
	gcodePath := filepath.Join(directory, "interrupted.gcode")
	if err := os.WriteFile(gcodePath, []byte("M83\nM620 S3A\n;TYPE:External perimeter\nG1 E100\nM73 P50\nG1 E100\nM73 P75\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	handled, err := runOfflineCommand([]string{
		"calculate-consumption", "--gcode", gcodePath, "--artifact", artifactPath, "--last-progress", "50",
	}, &output)
	if err != nil {
		t.Fatalf("calculate-consumption: %v", err)
	}
	if !handled || !strings.Contains(output.String(), `"resolved": true`) || !strings.Contains(output.String(), `"embeddedProgress": 50`) {
		t.Fatalf("output = %s", output.String())
	}
}

func TestSanitizeAndReplayCommands(t *testing.T) {
	t.Parallel()

	directory := t.TempDir()
	rawPath := filepath.Join(directory, "raw.ndjson")
	sanitizedPath := filepath.Join(directory, "sanitized.ndjson")
	raw := "{\n\"print\":{\"gcode_state\":\"RUNNING\",\"local_task_id\":\"private-task\",\"gcode_file\":\"private.3mf\"}}\n" +
		"{\n\"print\":{\"ams\":{\"tray_now\":\"0\"}}}\n"
	if err := os.WriteFile(rawPath, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	if handled, err := runOfflineCommand([]string{"sanitize-mqtt", "--input", rawPath, "--output", sanitizedPath}, &bytes.Buffer{}); err != nil || !handled {
		t.Fatalf("sanitize-mqtt handled=%v err=%v", handled, err)
	}
	info, err := os.Stat(sanitizedPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o", info.Mode().Perm())
	}
	sanitized, err := os.ReadFile(sanitizedPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(sanitized), "private-task") || strings.Contains(string(sanitized), "private.3mf") {
		t.Fatalf("sanitized = %s", sanitized)
	}
	var replay bytes.Buffer
	if handled, err := runOfflineCommand([]string{"replay-mqtt", "--input", sanitizedPath, "--adapter", "bambu_x1c"}, &replay); err != nil || !handled {
		t.Fatalf("replay-mqtt handled=%v err=%v", handled, err)
	}
	if !strings.Contains(replay.String(), `"ready":true`) || !strings.Contains(replay.String(), `"kind":"progress"`) {
		t.Fatalf("replay = %s", replay.String())
	}
}

func TestOfflineCommandValidation(t *testing.T) {
	t.Parallel()

	if handled, err := runOfflineCommand([]string{"not-a-command"}, &bytes.Buffer{}); handled || err != nil {
		t.Fatalf("unknown command handled=%v err=%v", handled, err)
	}
	for _, args := range [][]string{
		{"inspect-3mf"},
		{"calculate-consumption"},
		{"calculate-consumption", "--gcode", "missing", "--last-progress", "101"},
		{"sanitize-mqtt", "--input", "only-input"},
		{"replay-mqtt"},
	} {
		if handled, err := runOfflineCommand(args, &bytes.Buffer{}); !handled || err == nil {
			t.Fatalf("args=%v handled=%v err=%v", args, handled, err)
		}
	}
}

func writeDiagnosticArchive(t *testing.T, fileName string) {
	t.Helper()
	file, err := os.OpenFile(fileName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	metadata, err := writer.Create("Metadata/project_settings.config")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = metadata.Write([]byte(`{"project_name":"synthetic","filament_id":["3"],"filament_type":["PLA"],"filament_diameter":["1.75"],"filament_density":["1.24"]}`))
	gcode, err := writer.Create("Metadata/plate_1.gcode")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = gcode.Write([]byte("M83\nM620 S3A\n;TYPE:External perimeter\nG1 E100\n"))
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
}
