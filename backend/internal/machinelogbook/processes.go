package machinelogbook

import (
	"context"
	"sort"

	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// Machine processes. A machine type has exactly one; it decides which run
// measures exist, which materials fit and whether a printer setup is offered.
const (
	ProcessFDMPrinting  = "fdm_printing"
	ProcessEmbroidery   = "embroidery"
	ProcessUVPrinting   = "uv_printing"
	ProcessLaserCutting = "laser_cutting"
	ProcessVinylCutting = "vinyl_cutting"
	ProcessOther        = "other"
)

var machineProcesses = []string{ProcessFDMPrinting, ProcessEmbroidery, ProcessUVPrinting, ProcessLaserCutting, ProcessVinylCutting, ProcessOther}

func validProcess(process string) bool {
	for _, candidate := range machineProcesses {
		if candidate == process {
			return true
		}
	}
	return false
}

// Run measures: counted facts of a run that are not material. Each is priced per
// block (rate per blockSize units).
const MeasureStitches = "stitches"

type measureDefinition struct {
	Key, Label, Unit string
	BlockSize        int32
}

var measureDefinitions = map[string]measureDefinition{
	MeasureStitches: {Key: MeasureStitches, Label: "Stitches", Unit: "stitch", BlockSize: 1000},
}

// processMeasures lists the measures a process records.
var processMeasures = map[string][]string{
	ProcessEmbroidery: {MeasureStitches},
}

func processSupportsMeasure(process, measure string) bool {
	for _, candidate := range processMeasures[process] {
		if candidate == measure {
			return true
		}
	}
	return false
}

// RunMeasures maps a measure key to its value.
type RunMeasures map[string]int64

// validateMeasures checks the keys and values of measures entered for a run on a
// machine with the given process. A nil input is "no measures".
func validateMeasures(process string, input RunMeasures) error {
	for key, value := range input {
		if _, known := measureDefinitions[key]; !known {
			return validation("unknown measure")
		}
		if value < 0 {
			return validation("a measure cannot be negative")
		}
		if !processSupportsMeasure(process, key) {
			return apperror.New(422, "run_measure_unsupported", "The machine's process does not record this measure")
		}
	}
	return nil
}

func (m RunMeasures) clone() RunMeasures {
	out := RunMeasures{}
	for key, value := range m {
		out[key] = value
	}
	return out
}

func (m RunMeasures) add(other RunMeasures) {
	for key, value := range other {
		m[key] += value
	}
}

func sortedMeasureKeys(m RunMeasures) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// machineProcess returns the process of the machine's type.
func machineProcess(ctx context.Context, q *machinelogbookdb.Queries, machineID uuid.UUID) (string, error) {
	process, err := q.GetMachineProcess(ctx, machineID)
	if err != nil {
		return "", noRows(err)
	}
	return process, nil
}

// storeRunMeasures replaces the measures of a run with the given ones.
func storeRunMeasures(ctx context.Context, q *machinelogbookdb.Queries, runID uuid.UUID, measures RunMeasures) error {
	if err := q.DeleteRunMeasures(ctx, runID); err != nil {
		return err
	}
	for _, key := range sortedMeasureKeys(measures) {
		if err := q.UpsertRunMeasure(ctx, machinelogbookdb.UpsertRunMeasureParams{RunID: runID, Measure: key, Value: measures[key]}); err != nil {
			return databaseError(err)
		}
	}
	return nil
}

// requireMaterialsForProcess refuses new makerspace usages of materials whose
// type is not usable for the process. Materials in keep are already used by
// the run and stay allowed, so a correction never fails on old material.
func requireMaterialsForProcess(ctx context.Context, q *machinelogbookdb.Queries, process string, items []parsedUsage, keep map[uuid.UUID]bool) error {
	ids := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		if item.Ownership == "makerspace" && item.MaterialID != nil && !keep[*item.MaterialID] {
			ids = append(ids, *item.MaterialID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.ListMaterialsOutsideProcess(ctx, machinelogbookdb.ListMaterialsOutsideProcessParams{MaterialIds: ids, Process: process})
	if err != nil {
		return err
	}
	if len(rows) > 0 {
		return apperror.New(422, "material_process_mismatch", "The material \""+rows[0].Name+"\" cannot be used on a machine with this process")
	}
	return nil
}
