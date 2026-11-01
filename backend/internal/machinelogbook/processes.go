package machinelogbook

import (
	"context"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// ProcessIntegration says whether a process comes with software support.
type ProcessIntegration string

const (
	// IntegrationNone is a process the makerspace only logs by hand or from a recorder.
	IntegrationNone ProcessIntegration = "none"
	// IntegrationFDMPrinter processes have machines with a printer setup and a connector.
	IntegrationFDMPrinter ProcessIntegration = "fdm_printer"
)

func validIntegration(value ProcessIntegration) bool {
	return value == IntegrationNone || value == IntegrationFDMPrinter
}

// Limits of a process's measure list.
const (
	maxProcessMeasures    = 20
	maxMeasureLabelLength = 60
	maxMeasureUnitLength  = 20
)

var measureKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{1,39}$`)

// ProcessMeasure is a counted fact of a run that is not material (stitches, passes, ...). Each is priced per
// BlockSize units.
type ProcessMeasure struct {
	Key, Label, Unit string
	BlockSize        int32
}

// validateProcessMeasures normalises a measure list: trimmed texts, unique keys of the permitted pattern.
func validateProcessMeasures(input []ProcessMeasure) ([]ProcessMeasure, error) {
	if len(input) > maxProcessMeasures {
		return nil, apperror.Invalid("a process has at most 20 measures")
	}
	seen := map[string]bool{}
	result := make([]ProcessMeasure, 0, len(input))
	for _, m := range input {
		m.Label, m.Unit = strings.TrimSpace(m.Label), strings.TrimSpace(m.Unit)
		if !measureKeyPattern.MatchString(m.Key) {
			return nil, apperror.Invalid("a measure key is lower case letters, digits and underscores, 2 to 40 characters")
		}
		if seen[m.Key] {
			return nil, apperror.Invalid("measure keys must be unique")
		}
		seen[m.Key] = true
		if n := utf8.RuneCountInString(m.Label); n < 1 || n > maxMeasureLabelLength {
			return nil, apperror.Invalid("a measure label has 1 to 60 characters")
		}
		if n := utf8.RuneCountInString(m.Unit); n < 1 || n > maxMeasureUnitLength {
			return nil, apperror.Invalid("a measure unit has 1 to 20 characters")
		}
		if m.BlockSize < 1 {
			return nil, apperror.Invalid("a measure blockSize must be at least 1")
		}
		result = append(result, m)
	}
	return result, nil
}

func processMeasureFromRow(row machinelogbookdb.ProcessMeasure) ProcessMeasure {
	return ProcessMeasure{Key: row.Key, Label: row.Label, Unit: row.Unit, BlockSize: row.BlockSize}
}

// loadProcessMeasures returns the measures of the given processes in their stored order.
func loadProcessMeasures(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	processIDs []uuid.UUID,
) (map[uuid.UUID][]ProcessMeasure, error) {
	result := map[uuid.UUID][]ProcessMeasure{}
	if len(processIDs) == 0 {
		return result, nil
	}
	rows, err := q.ListProcessMeasures(ctx, processIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		result[row.ProcessID] = append(result[row.ProcessID], processMeasureFromRow(row))
	}
	return result, nil
}

// processMeasureMap returns the measures of one process by key.
func processMeasureMap(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	processID uuid.UUID,
) (map[string]ProcessMeasure, error) {
	byProcess, err := loadProcessMeasures(ctx, q, []uuid.UUID{processID})
	if err != nil {
		return nil, err
	}
	result := map[string]ProcessMeasure{}
	for _, m := range byProcess[processID] {
		result[m.Key] = m
	}
	return result, nil
}

// RunMeasures maps a measure key to its value.
type RunMeasures map[string]int64

// validateMeasures checks the keys and values of measures entered for a run against the measures of the
// machine's process. A nil input is "no measures".
func validateMeasures(supported map[string]ProcessMeasure, input RunMeasures) error {
	for key, value := range input {
		if !measureKeyPattern.MatchString(key) {
			return apperror.Invalid("unknown measure")
		}
		if value < 0 {
			return apperror.Invalid("a measure cannot be negative")
		}
		if _, ok := supported[key]; !ok {
			return apperror.New(
				http.StatusUnprocessableEntity,
				"run_measure_unsupported",
				"The machine's process does not record this measure",
			)
		}
	}
	return nil
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

// machineProcessInfo is the process of a machine as far as run validation needs it.
type machineProcessInfo struct {
	ID          uuid.UUID
	Integration ProcessIntegration
	Measures    map[string]ProcessMeasure
}

// machineProcess returns the id, integration and measures of the machine's process.
func machineProcess(ctx context.Context, q *machinelogbookdb.Queries, machineID uuid.UUID) (machineProcessInfo, error) {
	row, err := q.GetMachineProcess(ctx, machineID)
	if err != nil {
		return machineProcessInfo{}, noRows(err)
	}
	measures, err := processMeasureMap(ctx, q, row.ProcessID)
	if err != nil {
		return machineProcessInfo{}, err
	}
	return machineProcessInfo{ID: row.ProcessID, Integration: ProcessIntegration(row.Integration), Measures: measures}, nil
}

// storeRunMeasures replaces the measures of a run with the given ones.
func storeRunMeasures(ctx context.Context, q *machinelogbookdb.Queries, runID uuid.UUID, measures RunMeasures) error {
	if err := q.DeleteRunMeasures(ctx, runID); err != nil {
		return err
	}
	for _, key := range sortedMeasureKeys(measures) {
		if err := q.UpsertRunMeasure(
			ctx,
			machinelogbookdb.UpsertRunMeasureParams{RunID: runID, Measure: key, Value: measures[key]},
		); err != nil {
			return databaseError(err)
		}
	}
	return nil
}

// requireMaterialsForProcess refuses new makerspace usages of materials whose
// type is not usable for the process. Materials in keep are already used by
// the run and stay allowed, so a correction never fails on old material.
func requireMaterialsForProcess(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	processID uuid.UUID,
	items []parsedUsage,
	keep map[uuid.UUID]bool,
) error {
	ids := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		if UsageOwnership(item.Ownership) == OwnershipMakerspace && item.MaterialID != nil && !keep[*item.MaterialID] {
			ids = append(ids, *item.MaterialID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.ListMaterialsOutsideProcess(
		ctx,
		machinelogbookdb.ListMaterialsOutsideProcessParams{MaterialIds: ids, ProcessID: processID},
	)
	if err != nil {
		return err
	}
	if len(rows) > 0 {
		return apperror.New(
			http.StatusUnprocessableEntity,
			"material_process_mismatch",
			"The material \""+rows[0].Name+"\" cannot be used on a machine with this process",
		)
	}
	return nil
}

func (p machineProcessInfo) supports(measure string) bool {
	_, ok := p.Measures[measure]
	return ok
}
