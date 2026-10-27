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

// CheckoutMode is how a visitor kiosk checks visitors out.
type CheckoutMode string

const (
	CheckoutVerified  CheckoutMode = "verified"
	CheckoutPublicTap CheckoutMode = "public_tap"
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
	PlatformAndroid Platform = "android"
)
