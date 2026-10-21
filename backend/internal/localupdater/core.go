package localupdater

import (
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// RequestState is Core's view of the latest update request of a connector or gateway.
type RequestState string

const (
	StateRequested  RequestState = "requested"
	StateInProgress RequestState = "in_progress"
	StateSucceeded  RequestState = "succeeded"
	StateFailed     RequestState = "failed"
)

// Open reports whether the request still waits for the updater's answer.
func (s RequestState) Open() bool { return s == StateRequested || s == StateInProgress }

// RequestTimeout is how long Core keeps an update in progress from being requested again. After it a
// new request supersedes one whose answer never arrived.
const RequestTimeout = 15 * time.Minute

// Settle is the request state after a heartbeat. The updater's result counts only for the current
// request. Without a result, a service that now runs the requested release has evidently been
// updated (for example by hand). changed is false when the state stays as it is.
func Settle(
	state RequestState,
	requestID uuid.UUID,
	target, running string,
	report *Report,
) (next RequestState, reason *string, changed bool) {
	if !state.Open() {
		return state, nil, false
	}
	if report != nil && report.Result != nil && report.Result.RequestID == requestID {
		switch report.Result.Status {
		case StatusInProgress:
			if state == StateInProgress {
				return state, nil, false
			}
			return StateInProgress, nil, true
		case StatusSucceeded:
			return StateSucceeded, report.Result.Reason, true
		case StatusFailed:
			failure := ReasonInvalidRequest
			if report.Result.Reason != nil && reasonPattern.MatchString(*report.Result.Reason) {
				failure = *report.Result.Reason
			}
			return StateFailed, &failure, true
		}
	}
	if running == target {
		return StateSucceeded, nil, true
	}
	return state, nil, false
}

// Current is the update state of a connector or gateway that CheckRequest looks at.
type Current struct {
	Active           bool
	UpdaterAvailable bool
	RunningVersion   *string
	State            *RequestState
	StatusAt         time.Time
}

// CheckRequest decides whether an update to target may be requested. Core offers only its own
// release: target must equal coreVersion, which must be a release, and be newer than the running one.
func CheckRequest(coreVersion, target string, current Current, now time.Time) error {
	switch {
	case !ValidVersion(coreVersion):
		return apperror.Conflicting(
			"core_version_unreleased",
			"Core is a development build; update the service manually",
		)
	case target != coreVersion:
		return apperror.Conflicting("update_target_mismatch", "Updates install Core's version only")
	case !current.Active:
		return apperror.Conflicting("update_service_inactive", "Only an active service can be updated")
	case !current.UpdaterAvailable:
		return apperror.Conflicting(
			"updater_unavailable",
			"The service reports no updater; update it manually",
		)
	case current.RunningVersion == nil || !ValidVersion(*current.RunningVersion):
		return apperror.Conflicting(
			"update_version_unknown",
			"The service does not run a release version; update it manually",
		)
	case !Newer(target, *current.RunningVersion):
		return apperror.Conflicting("update_not_newer", "The service already runs this or a newer version")
	case current.State != nil && current.State.Open() && now.Sub(current.StatusAt) < RequestTimeout:
		return apperror.Conflicting("update_in_progress", "An update of this service is already in progress")
	}
	return nil
}
