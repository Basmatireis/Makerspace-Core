package manageddevices

import (
	"context"
	"crypto/rand"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	manageddevicesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/security"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// SignagePlayerMode is the only application mode of a digital-signage player device. Such devices
// are created by pairing a signage display, never through the generic managed-device endpoints.
const SignagePlayerMode = "signage_player"

const signageDeviceTypeName = "Signage display"

func isSignagePlayer(modes []string) bool {
	for _, mode := range modes {
		if mode == SignagePlayerMode {
			return true
		}
	}
	return false
}

// IsSignagePlayer reports whether the device carries the signage player mode.
func (d DeviceContext) IsSignagePlayer() bool { return isSignagePlayer(d.AllowedApplicationModes) }

// The functions below run inside the signage service's transaction so that the display and its
// managed device change atomically. They perform no permission check: the caller authorizes.

// CreateSignagePlayerDeviceTx creates the device of a newly paired display. The device gets a
// random token digest nobody can present; IssueSignagePlayerTokenTx replaces it when the player
// collects its credential, so the plaintext token is never stored.
func CreateSignagePlayerDeviceTx(
	ctx context.Context,
	tx pgx.Tx,
	actor authorization.Principal,
	name string,
	requestID *uuid.UUID,
) (uuid.UUID, error) {
	q := manageddevicesdb.New(tx)
	if err := q.EnsureManagedDeviceTypeByName(ctx, manageddevicesdb.EnsureManagedDeviceTypeByNameParams{
		ID: uuid.Must(uuid.NewV7()), Name: signageDeviceTypeName, Description: stringPointer("Managed devices that run a digital-signage player."),
	}); err != nil {
		return uuid.Nil, err
	}
	deviceType, err := q.GetDeviceTypeByName(ctx, signageDeviceTypeName)
	if err != nil {
		return uuid.Nil, err
	}
	unusable := make([]byte, 32)
	if _, err := rand.Read(unusable); err != nil {
		return uuid.Nil, err
	}
	row, err := q.CreateManagedDevice(ctx, manageddevicesdb.CreateManagedDeviceParams{
		ID: uuid.Must(
			uuid.NewV7(),
		), Name: name, DeviceTypeID: deviceType.ID, TokenDigest: security.DigestToken(string(unusable)),
		AllowedAppModes: []string{
			SignagePlayerMode,
		}, CheckInAssurance: "low", CheckOutAssurance: "low", CheckoutMode: "verified",
	})
	if err != nil {
		return uuid.Nil, databaseError(err)
	}
	accountID := actor.AccountID
	if err := audit.Write(ctx, tx, audit.Event{ActorAccountID: &accountID, Action: "managed_device.created", ResourceType: "managed_device", ResourceID: &row.ID, RequestID: requestID, ChangedFields: []string{"name", "deviceTypeId", "allowedApplicationModes"}}); err != nil {
		return uuid.Nil, err
	}
	return row.ID, nil
}

// IssueSignagePlayerTokenTx sets a fresh credential on a paired signage device and returns the
// plaintext token for the single response that hands it to the player.
func IssueSignagePlayerTokenTx(ctx context.Context, tx pgx.Tx, deviceID uuid.UUID) (string, error) {
	token, digest, err := security.NewOpaqueToken()
	if err != nil {
		return "", err
	}
	if _, err := manageddevicesdb.New(tx).SetManagedDeviceTokenDigest(ctx, manageddevicesdb.SetManagedDeviceTokenDigestParams{ID: deviceID, TokenDigest: digest}); errors.Is(
		err,
		pgx.ErrNoRows,
	) {
		return "", apperror.NotFound
	} else if err != nil {
		return "", err
	}
	return token, nil
}

// RevokeSignagePlayerDeviceTx revokes the device (idempotent) and writes the revocation audit event.
func RevokeSignagePlayerDeviceTx(
	ctx context.Context,
	tx pgx.Tx,
	actor authorization.Principal,
	deviceID uuid.UUID,
	requestID *uuid.UUID,
) error {
	q := manageddevicesdb.New(tx)
	current, err := q.GetManagedDeviceForMutation(ctx, deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	if current.RevokedAt.Valid {
		return nil
	}
	if _, err := q.RevokeManagedDevice(ctx, manageddevicesdb.RevokeManagedDeviceParams{ID: deviceID, ExpectedVersion: current.Version}); err != nil {
		return err
	}
	accountID := actor.AccountID
	return audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &accountID,
			Action:         "managed_device.revoked",
			ResourceType:   "managed_device",
			ResourceID:     &deviceID,
			RequestID:      requestID,
			ChangedFields:  []string{"revokedAt"},
		},
	)
}

// DeleteSignagePlayerDeviceTx deletes a revoked device after its display row is gone.
func DeleteSignagePlayerDeviceTx(
	ctx context.Context,
	tx pgx.Tx,
	actor authorization.Principal,
	deviceID uuid.UUID,
	requestID *uuid.UUID,
) error {
	q := manageddevicesdb.New(tx)
	current, err := q.GetManagedDeviceForMutation(ctx, deviceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperror.NotFound
	} else if err != nil {
		return err
	}
	if _, err := q.DeleteManagedDevice(ctx, manageddevicesdb.DeleteManagedDeviceParams{ID: deviceID, ExpectedVersion: current.Version}); err != nil {
		return databaseError(err)
	}
	accountID := actor.AccountID
	return audit.Write(
		ctx,
		tx,
		audit.Event{
			ActorAccountID: &accountID,
			Action:         "managed_device.deleted",
			ResourceType:   "managed_device",
			ResourceID:     &deviceID,
			RequestID:      requestID,
		},
	)
}

func stringPointer(value string) *string { return &value }
