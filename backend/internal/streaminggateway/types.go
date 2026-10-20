package streaminggateway

// HealthState is the overall health the gateway reports to Core.
type HealthState string

const (
	HealthConnected HealthState = "connected"
	HealthDegraded  HealthState = "degraded"
)

// CameraStatus is the health of one camera stream.
type CameraStatus string

const (
	CameraLive        CameraStatus = "live"
	CameraIdle        CameraStatus = "idle"
	CameraUnavailable CameraStatus = "unavailable"
)

// LogLevel is go2rtc's log level.
type LogLevel string

const (
	LogLevelError LogLevel = "error"
	LogLevelFatal LogLevel = "fatal"
)

// TLSState is where the gateway's TLS certificate comes from and whether it is usable.
type TLSState string

const (
	TLSFiles   TLSState = "files"
	TLSWaiting TLSState = "waiting"
	TLSReady   TLSState = "ready"
)
