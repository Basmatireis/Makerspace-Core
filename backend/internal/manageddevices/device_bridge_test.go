package manageddevices

import (
	"slices"
	"testing"

	"github.com/google/uuid"
)

func TestValidateDeviceSettingsRequiresExplicitUniqueModes(t *testing.T) {
	all := AllKioskMethods
	tests := []struct {
		name     string
		settings DeviceSettings
		wantErr  bool
	}{
		{name: "private default", settings: DeviceSettings{CheckInMethods: all, CheckOutMethods: all}, wantErr: false},
		{
			name: "kiosk modes",
			settings: DeviceSettings{
				KioskEnabled:            true,
				SessionPolicyID:         uuidPointer(),
				AllowedApplicationModes: []ApplicationMode{"visitor_terminal", "staff_ui"},
				CheckInMethods:          all,
				CheckOutMethods:         all,
			},
			wantErr: false,
		},
		{
			name: "kiosk lacks visitor mode",
			settings: DeviceSettings{
				KioskEnabled:            true,
				SessionPolicyID:         uuidPointer(),
				AllowedApplicationModes: []ApplicationMode{"staff_ui"},
			},
			wantErr: true,
		},
		{
			name:     "duplicate",
			settings: DeviceSettings{AllowedApplicationModes: []ApplicationMode{"staff_ui", "staff_ui"}},
			wantErr:  true,
		},
		{name: "unknown", settings: DeviceSettings{AllowedApplicationModes: []ApplicationMode{"maintenance"}}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := validateDeviceSettings(test.settings)
			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestValidateDeviceSettingsKeepsAKioskMethodForEachWay(t *testing.T) {
	tests := []struct {
		name              string
		checkIn, checkOut []KioskMethod
		tap               bool
		wantErr           bool
		wantIn, wantOut   []KioskMethod
	}{
		{
			name:    "any combination, stored in the kiosk's order",
			checkIn: []KioskMethod{KioskMethodPassword, KioskMethodEmailCode}, checkOut: []KioskMethod{KioskMethodPIN},
			wantIn: []KioskMethod{KioskMethodEmailCode, KioskMethodPassword}, wantOut: []KioskMethod{KioskMethodPIN},
		},
		{name: "check-in needs a method", checkIn: nil, checkOut: AllKioskMethods, tap: true, wantErr: true},
		{name: "check-out needs a method without tap", checkIn: AllKioskMethods, checkOut: nil, wantErr: true},
		{
			name:    "tap alone may check out",
			checkIn: []KioskMethod{KioskMethodEmailCode}, checkOut: nil, tap: true,
			wantIn: []KioskMethod{KioskMethodEmailCode}, wantOut: []KioskMethod{},
		},
		{name: "unknown method", checkIn: []KioskMethod{"oidc"}, checkOut: AllKioskMethods, wantErr: true},
		{
			name: "repeated method", checkIn: []KioskMethod{KioskMethodPIN, KioskMethodPIN}, checkOut: AllKioskMethods,
			wantErr: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := validateDeviceSettings(DeviceSettings{
				CheckInMethods: test.checkIn, CheckOutMethods: test.checkOut, AllowTapCheckout: test.tap,
			})
			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, test.wantErr)
			}
			if err == nil && (!slices.Equal(got.CheckInMethods, test.wantIn) || !slices.Equal(got.CheckOutMethods, test.wantOut)) {
				t.Fatalf("methods = %v / %v, want %v / %v", got.CheckInMethods, got.CheckOutMethods, test.wantIn, test.wantOut)
			}
		})
	}
}

func uuidPointer() *uuid.UUID {
	value := uuid.MustParse("0192f6f8-743e-7c77-a349-cd07c3e8a920")
	return &value
}

func TestIntersectCapabilitiesHonorsServerConfiguration(t *testing.T) {
	actual := intersectCapabilities([]string{"nfc", "camera"}, []string{"nfc", "scale"})
	if len(actual) != 1 || actual[0] != "nfc" {
		t.Fatalf("intersection = %v", actual)
	}
}

func TestFileUploadIsEffectiveWithoutAHardwareReport(t *testing.T) {
	if err := validateCapabilities([]string{"camera", CapabilityFileUpload}); err != nil {
		t.Fatalf("file_upload must be a valid configured capability: %v", err)
	}
	actual := intersectCapabilities([]string{"camera", CapabilityFileUpload}, []string{"nfc"})
	if len(actual) != 1 || actual[0] != CapabilityFileUpload {
		t.Fatalf("effective capabilities=%v, want only file_upload", actual)
	}
	if actual := intersectCapabilities([]string{"camera"}, []string{CapabilityFileUpload}); len(actual) != 0 {
		t.Fatalf("a reported file_upload must not enable an unconfigured one: %v", actual)
	}
}
