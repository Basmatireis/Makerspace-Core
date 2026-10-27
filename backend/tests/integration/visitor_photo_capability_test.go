package integration_test

import (
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/admin"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/visitor"
	"github.com/google/uuid"
)

// The profile photo is required exactly when the enrolling device can take or upload one.
func TestVisitorEnrollmentPhotoFollowsDeviceCapabilities(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)

	masterAccountID, err := admin.NewService(pool).BootstrapMaster(ctx, admin.BootstrapInput{
		FirstName: "Photo", LastName: "Administrator", LoginEmail: "photo-admin-login@example.test", Password: bootstrapPassword,
	})
	if err != nil {
		t.Fatal(err)
	}
	var masterPersonID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT person_id FROM accounts WHERE id=$1`, masterAccountID).Scan(&masterPersonID); err != nil {
		t.Fatal(err)
	}
	master := authorization.Principal{
		AccountID: masterAccountID, PersonID: masterPersonID, Master: true,
		Assurance: authorization.AssuranceNormal, AuthenticatedAt: time.Now().UTC(),
	}
	roleID := ids.New()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO roles (id,name,laborordnung_mode,profile_image_required) VALUES ($1,'Visitor','blocking',true)`,
		roleID,
	); err != nil {
		t.Fatal(err)
	}
	insertPublishedLabRulesVersion(t, pool, masterAccountID, "2026-photo")

	deviceService := manageddevices.NewService(pool)
	deviceType, err := deviceService.CreateType(ctx, master, "Photo terminal", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	localStore, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fileService := files.NewService(pool, localStore)
	service := visitor.NewService(
		pool, cfg, fileService, laborordnung.NewService(pool, inbox.NewEmitter(), fileService), newNotificationRecorder(),
	)
	if _, err := service.UpdateConfiguration(ctx, master, visitor.ConfigurationInput{
		Enabled: true, InitialRoleID: &roleID, DeviceTypeIDs: []uuid.UUID{deviceType.ID},
		AllowedMethods: []visitor.AuthMethod{"pin"}, ExpectedVersion: 1,
	}, nil); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name         string
		configured   []string
		reported     []string // nil: the device never reported hardware
		wantRequired bool
		wantEffect   []string
	}{
		{name: "no capabilities", configured: nil, wantRequired: false, wantEffect: []string{}},
		{name: "camera", configured: []string{"camera"}, wantRequired: true, wantEffect: []string{"camera"}},
		{name: "file upload", configured: []string{"file_upload"}, wantRequired: true, wantEffect: []string{"file_upload"}},
		{
			name: "camera configured but not reported by the native client", configured: []string{"camera", "file_upload"},
			reported: []string{"nfc"}, wantRequired: true, wantEffect: []string{"file_upload"},
		},
		{
			name: "camera configured but nothing reported", configured: []string{"camera"}, reported: []string{"nfc"},
			wantRequired: false, wantEffect: []string{},
		},
	}
	for index, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			device, err := deviceService.Create(ctx, master, "Photo kiosk "+string(rune('A'+index)), deviceType.ID, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			for _, capability := range tc.configured {
				if _, err := pool.Exec(
					ctx,
					`INSERT INTO managed_device_capabilities (managed_device_id, capability) VALUES ($1,$2)`,
					device.Device.ID, capability,
				); err != nil {
					t.Fatal(err)
				}
			}
			if tc.reported != nil {
				if _, err := pool.Exec(
					ctx,
					`INSERT INTO managed_device_hardware_reports (managed_device_id, platform, bridge_version) VALUES ($1,'android','1')`,
					device.Device.ID,
				); err != nil {
					t.Fatal(err)
				}
				for _, capability := range tc.reported {
					if _, err := pool.Exec(
						ctx,
						`INSERT INTO managed_device_reported_capabilities (managed_device_id, capability) VALUES ($1,$2)`,
						device.Device.ID, capability,
					); err != nil {
						t.Fatal(err)
					}
				}
			}
			effective, err := deviceService.EffectiveCapabilities(ctx, device.Device.ID)
			if err != nil || len(effective) != len(tc.wantEffect) {
				t.Fatalf("effective capabilities=%v err=%v want %v", effective, err, tc.wantEffect)
			}
			if visitor.PhotoRequired(effective) != tc.wantRequired {
				t.Fatalf("PhotoRequired(%v)=%v", effective, !tc.wantRequired)
			}

			begin := func() visitor.Context {
				issue, err := service.Begin(ctx, manageddevices.DeviceContext{
					ID: device.Device.ID, Name: device.Device.Name, DeviceTypeID: device.Device.DeviceTypeID,
				})
				if err != nil {
					t.Fatal(err)
				}
				enrollment, err := service.AuthenticateContext(ctx, issue.ContextToken)
				if err != nil {
					t.Fatal(err)
				}
				return enrollment
			}
			submit := func(enrollment visitor.Context, loginName string, image []byte) error {
				email, pin := loginName+"@example.test", "654321"
				_, err := service.Submit(ctx, enrollment, visitor.SubmissionInput{
					FirstName: "Photo", LastName: "Visitor", Email: &email, AuthMethods: []visitor.AuthMethod{"pin"},
					PINLoginName: &loginName, PIN: &pin, ProfileImage: image, RequestConfirmation: true,
				}, nil)
				return err
			}

			state, err := service.State(ctx, begin())
			if err != nil || len(state.Capabilities) != len(tc.wantEffect) {
				t.Fatalf("state capabilities=%v err=%v", state.Capabilities, err)
			}
			err = submit(begin(), "nophoto.visitor"+string(rune('a'+index)), nil)
			if tc.wantRequired && !apperror.IsCode(err, "validation_failed") {
				t.Fatalf("photo-less enrollment must be rejected, error=%v", err)
			}
			if !tc.wantRequired && err != nil {
				t.Fatalf("photo-less enrollment must be accepted: %v", err)
			}
			if err := submit(begin(), "withphoto.visitor"+string(rune('a'+index)), visitorTestJPEG(t)); err != nil {
				t.Fatalf("enrollment with a photo must be accepted: %v", err)
			}
		})
	}
}
