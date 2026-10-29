package signage

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MaxStreamsPerDisplay caps the camera streams the live data offers one display.
const MaxStreamsPerDisplay = 20

// CameraGrant is a camera a signage display may watch right now: the machine and the active printer-connector
// assignment that relays its camera.
type CameraGrant struct {
	MachineID, AssignmentID, ConnectorID uuid.UUID
}

func cameraForbidden() error {
	return apperror.New(http.StatusForbidden, "camera_forbidden", "This display may not show this camera")
}

func cameraNotFound() error {
	return apperror.New(http.StatusNotFound, "camera_not_found", "This machine has no streaming camera")
}

// cameraAllowed tells whether a display may show cameras at all: displays that are visible from outside need the
// explicit allowCameraOutside setting.
func cameraAllowed(display PlayerDisplay) bool {
	return !display.VisibleFromOutside || display.AllowCameraOutside
}

// cameraScope is the set of machines whose camera a publication shows; all means every camera.
type cameraScope struct {
	ids []uuid.UUID
	all bool
}

func (c cameraScope) includes(machineID uuid.UUID) bool {
	return c.all || slices.Contains(c.ids, machineID)
}

// publishedCameraScope returns the cameras the display's latest publication shows, without the machines whose
// running run was hidden from signage. ok is false when the display may not show any camera: it was never
// published, or it is visible from outside without allowCameraOutside.
func (s *Service) publishedCameraScope(
	ctx context.Context,
	q *signagedb.Queries,
	display PlayerDisplay,
	now time.Time,
) (scope cameraScope, hidden []uuid.UUID, ok bool, err error) {
	if !cameraAllowed(display) {
		return cameraScope{}, nil, false, nil
	}
	manifest, published, err := s.latestManifest(ctx, q, display.ID)
	if err != nil || !published {
		return cameraScope{}, nil, false, err
	}
	scope.ids, scope.all = ManifestCameraMachineIDs(manifest)
	if !scope.all && len(scope.ids) == 0 {
		return cameraScope{}, nil, false, nil
	}
	// A machine whose running run its operator opted out of signage is not shown, camera included.
	if hidden, err = q.ListSignageHiddenMachineIDs(ctx, now); err != nil {
		return cameraScope{}, nil, false, err
	}
	return scope, hidden, true, nil
}

// displayCameras lists the cameras the display may watch right now, ordered by machine name and capped at
// MaxStreamsPerDisplay. The display must not be revoked; PlayerDisplayFor guarantees that.
func (s *Service) displayCameras(
	ctx context.Context,
	q *signagedb.Queries,
	display PlayerDisplay,
	now time.Time,
) ([]CameraGrant, error) {
	scope, hidden, ok, err := s.publishedCameraScope(ctx, q, display, now)
	if err != nil || !ok {
		return []CameraGrant{}, err
	}
	rows, err := q.ListSignageStreamingCameras(ctx)
	if err != nil {
		return nil, err
	}
	grants := make([]CameraGrant, 0, min(len(rows), MaxStreamsPerDisplay))
	for _, row := range rows {
		if len(grants) == MaxStreamsPerDisplay {
			break
		}
		if scope.includes(row.MachineID) && !slices.Contains(hidden, row.MachineID) {
			grants = append(grants, CameraGrant{
				MachineID:    row.MachineID,
				AssignmentID: row.AssignmentID,
				ConnectorID:  row.ConnectorID,
			})
		}
	}
	return grants, nil
}

// AuthorizeCamera decides whether the signage player device may watch the camera of a machine right now. It is the
// single rule behind the live data's streams, the relay's upgrade and its periodic re-authorization: the device has a
// display that is not revoked, the display may show cameras (allowCameraOutside when visible from outside), its latest
// publication has a camera widget for the machine, no hidden run hides the machine, and an active connector relays the
// machine's camera. The caller has authenticated the device credential. It answers 403 camera_forbidden when the
// display may not watch the machine and 404 camera_not_found when the machine has no streaming camera.
func (s *Service) AuthorizeCamera(ctx context.Context, deviceID, machineID uuid.UUID) (CameraGrant, error) {
	display, err := s.PlayerDisplayFor(ctx, deviceID)
	if errors.Is(err, apperror.NotFound) {
		// A player device without a display may not watch anything.
		return CameraGrant{}, cameraForbidden()
	}
	if err != nil {
		return CameraGrant{}, err
	}
	q := signagedb.New(s.pool)
	scope, hidden, ok, err := s.publishedCameraScope(ctx, q, display, s.now())
	if err != nil {
		return CameraGrant{}, err
	}
	if !ok || !scope.includes(machineID) || slices.Contains(hidden, machineID) {
		return CameraGrant{}, cameraForbidden()
	}
	row, err := q.GetSignageStreamingCamera(ctx, machineID)
	if errors.Is(err, pgx.ErrNoRows) {
		return CameraGrant{}, cameraNotFound()
	}
	if err != nil {
		return CameraGrant{}, err
	}
	return CameraGrant{MachineID: row.MachineID, AssignmentID: row.AssignmentID, ConnectorID: row.ConnectorID}, nil
}
