package streaminggateways

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/optional"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/streaminggateways/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// BuildSourceURL builds the go2rtc source of a Bambu printer camera. The rtspx scheme is go2rtc's
// RTSPS without certificate verification, which Bambu's self-signed printer certificate needs.
// Verify the path and port on real hardware; see docs/streaming-gateway.md.
func BuildSourceURL(ip, accessCode string) string {
	source := url.URL{
		Scheme: "rtspx",
		User:   url.UserPassword("bblp", accessCode),
		Host:   ip + ":322",
		Path:   "/streaming/live/1",
	}
	return source.String()
}

// Configuration returns the complete configuration of an authenticated gateway.
func (s *Service) Configuration(ctx context.Context, gateway Context) (Configuration, error) {
	if gateway.Lifecycle != LifecycleActive && gateway.Lifecycle != LifecycleDisabled {
		return Configuration{}, apperror.New(
			http.StatusForbidden,
			"streaming_gateway_inactive",
			"Gateway is not active",
		)
	}
	q := db.New(s.pool)
	row, err := q.GetGateway(ctx, gateway.ID)
	if err != nil {
		return Configuration{}, err
	}
	keys, err := s.PublicKeys(ctx)
	if err != nil {
		return Configuration{}, err
	}
	epoch, err := q.GetSessionEpoch(ctx)
	if err != nil {
		return Configuration{}, err
	}
	revoked, err := q.ListRevokedDisplayIDs(ctx, s.now().Add(-24*time.Hour))
	if err != nil {
		return Configuration{}, err
	}
	result := Configuration{
		SessionEpoch:     epoch,
		RevokedDisplays:  revoked,
		Revision:         row.ConfigurationRevision,
		ProtocolVersion:  ProtocolVersion,
		PublicHost:       row.PublicHost,
		TicketPublicKeys: keys,
		Cameras:          []ConfigCamera{},
	}
	if gateway.Lifecycle == LifecycleDisabled {
		return result, nil
	}
	cameras, err := q.ListGatewayConfigCameras(ctx, gateway.ID)
	if err != nil {
		return Configuration{}, err
	}
	for _, camera := range cameras {
		var settings struct {
			IPAddress string `json:"ipAddress"`
		}
		if json.Unmarshal(camera.Settings, &settings) != nil {
			continue
		}
		addr, parseErr := netip.ParseAddr(strings.TrimSpace(settings.IPAddress))
		if parseErr != nil || !addr.Is4() {
			continue
		}
		var secrets map[string]string
		if len(camera.EncryptedSecrets) == 0 {
			continue
		}
		if s.keyring == nil {
			return Configuration{}, apperror.Conflicting(
				"encryption_not_configured",
				"Printer credentials cannot be decrypted",
			)
		}
		plain, decryptErr := s.keyring.Decrypt(
			camera.EncryptedSecrets,
			"printer-connector-assignment:"+camera.AssignmentID.String(),
		)
		if decryptErr != nil {
			return Configuration{}, decryptErr
		}
		if json.Unmarshal(plain, &secrets) != nil || secrets["lanAccessCode"] == "" {
			continue
		}
		result.Cameras = append(
			result.Cameras,
			ConfigCamera{
				MachineID:  camera.MachineID,
				Name:       camera.MachineName,
				StreamName: StreamName(camera.MachineID),
				SourceURL:  BuildSourceURL(addr.String(), secrets["lanAccessCode"]),
			},
		)
	}
	return result, nil
}

func plainText(value string, maxRunes int) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > maxRunes {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// Heartbeat records gateway and camera health. Camera health is ephemeral and not audited.
func (s *Service) Heartbeat(ctx context.Context, gateway Context, input Heartbeat) (Gateway, error) {
	if gateway.Lifecycle != LifecycleActive {
		return Gateway{}, apperror.New(http.StatusForbidden, "streaming_gateway_inactive", "Gateway is not active")
	}
	input.SoftwareVersion = strings.TrimSpace(input.SoftwareVersion)
	if input.SoftwareVersion == "" || !plainText(input.SoftwareVersion, 80) ||
		input.ProtocolVersion != ProtocolVersion ||
		(input.HealthState != HealthConnected && input.HealthState != HealthDegraded) ||
		input.AppliedConfigurationRevision < 0 ||
		len(input.Cameras) > 100 {
		return Gateway{}, apperror.Invalid("invalid heartbeat")
	}
	if input.HealthSummary != nil && !plainText(*input.HealthSummary, 500) {
		return Gateway{}, apperror.Invalid("invalid heartbeat")
	}
	for _, camera := range input.Cameras {
		if (camera.Health != CameraLive && camera.Health != CameraIdle && camera.Health != CameraUnavailable) ||
			camera.Viewers < 0 ||
			camera.Viewers > 100000 ||
			(camera.Codec != nil && (*camera.Codec == "" || !plainText(*camera.Codec, 40))) ||
			(camera.Width != nil && (*camera.Width < 1 || *camera.Width > 16384)) ||
			(camera.Height != nil && (*camera.Height < 1 || *camera.Height > 16384)) ||
			(camera.FPS != nil && (*camera.FPS < 0 || *camera.FPS > 1000)) {
			return Gateway{}, apperror.Invalid("invalid camera health")
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Gateway{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	protocol := int32(input.ProtocolVersion)
	row, err := q.RecordGatewayHeartbeat(
		ctx,
		db.RecordGatewayHeartbeatParams{
			SoftwareVersion:              &input.SoftwareVersion,
			ProtocolVersion:              &protocol,
			AppliedConfigurationRevision: input.AppliedConfigurationRevision,
			HealthState:                  optional.Of(string(input.HealthState)),
			HealthSummary:                input.HealthSummary,
			ID:                           gateway.ID,
		},
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Gateway{}, apperror.New(http.StatusForbidden, "streaming_gateway_inactive", "Gateway is not active")
	}
	if err != nil {
		return Gateway{}, err
	}
	assigned, err := q.ListGatewayCameraMachines(ctx, gateway.ID)
	if err != nil {
		return Gateway{}, err
	}
	byMachine := make(map[uuid.UUID]uuid.UUID, len(assigned))
	for _, camera := range assigned {
		byMachine[camera.MachineID] = camera.ID
	}
	if err = q.DeleteCameraStatesOfGateway(ctx, gateway.ID); err != nil {
		return Gateway{}, err
	}
	for _, camera := range input.Cameras {
		cameraID, ok := byMachine[camera.MachineID]
		if !ok {
			continue
		}
		var width, height *int32
		if camera.Width != nil {
			v := int32(*camera.Width)
			width = &v
		}
		if camera.Height != nil {
			v := int32(*camera.Height)
			height = &v
		}
		if err = q.UpsertCameraState(
			ctx,
			db.UpsertCameraStateParams{
				CameraID: cameraID,
				Health:   string(camera.Health),
				Viewers:  int32(camera.Viewers),
				Codec:    camera.Codec,
				Width:    width,
				Height:   height,
				Fps:      camera.FPS,
			},
		); err != nil {
			return Gateway{}, err
		}
	}
	result, err := withCredentialExpiry(ctx, q, gatewayFrom(row))
	if err != nil {
		return Gateway{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Gateway{}, err
	}
	return result, nil
}
