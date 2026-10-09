package devicebridge

import "errors"

var (
	ErrInvalidUID            = errors.New("NFC UID must contain 1 to 32 bytes of hexadecimal data")
	ErrCapabilityUnsupported = errors.New("capability is unsupported")
)
