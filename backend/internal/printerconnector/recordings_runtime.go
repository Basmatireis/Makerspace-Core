package printerconnector

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
)

// Recording follow-up runs only against a Core whose configuration announces
// `recordings`; an older Core never sees the new endpoints.

const (
	recordingsInterval     = 5 * time.Second
	commandPollInterval    = 10 * time.Second
	refetchRetrievalWindow = 30 * time.Minute
)

// Command failure reasons reported to Core.
const (
	commandReasonAssignmentNotRunning = "assignment_not_running"
	commandReasonAdapterUnsupported   = "adapter_unsupported"
	commandReasonPathUnknown          = "artifact_path_unknown"
	commandReasonRunFactsUnavailable  = "run_facts_unavailable"
	commandReasonDownloadFailed       = "artifact_download_failed"
	commandReasonUnsupported          = "command_unsupported"
)

// RecordingFeatures returns Core's current recording features, nil when Core
// does not support them.
func (r *Runtime) RecordingFeatures() *RecordingFeatures {
	return r.features.Load()
}

func (r *Runtime) setIdentity(identity Identity) {
	r.mu.Lock()
	r.identity = identity
	r.mu.Unlock()
}

func (r *Runtime) currentIdentity() Identity {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.identity
}

// runRecordings polls commands, executes them and uploads timelapse videos
// outside the main loop, so long transfers never delay events or heartbeats.
func (r *Runtime) runRecordings(ctx context.Context) {
	ticker := time.NewTicker(recordingsInterval)
	defer ticker.Stop()
	var lastPoll time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if r.RecordingFeatures() == nil {
			continue
		}
		identity := r.currentIdentity()
		if time.Since(lastPoll) >= commandPollInterval {
			lastPoll = time.Now()
			if err := r.syncCommands(ctx, identity); err != nil {
				r.logFailure("command poll failed", err)
			}
		}
		if err := r.processCommands(ctx, identity); err != nil {
			r.logFailure("command processing failed", err)
		}
		if err := r.deliverTimelapses(ctx, identity); err != nil {
			r.logFailure("timelapse delivery failed", err)
		}
	}
}

func (r *Runtime) syncCommands(ctx context.Context, identity Identity) error {
	commands, err := r.client.ListCommands(ctx, identity.CredentialSecret)
	if err != nil {
		return err
	}
	for _, command := range commands {
		if err = r.store.AcceptRunCommand(ctx, RunCommand{
			ID:           command.ID,
			AssignmentID: command.AssignmentID,
			RunID:        command.RunID,
			Kind:         command.Kind,
		}); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) processCommands(ctx context.Context, identity Identity) error {
	accepted, err := r.store.RunCommandsInState(ctx, commandAccepted)
	if err != nil {
		return err
	}
	for _, command := range accepted {
		if err = r.startCommand(ctx, identity, command); err != nil {
			return err
		}
	}
	running, err := r.store.RunCommandsInState(ctx, commandRunning)
	if err != nil {
		return err
	}
	for _, command := range running {
		if err = r.checkCommand(ctx, command); err != nil {
			return err
		}
	}
	unreported, err := r.store.UnreportedRunCommands(ctx)
	if err != nil {
		return err
	}
	for _, command := range unreported {
		err = r.client.PutCommandStatus(ctx, identity.CredentialSecret, command.ID, command.State, command.ReasonCode)
		if err != nil && !isFinalCoreAnswer(err, http.StatusNotFound, http.StatusConflict) {
			return err
		}
		// A 404 or 409 means Core deleted, expired or finished the command; it will not change.
		if err = r.store.MarkRunCommandReported(ctx, command.ID, command.State); err != nil {
			return err
		}
	}
	return nil
}

// assignmentAdapter returns the adapter kind and configuration version of a
// running assignment.
func (r *Runtime) assignmentAdapter(id uuid.UUID) (AdapterKind, int64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	running, ok := r.running[id]
	return running.kind, running.configurationVersion, ok
}

func (r *Runtime) failCommand(ctx context.Context, command RunCommand, reason string) error {
	return r.store.SetRunCommandState(ctx, command.ID, commandFailed, &reason)
}

func (r *Runtime) startCommand(ctx context.Context, identity Identity, command RunCommand) error {
	kind, configurationVersion, running := r.assignmentAdapter(command.AssignmentID)
	if !running {
		return r.failCommand(ctx, command, commandReasonAssignmentNotRunning)
	}
	if !isBambuAdapterKind(kind) {
		return r.failCommand(ctx, command, commandReasonAdapterUnsupported)
	}
	switch command.Kind {
	case "refetch_artifact":
		err := r.store.RequeueArtifactRetrieval(
			ctx,
			command.AssignmentID,
			command.RunID,
			time.Now().UTC().Add(refetchRetrievalWindow),
		)
		if errors.Is(err, errArtifactPathUnknown) {
			// A print from internal storage has no scheduled retrieval; look it up
			// by name once more, as after the run.
			facts, internal, factsErr := r.store.InternalStorageRunFacts(ctx, command.AssignmentID, command.RunID, kind)
			if factsErr != nil {
				return factsErr
			}
			if !internal || !isBambuArchivePath(facts.ArchiveCandidate) {
				return r.failCommand(ctx, command, commandReasonPathUnknown)
			}
			err = r.store.ScheduleArtifactRetrieval(
				ctx,
				command.AssignmentID,
				command.RunID,
				configurationVersion,
				facts.ArchiveCandidate,
				time.Now().UTC().Add(refetchRetrievalWindow),
			)
		}
		if err != nil {
			return err
		}
	case "recompute_consumption":
		state, found, err := r.store.BambuStateFor(ctx, command.AssignmentID, kind)
		if err != nil {
			return err
		}
		if facts, ok := state.RunFacts[command.RunID.String()]; !found || !ok || facts.Outcome == "" {
			return r.failCommand(ctx, command, commandReasonRunFactsUnavailable)
		}
		staged, err := r.store.StagedArtifactForRun(ctx, command.AssignmentID, command.RunID)
		if err != nil {
			return err
		}
		if staged == nil {
			if err = r.stageArtifactFromCore(ctx, identity, command, configurationVersion); err != nil {
				r.logFailure("artifact download for recompute failed", err)
				return r.failCommand(ctx, command, commandReasonDownloadFailed)
			}
		}
		if err = r.store.PrepareConsumptionRecompute(ctx, command.AssignmentID, command.RunID); err != nil {
			return err
		}
	default:
		return r.failCommand(ctx, command, commandReasonUnsupported)
	}
	return r.store.SetRunCommandState(ctx, command.ID, commandRunning, nil)
}

// stageArtifactFromCore downloads the run's stored 3MF and stages it as already
// acknowledged, so the adapter recalculates it without uploading it again.
func (r *Runtime) stageArtifactFromCore(
	ctx context.Context,
	identity Identity,
	command RunCommand,
	configurationVersion int64,
) error {
	directory := filepath.Join(r.store.dataDir, "artifacts")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".download-*.3mf")
	if err != nil {
		return err
	}
	path := temporary.Name()
	defer func() { _ = os.Remove(path) }()
	err = r.client.DownloadRunArtifact(ctx, identity.CredentialSecret, command.AssignmentID, command.RunID, temporary, maxStagedArtifact)
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	reader, err := os.Open(path) //nolint:gosec // temporary file created by this process in the connector data directory
	if err != nil {
		return err
	}
	defer func() { _ = reader.Close() }()
	transfer, err := r.store.StageArtifact(
		ctx,
		command.AssignmentID,
		command.RunID,
		configurationVersion,
		"core:"+command.RunID.String(),
		command.RunID.String()+".3mf",
		reader,
		time.Now().UTC().Add(24*time.Hour),
	)
	if err != nil {
		return err
	}
	return r.store.MarkArtifactAcknowledged(ctx, transfer.ID)
}

func (r *Runtime) checkCommand(ctx context.Context, command RunCommand) error {
	switch command.Kind {
	case "refetch_artifact":
		state, reason, found, err := r.store.ArtifactRetrievalState(ctx, command.AssignmentID, command.RunID)
		if err != nil || !found {
			return err
		}
		switch state {
		case "staged":
			settled, err := r.store.RunArtifactUploadSettled(ctx, command.AssignmentID, command.RunID)
			if err != nil || !settled {
				return err
			}
			return r.store.SetRunCommandState(ctx, command.ID, commandSucceeded, nil)
		case "quarantined":
			last := ""
			if reason != nil {
				last = *reason
			}
			failure := artifactProblemReason(last)
			if _, internal, factsErr := r.store.InternalStorageRunFacts(
				ctx, command.AssignmentID, command.RunID, r.adapterKindOf(command.AssignmentID),
			); factsErr == nil && internal && failure == machineArtifactNotFound {
				failure = machineArtifactOnInternal
			}
			return r.failCommand(ctx, command, string(failure))
		}
	case "recompute_consumption":
		done, err := r.store.ConsumptionReportedSince(ctx, command.AssignmentID, command.RunID, command.AcceptedAt)
		if err != nil || !done {
			return err
		}
		return r.store.SetRunCommandState(ctx, command.ID, commandSucceeded, nil)
	}
	return nil
}

// deliverRunReports sends changed run reports. Core answers 404 for runs it
// deleted and 422 for reports it cannot accept; neither heals, so they are dropped.
func (r *Runtime) deliverRunReports(ctx context.Context, identity Identity) error {
	if r.RecordingFeatures() == nil {
		return nil
	}
	if err := r.store.PruneRunReports(ctx); err != nil {
		return err
	}
	reports, err := r.store.PendingRunReports(ctx, 20)
	if err != nil {
		return err
	}
	for _, report := range reports {
		err = r.client.PutRunReport(ctx, identity.CredentialSecret, report)
		if err != nil && !isFinalCoreAnswer(err, http.StatusNotFound, http.StatusUnprocessableEntity) {
			if deferErr := r.store.DeferRunReport(ctx, report); deferErr != nil {
				return deferErr
			}
			return err
		}
		if err = r.store.MarkRunReportDelivered(ctx, report); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) deliverTimelapses(ctx context.Context, identity Identity) error {
	uploads, err := r.store.StagedTimelapses(ctx, 1)
	if err != nil {
		return err
	}
	for _, upload := range uploads {
		_, uploadErr := r.client.UploadTimelapse(ctx, identity.CredentialSecret, upload.TimelapseUpload)
		if uploadErr == nil {
			if err = r.store.FinishTimelapseUpload(ctx, upload.TimelapseUpload, timelapseDone, nil); err != nil {
				return err
			}
			if err = r.store.SetRunTimelapseReport(ctx, upload.AssignmentID, upload.RunID, timelapseReportUploaded, nil, nil); err != nil {
				return err
			}
			continue
		}
		if err = r.timelapseUploadFailed(ctx, upload, uploadErr); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) timelapseUploadFailed(ctx context.Context, upload stagedTimelapseUpload, uploadErr error) error {
	giveUp := func(state, reason string, detail *string) error {
		if err := r.store.FinishTimelapseUpload(ctx, upload.TimelapseUpload, timelapseGaveUp, &reason); err != nil {
			return err
		}
		return r.store.SetRunTimelapseReport(ctx, upload.AssignmentID, upload.RunID, state, &reason, detail)
	}
	var coreErr *CoreError
	if errors.As(uploadErr, &coreErr) {
		code := coreErr.Code
		var detail *string
		if reasonCodePattern.MatchString(code) {
			detail = &code
		}
		switch {
		case coreErr.Status == http.StatusConflict && code == "run_timelapse_exists":
			if err := r.store.FinishTimelapseUpload(ctx, upload.TimelapseUpload, timelapseDone, nil); err != nil {
				return err
			}
			return r.store.SetRunTimelapseReport(ctx, upload.AssignmentID, upload.RunID, timelapseReportUploaded, nil, nil)
		case coreErr.Status == http.StatusConflict && code == "timelapse_disabled":
			return giveUp(timelapseReportSkipped, reasonTimelapseDisabled, nil)
		case coreErr.Status == http.StatusRequestEntityTooLarge:
			return giveUp(timelapseReportFailed, reasonTimelapseTooLarge, nil)
		case coreErr.Status == http.StatusNotFound:
			// The run was deleted or the assignment ended; nobody can see a report.
			return r.store.FinishTimelapseUpload(ctx, upload.TimelapseUpload, timelapseGaveUp, &code)
		case coreErr.Status == http.StatusUnprocessableEntity:
			return giveUp(timelapseReportFailed, reasonTimelapseUploadFailed, detail)
		}
	}
	diagnostic := classifyAdapterError(uploadErr)
	if upload.AttemptCount+1 >= maxTimelapseAttempts {
		return giveUp(timelapseReportFailed, reasonTimelapseUploadFailed, &diagnostic)
	}
	r.logFailure("timelapse upload failed", fmt.Errorf("deferred: %w", uploadErr))
	return r.store.DeferTimelapseUpload(ctx, upload, diagnostic)
}

// isFinalCoreAnswer is true when Core answered with one of statuses, which a retry cannot change.
func isFinalCoreAnswer(err error, statuses ...int) bool {
	var coreErr *CoreError
	if !errors.As(err, &coreErr) {
		return false
	}
	for _, status := range statuses {
		if coreErr.Status == status {
			return true
		}
	}
	return false
}

// adapterKindOf is the running adapter kind of an assignment; empty when it is not running.
func (r *Runtime) adapterKindOf(assignmentID uuid.UUID) AdapterKind {
	kind, _, _ := r.assignmentAdapter(assignmentID)
	return kind
}
