package manageddevices

import (
	"testing"

	"github.com/google/uuid"
)

func TestValidateDeviceSettingsRequiresExplicitUniqueModes(t *testing.T) {
	tests := []struct {
		name     string
		settings DeviceSettings
		wantErr  bool
	}{
		{name: "private default", settings: DeviceSettings{}, wantErr: false},
		{
			name: "kiosk modes",
			settings: DeviceSettings{
				KioskEnabled:            true,
				SessionPolicyID:         uuidPointer(),
				AllowedApplicationModes: []ApplicationMode{"visitor_terminal", "staff_ui"},
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
