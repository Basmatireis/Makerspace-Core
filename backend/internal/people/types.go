package people

// ProfileImageSource is how a person's profile image was provided.
type ProfileImageSource string

const (
	ImageKioskCapture ProfileImageSource = "terminal_capture"
	ImageSelfUpload   ProfileImageSource = "self_upload"
	ImageAdminUpload  ProfileImageSource = "admin_upload"
)
