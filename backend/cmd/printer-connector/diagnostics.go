package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/printartifacts/parser"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnector"
)

const maximumDiagnosticGCodeBytes int64 = 1 << 30

func runOfflineCommand(args []string, stdout io.Writer) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	switch args[0] {
	case "inspect-3mf":
		return true, inspect3MF(args[1:], stdout)
	case "calculate-consumption":
		return true, calculateConsumption(args[1:], stdout)
	case "sanitize-mqtt":
		return true, sanitizeMQTT(args[1:])
	case "replay-mqtt":
		return true, replayMQTT(args[1:], stdout)
	default:
		return false, nil
	}
}

func inspect3MF(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("inspect-3mf", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	fileName := flags.String("file", "", "path to a local 3MF")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("inspect-3mf: %w", err)
	}
	if *fileName == "" || flags.NArg() != 0 {
		return errors.New("inspect-3mf requires exactly --file PATH")
	}
	file, size, err := openRegularFile(*fileName, parser.DefaultLimits().MaxCompressedSize)
	if err != nil {
		return fmt.Errorf("inspect-3mf: %w", err)
	}
	defer func() { _ = file.Close() }()
	result, err := parser.Parse(file, size, parser.DefaultLimits())
	if err != nil {
		return fmt.Errorf("inspect-3mf: %w", err)
	}
	previews := make([]previewInspection, 0, len(result.Previews))
	for _, preview := range result.Previews {
		previews = append(previews, previewInspection{
			ArchivePath: preview.ArchivePath, Role: preview.Role, PlateNumber: preview.PlateNumber,
			Width: preview.Width, Height: preview.Height, MIMEType: preview.MIMEType,
			Size: preview.Size, SHA256: preview.SHA256, Primary: preview.Primary,
		})
	}
	return writeIndentedJSON(stdout, artifactInspection{
		ParserVersion: result.ParserVersion, Status: result.Status, Metadata: result.Metadata,
		Filaments: result.Filaments, FilamentSequence: result.FilamentSequence,
		Previews: previews, GCode: result.GCode, Warnings: result.Warnings,
	})
}

type artifactInspection struct {
	ParserVersion    string              `json:"parserVersion"`
	Status           parser.Status       `json:"status"`
	Metadata         parser.Metadata     `json:"metadata"`
	Filaments        []parser.Filament   `json:"filaments"`
	FilamentSequence []string            `json:"filamentSequence,omitempty"`
	Previews         []previewInspection `json:"previews"`
	GCode            []parser.GCodeFile  `json:"gcode"`
	Warnings         []string            `json:"warnings,omitempty"`
}

type previewInspection struct {
	ArchivePath string             `json:"archivePath"`
	Role        parser.PreviewRole `json:"role"`
	PlateNumber *int               `json:"plateNumber,omitempty"`
	Width       int                `json:"width"`
	Height      int                `json:"height"`
	MIMEType    string             `json:"mimeType"`
	Size        int64              `json:"size"`
	SHA256      string             `json:"sha256"`
	Primary     bool               `json:"primary"`
}

func calculateConsumption(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("calculate-consumption", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	gcodePath := flags.String("gcode", "", "path to a local G-code file")
	artifactPath := flags.String("artifact", "", "optional 3MF supplying filament conversion metadata")
	lastLayer := flags.Int("last-layer", -1, "last reliable MQTT layer")
	lastProgress := flags.Float64("last-progress", -1, "last reliable embedded progress, from 0 to 100")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("calculate-consumption: %w", err)
	}
	if *gcodePath == "" || flags.NArg() != 0 {
		return errors.New("calculate-consumption requires exactly --gcode PATH")
	}
	if *lastLayer < -1 {
		return errors.New("calculate-consumption --last-layer must be zero or greater")
	}
	if *lastProgress < -1 || *lastProgress > 100 {
		return errors.New("calculate-consumption --last-progress must be between 0 and 100")
	}

	options := parser.GCodeOptions{}
	if *lastLayer >= 0 {
		options.LastReliableLayer = lastLayer
	}
	if *lastProgress >= 0 {
		options.LastReliableProgress = lastProgress
	}
	if *artifactPath != "" {
		artifact, size, err := openRegularFile(*artifactPath, parser.DefaultLimits().MaxCompressedSize)
		if err != nil {
			return fmt.Errorf("calculate-consumption artifact: %w", err)
		}
		parsed, parseErr := parser.Parse(artifact, size, parser.DefaultLimits())
		closeErr := artifact.Close()
		if parseErr != nil {
			return fmt.Errorf("calculate-consumption artifact: %w", parseErr)
		}
		if closeErr != nil {
			return fmt.Errorf("calculate-consumption artifact: %w", closeErr)
		}
		for _, filament := range parsed.Filaments {
			options.Filaments = append(options.Filaments, parser.GCodeFilament{
				ID: filament.ID, DiameterMM: filament.DiameterMM, DensityGCM3: filament.DensityGCM3,
				FullLengthMM: filament.LengthMM, FullWeightGrams: filament.WeightGrams,
			})
		}
	}
	gcode, _, err := openRegularFile(*gcodePath, maximumDiagnosticGCodeBytes)
	if err != nil {
		return fmt.Errorf("calculate-consumption G-code: %w", err)
	}
	defer func() { _ = gcode.Close() }()
	estimate, err := parser.EstimateGCode(gcode, options)
	if err != nil {
		return fmt.Errorf("calculate-consumption: %w", err)
	}
	return writeIndentedJSON(stdout, estimate)
}

func sanitizeMQTT(args []string) (returnErr error) {
	flags := flag.NewFlagSet("sanitize-mqtt", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	inputPath := flags.String("input", "", "raw MQTT NDJSON input")
	outputPath := flags.String("output", "", "new sanitized fixture path")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("sanitize-mqtt: %w", err)
	}
	if *inputPath == "" || *outputPath == "" || flags.NArg() != 0 {
		return errors.New("sanitize-mqtt requires exactly --input PATH --output NEW_PATH")
	}
	input, _, err := openRegularFile(*inputPath, printerconnector.MaximumBambuFixtureBytes)
	if err != nil {
		return fmt.Errorf("sanitize-mqtt input: %w", err)
	}
	defer func() { _ = input.Close() }()
	output, err := os.OpenFile(*outputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("sanitize-mqtt output: %w", err)
	}
	defer func() {
		if returnErr != nil {
			_ = os.Remove(*outputPath)
		}
	}()
	if err = printerconnector.SanitizeBambuMQTTFixture(input, output); err != nil {
		_ = output.Close()
		return fmt.Errorf("sanitize-mqtt: %w", err)
	}
	if err = output.Close(); err != nil {
		return fmt.Errorf("sanitize-mqtt output: %w", err)
	}
	return nil
}

func replayMQTT(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("replay-mqtt", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	inputPath := flags.String("input", "", "sanitized MQTT NDJSON fixture")
	adapterKind := flags.String("adapter", "bambu_h2d", "Bambu adapter kind: bambu_h2d or bambu_x1c")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("replay-mqtt: %w", err)
	}
	if *inputPath == "" || flags.NArg() != 0 {
		return errors.New("replay-mqtt requires exactly --input PATH")
	}
	input, _, err := openRegularFile(*inputPath, printerconnector.MaximumBambuFixtureBytes)
	if err != nil {
		return fmt.Errorf("replay-mqtt input: %w", err)
	}
	defer func() { _ = input.Close() }()
	if err = printerconnector.ReplayBambuMQTTFixtureFor(input, stdout, printerconnector.AdapterKind(*adapterKind)); err != nil {
		return fmt.Errorf("replay-mqtt: %w", err)
	}
	return nil
}

func openRegularFile(fileName string, maximumSize int64) (*os.File, int64, error) {
	file, err := os.Open(fileName) //nolint:gosec // file name is an operator-supplied command-line argument of a diagnostics tool
	if err != nil {
		return nil, 0, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, 0, err
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, 0, errors.New("path is not a regular file")
	}
	if info.Size() < 0 || info.Size() > maximumSize {
		_ = file.Close()
		return nil, 0, fmt.Errorf("file exceeds %d bytes", maximumSize)
	}
	return file, info.Size(), nil
}

func writeIndentedJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return fmt.Errorf("write diagnostic output: %w", err)
	}
	return nil
}
