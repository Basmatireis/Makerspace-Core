package runrecordings

import (
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/google/uuid"
)

// CommandKind is what a run command asks the connector to do.
type CommandKind string

const (
	CommandRefetchArtifact      CommandKind = "refetch_artifact"
	CommandRecomputeConsumption CommandKind = "recompute_consumption"
)

// CommandState is the lifecycle of a run command.
type CommandState string

const (
	CommandRequested CommandState = "requested"
	CommandRunning   CommandState = "running"
	CommandSucceeded CommandState = "succeeded"
	CommandFailed    CommandState = "failed"
)

// TimelapseState is what the run view says about the run's timelapse.
type TimelapseState string

const (
	TimelapseAvailable TimelapseState = "available"
	TimelapsePending   TimelapseState = "pending"
	TimelapseNotFound  TimelapseState = "not_found"
	TimelapseFailed    TimelapseState = "failed"
	TimelapseSkipped   TimelapseState = "skipped"
	TimelapseExpired   TimelapseState = "expired"
)

// Limits of the command mechanism.
const (
	// CommandsPerRunWindow commands may be requested per run within CommandRateWindow.
	CommandsPerRunWindow = 5
	CommandRateWindow    = time.Hour
	// CommandPollFreshness is how recently a connector must have polled commands to receive new ones.
	CommandPollFreshness = 5 * time.Minute
	// CommandPickupTimeout fails a requested command the connector did not start.
	CommandPickupTimeout = 15 * time.Minute
	// CommandRunTimeout fails a command that runs for longer.
	CommandRunTimeout = time.Hour
	// MaintenanceInterval is how often the API process expires commands, applies the timelapse
	// retention and deletes queued storage blobs.
	MaintenanceInterval = 5 * time.Minute
	// TimelapseContentType is the only video type connectors deliver.
	TimelapseContentType = "video/mp4"
)

// RecomputeOutcome says what happens to a run's consumption after staff attached its 3MF.
type RecomputeOutcome string

const (
	// RecomputeRequested: Core queued a recompute command for the run's connector.
	RecomputeRequested RecomputeOutcome = "requested"
	// RecomputeAlreadyRequested: a recompute command of the run was already open.
	RecomputeAlreadyRequested RecomputeOutcome = "already_requested"
	// RecomputeNotNeeded: the run still runs; the connector uses the file when it ends.
	RecomputeNotNeeded RecomputeOutcome = "not_needed"
	// RecomputeUnavailable: the run ended but no connector can take the command (gone, too old, rate limited).
	RecomputeUnavailable RecomputeOutcome = "unavailable"
)

// Command is one run command.
type Command struct {
	ID, RunID             uuid.UUID
	AssignmentID          *uuid.UUID
	Kind                  CommandKind
	State                 CommandState
	ReasonCode            *string
	RequestedAt           time.Time
	StartedAt, FinishedAt *time.Time
}

// ArtifactFile is the stored 3MF of a run.
type ArtifactFile struct {
	ID               uuid.UUID
	OriginalFilename string
	SizeBytes        int64
	SHA256           string
	ParserStatus     string
	// UploadedManually is true when staff uploaded the file; the connector did not retrieve it.
	UploadedManually bool
}

// Preview is an image embedded in a run's 3MF.
type Preview struct {
	ID            uuid.UUID
	Role          string
	PlateNumber   *int
	Width, Height int
	MIMEType      string
	Primary       bool
}

// Timelapse is a stored timelapse video.
type Timelapse struct {
	SizeBytes int64
	CreatedAt time.Time
	ExpiresAt *time.Time
}

// TimelapseStatus explains the timelapse of a recorded run.
type TimelapseStatus struct {
	State          TimelapseState
	Reason, Detail *string
}

// Recording is everything the run and job pages show about a run's files.
type Recording struct {
	RunID             uuid.UUID
	RunDisplayID      string
	Source            machinelogbook.RunSource
	State             machinelogbook.RunState
	StartedAt         time.Time
	ConsumptionStatus *machinelogbook.ConsumptionStatus
	Artifact          *ArtifactFile
	Previews          []Preview
	Timelapse         *Timelapse
	TimelapseStatus   *TimelapseStatus
	Commands          []Command
}

// Settings are the installation's recording settings.
type Settings struct {
	TimelapseEnabled       bool
	TimelapseRetentionDays int
	Version                int64
	UpdatedAt              time.Time
}

// SettingsInput changes the recording settings.
type SettingsInput struct {
	TimelapseEnabled       bool
	TimelapseRetentionDays int
	ExpectedVersion        int64
}

// RunReportSection is one section of a connector's run report.
type RunReportSection struct {
	State          string
	Reason, Detail *string
}

// RunReport is what a connector reports about a run besides events.
type RunReport struct {
	ProtocolVersion        int
	ObservedAt             time.Time
	Consumption, Timelapse *RunReportSection
}

// TimelapseUpload describes a streamed timelapse video.
type TimelapseUpload struct {
	AssignmentID, RunID uuid.UUID
	FileName, SHA256    string
	ContentLength       int64
}

// TimelapseUploadResult is the receipt of a timelapse upload.
type TimelapseUploadResult struct {
	RunID     uuid.UUID
	Created   bool
	SizeBytes int64
}

// FileContent is an opened private file for download.
type FileContent struct {
	FileName    string
	ContentType string
	SizeBytes   int64
	SHA256      string
}
