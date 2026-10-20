package printerconnector

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

type Observation struct {
	Kind            string
	Payload         json.RawMessage
	RunID           *uuid.UUID
	HistoryComplete bool
	ExternalPrintID *string
	ReportRevision  *int64
}
type Sink interface {
	Commit(context.Context, Observation) error
}

type Capability string

const (
	CapabilityStatus      Capability = "status"
	CapabilityProgress    Capability = "progress"
	CapabilitySlots       Capability = "slots"
	CapabilityConsumption Capability = "consumption"
	CapabilityTerminal    Capability = "terminal_outcome"
	CapabilityDiscovery   Capability = "discovery"
)

type AdapterDescriptor struct {
	Kind          string
	SchemaVersion int
	Capabilities  []Capability
}

type Adapter interface {
	Descriptor() AdapterDescriptor
	Run(context.Context, Sink) error
}

// Discoverer is optional. Adapters that cannot safely discover printers do
// not implement it; discovery never forms a trusted assignment by itself.
type Discoverer interface {
	Discover(context.Context) ([]DiscoveryCandidate, error)
}

type DiscoveryCandidate struct {
	Key         string
	Observation json.RawMessage
}

// simulatedPrintCounter numbers the simulated parts so successive prints show
// different file names.
var simulatedPrintCounter atomic.Uint64

type simulatorAdapter struct {
	interval time.Duration
	scenario string
}

func NewSimulator(settings map[string]any) (Adapter, error) {
	interval := 5 * time.Second
	if value, ok := settings["intervalSeconds"].(float64); ok && value >= 1 && value <= 3600 {
		interval = time.Duration(value) * time.Second
	}
	scenario, _ := settings["scenario"].(string)
	if scenario == "" {
		scenario = "idle"
	}
	if scenario != "idle" && scenario != "successful_print" && scenario != "failed_print" {
		return nil, errors.New("unsupported simulator scenario")
	}
	return &simulatorAdapter{interval: interval, scenario: scenario}, nil
}

func (a *simulatorAdapter) Descriptor() AdapterDescriptor {
	return AdapterDescriptor{
		Kind:          "simulator",
		SchemaVersion: 1,
		Capabilities:  []Capability{CapabilityStatus, CapabilityProgress, CapabilityConsumption, CapabilityTerminal},
	}
}

// simulatorSnapshot is a plausible fixed machine: one AMS with two spools, one
// external holder and a single right-hand nozzle.
func simulatorSnapshot(state string, job *liveJob) json.RawMessage {
	snapshot := newLiveSnapshot(state)
	snapshot.Job = job
	bed, bedTarget, chamber, nozzle, nozzleTarget := 28.0, 0.0, 26.0, 28.0, 0.0
	diameter, nozzleType, label := 0.4, "HS01", "Simulated PLA"
	signal := -42
	if state == "printing" {
		bed, bedTarget, nozzle, nozzleTarget = 60.0, 60.0, 220.0, 220.0
	}
	side := bambuExtruderSide(0)
	snapshot.Temperatures = liveTemperatures{
		Extruders:  []liveExtruderTemperature{{ExtruderID: 0, Side: side, CurrentC: &nozzle, TargetC: &nozzleTarget}},
		BedC:       &bed,
		BedTargetC: &bedTarget,
		ChamberC:   &chamber,
	}
	snapshot.Nozzles = []liveNozzle{{ExtruderID: 0, Side: side, DiameterMm: &diameter, Type: &nozzleType}}
	pla, petg, red, grey, humidity := "PLA", "PETG", "D32F2F", "9E9E9E", 18
	remainRed, remainGrey := 80, 35
	snapshot.Units = []liveUnit{
		{ExternalID: "0", Kind: "ams", Label: "AMS 0", HumidityPercent: &humidity, Trays: []liveTray{
			{
				ExternalID:    "0",
				MaterialType:  &pla,
				SubBrand:      &label,
				ColorHex:      &red,
				RemainPercent: &remainRed,
				RFID:          true,
			},
			{ExternalID: "1", MaterialType: &petg, ColorHex: &grey, RemainPercent: &remainGrey},
			{ExternalID: "2", Empty: true},
			{ExternalID: "3", Empty: true},
		}},
		{
			ExternalID: "254",
			Kind:       "external",
			Label:      "External spool 254",
			Trays:      []liveTray{{ExternalID: "254", Empty: true}},
		},
	}
	snapshot.ActiveTray = nil
	if state == "printing" {
		snapshot.ActiveTray = &liveActiveTray{UnitExternalID: "0", TrayExternalID: "0"}
	}
	snapshot.WifiSignalDbm = &signal
	return mustJSON(snapshot)
}

func (a *simulatorAdapter) Run(ctx context.Context, sink Sink) error {
	if err := sink.Commit(ctx, Observation{Kind: "connectivity", Payload: json.RawMessage(`{"state":"online"}`)}); err != nil {
		return err
	}
	live, _ := sink.(LiveStatusSink)
	report := func(state string, job *liveJob) {
		if live != nil {
			live.ReportLiveStatus(simulatorSnapshot(state, job))
		}
	}
	report("idle", nil)
	if a.scenario == "idle" {
		if err := sink.Commit(ctx, Observation{Kind: "operational_state", Payload: json.RawMessage(`{"state":"idle"}`)}); err != nil {
			return err
		}
		<-ctx.Done()
		return ctx.Err()
	}
	ticker := time.NewTicker(a.interval)
	defer ticker.Stop()
	progress := 0
	runID := uuid.Must(uuid.NewV7())
	fileName := "simulated_part_" + strconv.FormatUint(simulatedPrintCounter.Add(1), 10) + ".gcode"
	job := "sim-" + runID.String()
	revision := int64(1)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			progress += 20
			if progress < 100 {
				remaining := int64(math.Ceil(float64(100-progress) / 20 * a.interval.Seconds()))
				percent, minutes, layer, layers := progress, int(math.Ceil(float64(remaining)/60)), progress, 100
				report(
					"printing",
					&liveJob{
						FileName:         &fileName,
						ProgressPercent:  &percent,
						RemainingMinutes: &minutes,
						Layer:            &layer,
						TotalLayers:      &layers,
					},
				)
				payload, _ := json.Marshal(
					map[string]any{
						"state":            "printing",
						"percent":          progress,
						"remainingSeconds": remaining,
						"fileName":         fileName,
					},
				)
				if err := sink.Commit(ctx, Observation{Kind: "progress", Payload: payload, RunID: &runID, HistoryComplete: true, ExternalPrintID: &job}); err != nil {
					return err
				}
				continue
			}
			outcome := "completed"
			if a.scenario == "failed_print" {
				outcome = "failed"
			}
			if outcome == "completed" {
				report("finished", nil)
			} else {
				report("failed", nil)
			}
			payload, _ := json.Marshal(map[string]any{"outcome": outcome})
			if err := sink.Commit(ctx, Observation{Kind: "terminal_outcome", Payload: payload, RunID: &runID, HistoryComplete: true, ExternalPrintID: &job}); err != nil {
				return err
			}
			if err := sink.Commit(ctx, Observation{Kind: "consumption_report", Payload: json.RawMessage(`{"quantityGrams":"12.5","quantityBasis":"estimated"}`), RunID: &runID, HistoryComplete: true, ExternalPrintID: &job, ReportRevision: &revision}); err != nil {
				return err
			}
			<-ctx.Done()
			return ctx.Err()
		}
	}
}
