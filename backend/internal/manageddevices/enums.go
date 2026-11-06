package manageddevices

// ApplicationMode is an application a managed device may run.
type ApplicationMode string

const (
	ModeStaffUI      ApplicationMode = "staff_ui"
	ModeVisitorKiosk ApplicationMode = "visitor_terminal"
	// ModeSignagePlayer is the only application mode of a digital-signage player device. Such devices
	// are created by pairing a signage display, never through the generic managed-device endpoints.
	ModeSignagePlayer ApplicationMode = "signage_player"
)

// Kiosk reset bounds in seconds: how long a tablet may sit idle before it returns to its start screen.
const (
	MinKioskResetSeconds     int32 = 15
	MaxKioskResetSeconds     int32 = 600
	DefaultKioskResetSeconds int32 = 60
)

// Destination is where a session policy sends the browser after a session ends.
type Destination string

const (
	DestinationLogin        Destination = "login"
	DestinationVisitorKiosk Destination = "visitor_terminal"
)

// Platform is the platform a device bridge runs on.
type Platform string

const (
	PlatformDesktop Platform = "desktop"
)
