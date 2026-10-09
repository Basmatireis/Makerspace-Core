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
		{name: "terminal modes", settings: DeviceSettings{TerminalEnabled: true, SessionPolicyID: uuidPointer(), AllowedApplicationModes: []string{"visitor_terminal", "staff_ui"}}, wantErr: false},
		{name: "terminal lacks visitor mode", settings: DeviceSettings{TerminalEnabled: true, SessionPolicyID: uuidPointer(), AllowedApplicationModes: []string{"staff_ui"}}, wantErr: true},
		{name: "duplicate", settings: DeviceSettings{AllowedApplicationModes: []string{"staff_ui", "staff_ui"}}, wantErr: true},
		{name: "unknown", settings: DeviceSettings{AllowedApplicationModes: []string{"maintenance"}}, wantErr: true},
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
