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

// KioskMethod is a way a person identifies at an entrance kiosk to check in or out.
type KioskMethod string

const (
	KioskMethodEmailCode KioskMethod = "email_code"
	KioskMethodPIN       KioskMethod = "pin"
	KioskMethodPassword  KioskMethod = "password"
)

// AllKioskMethods lists every kiosk method in the order the kiosk offers them; stored sets keep this order.
var AllKioskMethods = []KioskMethod{KioskMethodEmailCode, KioskMethodPIN, KioskMethodPassword}

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
