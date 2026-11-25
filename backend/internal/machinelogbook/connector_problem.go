package machinelogbook

import (
	"strings"
	"time"
)

// ConnectorProblem is what kind of trouble a machine's printer connector is in. Machine attention and the
// printer_connector_problem notification derive it the same way.
type ConnectorProblem string

const (
	// ConnectorProblemNone: the connector reaches Core and the printer.
	ConnectorProblemNone ConnectorProblem = ""
	// ConnectorProblemOffline: the connector has not been heard from or reports the printer disconnected.
	ConnectorProblemOffline ConnectorProblem = "offline"
	// ConnectorProblemStorage: the printer reports its status, but print files and timelapses cannot be fetched.
	ConnectorProblemStorage ConnectorProblem = "storage"
	// ConnectorProblemConnection: the connector cannot talk to the printer reliably (MQTT, TLS, status snapshot).
	ConnectorProblemConnection ConnectorProblem = "connection"
	// ConnectorProblemOther: any other degraded state.
	ConnectorProblemOther ConnectorProblem = "other"
)

// ConnectorFacts are the stored facts of one machine's active connector assignment.
type ConnectorFacts struct {
	LastHeartbeatAt *time.Time
	// RuntimeState and RuntimeErrorCode come from the assignment's own health in the heartbeat.
	RuntimeState     *string
	RuntimeErrorCode *string
	// HealthState is the connector's overall health, used only when the assignment reported none.
	HealthState *string
}

// ClassifyConnectorProblem derives the connector's problem from its facts at now.
func ClassifyConnectorProblem(facts ConnectorFacts, now time.Time) (ConnectorProblem, string) {
	if facts.LastHeartbeatAt == nil || now.Sub(*facts.LastHeartbeatAt) > ConnectorHeartbeatStale {
		return ConnectorProblemOffline, ""
	}
	state, code := "", ""
	if facts.RuntimeState != nil {
		state = *facts.RuntimeState
	}
	if facts.RuntimeErrorCode != nil {
		code = *facts.RuntimeErrorCode
	}
	switch {
	case state == "disconnected":
		return ConnectorProblemOffline, code
	case state == "degraded" || code != "":
	case state == "" && facts.HealthState != nil && *facts.HealthState == "degraded":
	default:
		return ConnectorProblemNone, ""
	}
	switch {
	case strings.HasPrefix(code, "ftps_") || code == "storage_worker_stalled" || code == "artifact_backlog_full" ||
		strings.HasPrefix(code, "artifact_"):
		return ConnectorProblemStorage, code
	case strings.HasPrefix(code, "mqtt_") || strings.HasPrefix(code, "tls_") || code == "snapshot_timeout":
		return ConnectorProblemConnection, code
	default:
		return ConnectorProblemOther, code
	}
}

// ConnectorProblemMessage is a short sentence for people about the problem.
func ConnectorProblemMessage(problem ConnectorProblem, code string) string {
	suffix := ""
	if code != "" {
		suffix = " (" + code + ")"
	}
	switch problem {
	case ConnectorProblemOffline:
		return "The printer connector is offline."
	case ConnectorProblemStorage:
		switch code {
		case "ftps_timeout", "ftps_protocol_failed", "ftps_control_tls_failed":
			return "The printer's file storage does not answer, so print files and timelapses are not fetched. " +
				"Restarting the printer usually helps" + suffix + "."
		case "ftps_authentication_failed":
			return "The printer rejects the access code, so print files and timelapses are not fetched" + suffix + "."
		case "storage_worker_stalled":
			return "The connector has been stuck fetching print files and timelapses for more than 20 minutes" + suffix + "."
		}
		return "Print files and timelapses cannot be fetched from the printer" + suffix + "."
	case ConnectorProblemConnection:
		return "The printer connector cannot talk to the printer reliably" + suffix + "."
	case ConnectorProblemOther:
		return "The printer connector reports a problem" + suffix + "."
	}
	return ""
}
