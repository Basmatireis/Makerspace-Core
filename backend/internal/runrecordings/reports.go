package runrecordings

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var reasonPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)

var (
	consumptionReportStates = map[string]bool{"pending": true, "reported": true, "unavailable": true}
	timelapseReportStates   = map[string]bool{"pending": true, "uploaded": true, "not_found": true, "failed": true, "skipped": true}
)

// maxReportClockSkew bounds how far in the future a connector's observation time may lie.
const maxReportClockSkew = 5 * time.Minute

// ReportRun stores a connector's latest consumption and timelapse facts for one
// of its runs. Telemetry: never audited; an older observation never replaces a
// newer one.
func (s *Service) ReportRun(
	ctx context.Context,
	connector printerconnectors.Context,
	assignmentID, runID uuid.UUID,
	report RunReport,
) error {
	if connector.Lifecycle != printerconnectors.LifecycleActive {
		return apperror.New(http.StatusForbidden, "printer_connector_inactive", "Connector is not active")
	}
	if report.ProtocolVersion != 1 || report.ObservedAt.IsZero() ||
		report.ObservedAt.After(s.now().Add(maxReportClockSkew)) {
		return invalid("run_report_invalid", "Run report version or observation time is invalid")
	}
	if !validSection(report.Consumption, consumptionReportStates) || !validSection(report.Timelapse, timelapseReportStates) {
		return invalid("run_report_invalid", "Run report state or reason is invalid")
	}
	q := db.New(s.pool)
	if _, err := q.GetConnectorRunTarget(ctx, db.GetConnectorRunTargetParams{
		RunID:        runID,
		AssignmentID: assignmentID,
		ConnectorID:  connector.ID,
	}); errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	observed := report.ObservedAt.UTC()
	if section := report.Consumption; section != nil {
		if err := q.UpsertRunConsumptionReport(ctx, db.UpsertRunConsumptionReportParams{
			RunID:      runID,
			State:      &section.State,
			Reason:     section.Reason,
			Detail:     section.Detail,
			ObservedAt: timestamptz(observed),
		}); err != nil {
			return err
		}
	}
	if section := report.Timelapse; section != nil {
		if err := q.UpsertRunTimelapseReport(ctx, db.UpsertRunTimelapseReportParams{
			RunID:      runID,
			State:      &section.State,
			Reason:     section.Reason,
			Detail:     section.Detail,
			ObservedAt: timestamptz(observed),
		}); err != nil {
			return err
		}
	}
	return nil
}

func validSection(section *RunReportSection, states map[string]bool) bool {
	if section == nil {
		return true
	}
	if !states[section.State] {
		return false
	}
	for _, value := range []*string{section.Reason, section.Detail} {
		if value != nil && !reasonPattern.MatchString(*value) {
			return false
		}
	}
	return true
}
