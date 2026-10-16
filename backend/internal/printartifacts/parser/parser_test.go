package parser

import (
	"archive/zip"
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io/fs"
	"testing"
)

func TestParseSyntheticBambuArchive(t *testing.T) {
	t.Parallel()

	platePreview := pngBytes(t, 40, 30, color.RGBA{R: 220, A: 255})
	otherPreview := pngBytes(t, 80, 80, color.RGBA{G: 220, A: 255})
	archive := makeZIP(t, []zipEntry{
		{name: "Metadata/project_settings.config", data: []byte(`{
            "project_name":"Fixture bracket",
            "slicer_name":"Bambu Studio",
            "slicer_version":"1.10",
            "printer_settings_id":"H2D 0.4 nozzle",
            "curr_bed_type":"Textured PEI Plate",
            "filament_type":["PLA","PETG"],
            "filament_id":["3","11"],
            "filament_colour":["#FF0000","#00FF00"],
            "filament_diameter":["1.75","1.75"],
            "filament_density":["1.24","1.27"],
            "filament_extruder":["0","1"],
            "nozzle_diameter":["0.4","0.6"],
            "thumbnail_file":"Metadata/plate_2.png"
        }`)},
		{name: "Metadata/slice_info.config", data: []byte(`<?xml version="1.0"?>
          <config>
            <plate id="2"/>
            <object name="housing"/>
            <metadata key="estimated_print_time" value="900"/>
            <metadata key="total_layer_count" value="42"/>
            <filament id="7" type="TPU" color="#112233" used_mm="250" used_g="0.75" density="1.21" diameter="1.75" extruder="1"/>
          </config>`)},
		{name: "Metadata/plate_2.png", data: platePreview},
		{name: "Metadata/plate_9.png", data: otherPreview},
		{name: "Metadata/thumbnail.png", data: platePreview}, // duplicate bytes are removed
		{name: "Metadata/plate_2.gcode", data: []byte("M82\nG92 E0\nM620 S3A\n;TYPE:External perimeter\nG1 X1 E100\n")},
	})

	result, err := Parse(bytes.NewReader(archive), int64(len(archive)), Limits{})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if result.Status != StatusParsed {
		t.Fatalf("status = %q, warnings = %v", result.Status, result.Warnings)
	}
	if result.Metadata.JobName != "Fixture bracket" || result.Metadata.PrinterProfile != "H2D 0.4 nozzle" {
		t.Fatalf("unexpected metadata: %+v", result.Metadata)
	}
	if result.Metadata.EstimatedDurationSeconds == nil || *result.Metadata.EstimatedDurationSeconds != 900 {
		t.Fatalf("duration = %v", result.Metadata.EstimatedDurationSeconds)
	}
	if result.Metadata.LayerCount == nil || *result.Metadata.LayerCount != 42 {
		t.Fatalf("layer count = %v", result.Metadata.LayerCount)
	}
	if len(result.Filaments) != 3 || result.Filaments[0].ID != "3" || result.Filaments[1].ID != "7" || result.Filaments[2].ID != "11" {
		t.Fatalf("filaments = %+v", result.Filaments)
	}
	if result.Filaments[0].NozzleDiameter == nil || *result.Filaments[0].NozzleDiameter != 0.4 || len(result.Filaments[0].Extruders) != 1 || result.Filaments[0].Extruders[0] != 0 {
		t.Fatalf("filament mapping = %+v", result.Filaments[0])
	}
	if len(result.Previews) != 2 {
		t.Fatalf("previews = %+v", result.Previews)
	}
	if !result.Previews[0].Primary || result.Previews[0].ArchivePath != "Metadata/plate_2.png" {
		t.Fatalf("primary preview = %+v", result.Previews)
	}
	if len(result.GCode) != 1 || result.GCode[0].PlateNumber == nil || *result.GCode[0].PlateNumber != 2 {
		t.Fatalf("G-code = %+v", result.GCode)
	}
	if !result.GCode[0].Estimate.Resolved || result.GCode[0].Estimate.Quality != QualityHigh {
		t.Fatalf("G-code estimate = %+v", result.GCode[0].Estimate)
	}
}

func TestParseH2DFilamentRoutesAndSequence(t *testing.T) {
	t.Parallel()
	archive := makeZIP(t, []zipEntry{
		{name: "Metadata/slice_info.config", data: []byte(`<?xml version="1.0"?><config>
			<metadata key="filament_maps" value="2 1 1 1 1"/>
			<nozzle id="0" extruder_id="1"/><nozzle id="1" extruder_id="0"/>
			<filament id="1" used_g="2.5"/><filament id="5" used_g="4.5"/>
		</config>`)},
		{name: "Metadata/filament_sequence.json", data: []byte(`{"plate_1":{"nozzle_sequence":[0,1],"sequence":[5,1,5]}}`)},
	})
	result, err := Parse(bytes.NewReader(archive), int64(len(archive)), Limits{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Filaments) != 2 || len(result.Filaments[0].Extruders) != 1 || result.Filaments[0].Extruders[0] != 0 ||
		len(result.Filaments[1].Extruders) != 1 || result.Filaments[1].Extruders[0] != 1 {
		t.Fatalf("filament routes = %+v", result.Filaments)
	}
	if len(result.FilamentSequence) != 2 || result.FilamentSequence[0] != "5" || result.FilamentSequence[1] != "1" {
		t.Fatalf("filament sequence = %v", result.FilamentSequence)
	}
}

func TestParseMarksMalformedOrMissingMetadataPartial(t *testing.T) {
	t.Parallel()

	tests := map[string][]zipEntry{
		"missing":   {{name: "Metadata/plate_1.png", data: pngBytes(t, 1, 1, color.White)}},
		"malformed": {{name: "Metadata/project_settings.config", data: []byte(`{"broken"`)}},
		"unknown":   {{name: "Metadata/project_settings.config", data: []byte(`{"future_vendor_field_0":"value"}`)}},
	}
	for name, entries := range tests {
		name, entries := name, entries
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			archive := makeZIP(t, entries)
			result, err := Parse(bytes.NewReader(archive), int64(len(archive)), Limits{})
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if result.Status != StatusPartial || len(result.Warnings) == 0 {
				t.Fatalf("result = %+v", result)
			}
		})
	}
}

func TestOpenValidatedRejectsUnsafeArchives(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		entry    zipEntry
		limits   Limits
		wantCode string
	}{
		{name: "parent traversal", entry: zipEntry{name: "../secret", data: []byte("x")}, wantCode: "unsafe_path"},
		{name: "windows path", entry: zipEntry{name: `C:\\secret`, data: []byte("x")}, wantCode: "unsafe_path"},
		{name: "entry too large", entry: zipEntry{name: "large", data: []byte("12")}, limits: Limits{MaxEntrySize: 1}, wantCode: "entry_size"},
		{name: "expanded total", entry: zipEntry{name: "large", data: []byte("12")}, limits: Limits{MaxExpandedSize: 1}, wantCode: "expanded_size"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			archive := makeZIP(t, []zipEntry{test.entry})
			_, err := OpenValidated(bytes.NewReader(archive), int64(len(archive)), test.limits)
			assertValidationCode(t, err, test.wantCode)
		})
	}
}

func TestOpenValidatedRejectsSymlinkAndEncryptedFlag(t *testing.T) {
	t.Parallel()

	symlinkArchive := makeZIP(t, []zipEntry{{name: "Metadata/link", data: []byte("target"), mode: 0o777 | fs.ModeSymlink}})
	_, err := OpenValidated(bytes.NewReader(symlinkArchive), int64(len(symlinkArchive)), Limits{})
	assertValidationCode(t, err, "unsafe_entry_type")

	encryptedArchive := makeZIP(t, []zipEntry{{name: "Metadata/file", data: []byte("x"), encrypted: true}})
	_, err = OpenValidated(bytes.NewReader(encryptedArchive), int64(len(encryptedArchive)), Limits{})
	assertValidationCode(t, err, "encrypted_entry")
}

func TestOpenValidatedRejectsCompressedSizeAndEntryCount(t *testing.T) {
	t.Parallel()

	archive := makeZIP(t, []zipEntry{{name: "one", data: []byte("1")}, {name: "two", data: []byte("2")}})
	_, err := OpenValidated(bytes.NewReader(archive), int64(len(archive)), Limits{MaxEntries: 1})
	assertValidationCode(t, err, "entry_count")

	_, err = OpenValidated(bytes.NewReader(archive), int64(len(archive)), Limits{MaxCompressedSize: int64(len(archive) - 1)})
	assertValidationCode(t, err, "compressed_size")
}

func TestParseRejectsInvalidAndOversizedPreviewsWithoutFailingArchive(t *testing.T) {
	t.Parallel()

	archive := makeZIP(t, []zipEntry{
		{name: "Metadata/project_settings.config", data: []byte(`{"project_name":"safe"}`)},
		{name: "Metadata/plate_1.png", data: []byte("not a PNG")},
	})
	result, err := Parse(bytes.NewReader(archive), int64(len(archive)), Limits{MaxPreviewSize: 4})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if result.Status != StatusPartial || len(result.Previews) != 0 {
		t.Fatalf("result = %+v", result)
	}
}

func TestPreviewFallbackChoosesLargestPlateDeterministically(t *testing.T) {
	t.Parallel()

	archive := makeZIP(t, []zipEntry{
		{name: "Metadata/project_settings.config", data: []byte(`{"project_name":"safe"}`)},
		{name: "Metadata/thumbnail.png", data: pngBytes(t, 100, 100, color.White)},
		{name: "Metadata/plate_2.png", data: pngBytes(t, 20, 20, color.Black)},
		{name: "Metadata/plate_1.png", data: pngBytes(t, 20, 20, color.RGBA{B: 200, A: 255})},
	})
	result, err := Parse(bytes.NewReader(archive), int64(len(archive)), Limits{})
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	found := false
	for _, preview := range result.Previews {
		if preview.Primary {
			found = true
			if preview.ArchivePath != "Metadata/plate_1.png" {
				t.Fatalf("primary = %q", preview.ArchivePath)
			}
		}
	}
	if !found {
		t.Fatal("no primary preview selected")
	}
}

type zipEntry struct {
	name      string
	data      []byte
	mode      fs.FileMode
	encrypted bool
}

func makeZIP(t *testing.T, entries []zipEntry) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Deflate}
		if entry.mode != 0 {
			header.SetMode(entry.mode)
		}
		if entry.encrypted {
			header.Flags |= 0x1
		}
		file, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatalf("CreateHeader: %v", err)
		}
		if _, err := file.Write(entry.data); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	return output.Bytes()
}

func pngBytes(t *testing.T, width, height int, fill color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, fill)
		}
	}
	var output bytes.Buffer
	if err := png.Encode(&output, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return output.Bytes()
}

func assertValidationCode(t *testing.T, err error, code string) {
	t.Helper()
	var validationErr *ValidationError
	if !errors.As(err, &validationErr) || validationErr.Code != code {
		t.Fatalf("error = %v, want validation code %q", err, code)
	}
}
