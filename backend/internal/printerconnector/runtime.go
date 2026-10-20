package printerconnector

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/google/uuid"
)

var Version = "dev"

type Runtime struct {
	store      *Store
	client     *Client
	dataDir    string
	enrollment Enrollment
	logger     *slog.Logger
	mu         sync.Mutex
	adapters   map[uuid.UUID]context.CancelFunc
	health     map[uuid.UUID]AssignmentHealth
	revision   int64
	live       *liveStatusHub

	now             func() time.Time
	lastRejectedLog time.Time
}

// Configuration and heartbeat are polled every 10 seconds so a change in Core
// reaches the printer quickly; a newer revision in a heartbeat answer is
// fetched immediately.
const configurationInterval = 10 * time.Second
const heartbeatInterval = 10 * time.Second

// Enrollment is where the one-time enrollment secret comes from: Secret is the value of
// CONNECTOR_ENROLLMENT_SECRET; File is the legacy CONNECTOR_ENROLLMENT_SECRET_FILE, used only when
// Secret is empty. Both are ignored once the connector is enrolled.
type Enrollment struct {
	Secret string
	File   string
}

// Resolve returns the trimmed enrollment secret, or "" when none is configured.
func (e Enrollment) Resolve() (string, error) {
	if secret := strings.TrimSpace(e.Secret); secret != "" {
		return secret, nil
	}
	if e.File == "" {
		return "", nil
	}
	raw, err := os.ReadFile(e.File)
	if err != nil {
		return "", fmt.Errorf("read CONNECTOR_ENROLLMENT_SECRET_FILE: %w", err)
	}
	secret := strings.TrimSpace(string(raw))
	if secret == "" {
		return "", errors.New("CONNECTOR_ENROLLMENT_SECRET_FILE is empty")
	}
	return secret, nil
}

func (e Enrollment) configured() bool { return strings.TrimSpace(e.Secret) != "" || e.File != "" }

func NewRuntime(store *Store, client *Client, dataDir string, enrollment Enrollment, logger *slog.Logger) *Runtime {
	return &Runtime{
		store:      store,
		client:     client,
		dataDir:    dataDir,
		enrollment: enrollment,
		logger:     logger,
		adapters:   map[uuid.UUID]context.CancelFunc{},
		health:     map[uuid.UUID]AssignmentHealth{},
		live:       newLiveStatusHub(),
	}
}

func newSecret() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func (r *Runtime) Run(ctx context.Context) error {
	identity, err := r.ensureIdentity(ctx)
	if err != nil {
		return err
	}
	identity, err = r.rotateCredentialIfNeeded(ctx, identity)
	if err != nil {
		return err
	}
	cached, err := r.store.Configuration(ctx)
	if err != nil {
		return err
	}
	if cached != nil {
		r.apply(ctx, *cached)
	}
	if err = r.writeHealth("healthy"); err != nil {
		return err
	}
	delivery := time.NewTicker(2 * time.Second)
	configuration := time.NewTicker(configurationInterval)
	heartbeat := time.NewTicker(heartbeatInterval)
	liveStatus := time.NewTicker(time.Second)
	defer liveStatus.Stop()
	defer delivery.Stop()
	defer configuration.Stop()
	defer heartbeat.Stop()
	if err = r.syncConfiguration(ctx, identity); err != nil {
		r.logFailure("initial configuration unavailable", err)
	}
	for {
		select {
		case <-ctx.Done():
			r.stopAdapters()
			return nil
		case <-delivery.C:
			if err = r.deliver(ctx, identity); err != nil {
				r.logFailure("event delivery failed", err)
			}
			if err = r.deliverArtifacts(ctx, identity); err != nil {
				r.logFailure("artifact delivery failed", err)
			}
		case <-liveStatus.C:
			r.deliverLiveStatus(ctx, identity)
		case <-configuration.C:
			if identity, err = r.rotateCredentialIfNeeded(ctx, identity); err != nil {
				r.logFailure("credential rotation failed", err)
			}
			if err = r.syncConfiguration(ctx, identity); err != nil {
				r.logFailure("configuration sync failed", err)
			}
		case <-heartbeat.C:
			if err = r.sendHeartbeat(ctx, identity); err != nil {
				r.logFailure("heartbeat failed", err)
			}
		}
	}
}

func (r *Runtime) rotateCredentialIfNeeded(ctx context.Context, identity Identity) (Identity, error) {
	if identity.CredentialExpiresAt.After(time.Now().UTC().Add(7 * 24 * time.Hour)) {
		return identity, nil
	}
	previous := identity
	previousToken := identity.CredentialSecret
	secret, err := newSecret()
	if err != nil {
		return identity, err
	}
	identity.CredentialID = ids.New()
	identity.CredentialSecret = secret
	rotated, err := r.client.RotateCredential(ctx, previousToken, identity)
	if err != nil {
		return previous, err
	}
	if err = r.store.SaveIdentity(ctx, rotated); err != nil {
		return previous, err
	}
	return rotated, nil
}

func (r *Runtime) ensureIdentity(ctx context.Context) (Identity, error) {
	identity, err := r.store.Identity(ctx)
	if err != nil {
		return Identity{}, err
	}
	if identity == nil {
		secret, err := newSecret()
		if err != nil {
			return Identity{}, err
		}
		value := Identity{CredentialID: ids.New(), CredentialSecret: secret}
		if err = r.store.SaveIdentity(ctx, value); err != nil {
			return Identity{}, err
		}
		identity = &value
	}
	if identity.Enrolled {
		return r.reenrollIfNewSecret(ctx, *identity), nil
	}
	enrollment, err := r.enrollment.Resolve()
	if err != nil {
		return Identity{}, err
	}
	if enrollment == "" {
		return Identity{}, errors.New(
			"not enrolled and CONNECTOR_ENROLLMENT_SECRET is not set: in Makerspace Core open Machines > Connectors, create a connector, copy its one-time enrollment secret into CONNECTOR_ENROLLMENT_SECRET in the .env file next to compose.yaml, then start the connector again",
		)
	}
	value, err := r.client.Enroll(ctx, enrollment, *identity, Version)
	if err != nil {
		return Identity{}, err
	}
	value.EnrollmentDigest = enrollmentDigest(enrollment)
	if err = r.store.SaveIdentity(ctx, value); err != nil {
		return Identity{}, err
	}
	return value, nil
}

// reenrollIfNewSecret enrolls again when the configured enrollment secret differs from the one the
// stored identity was enrolled with (or the identity predates that bookkeeping). The stored identity is
// replaced only after Core accepted the new secret; on any failure the connector keeps running with the
// current identity.
func (r *Runtime) reenrollIfNewSecret(ctx context.Context, current Identity) Identity {
	if !r.enrollment.configured() {
		return current
	}
	secret, err := r.enrollment.Resolve()
	if err != nil {
		r.logger.Error("enrollment secret could not be read; keeping the current identity", "error", err.Error())
		return current
	}
	if secret == "" {
		return current
	}
	digest := enrollmentDigest(secret)
	if current.EnrollmentDigest == digest {
		r.logger.Info("already enrolled; CONNECTOR_ENROLLMENT_SECRET is ignored and can be removed")
		return current
	}
	credentialSecret, err := newSecret()
	if err != nil {
		r.logger.Error("re-enrollment skipped; keeping the current identity", "error_type", fmt.Sprintf("%T", err))
		return current
	}
	candidate := Identity{CredentialID: ids.New(), CredentialSecret: credentialSecret}
	enrolled, err := r.client.Enroll(ctx, secret, candidate, Version)
	if err != nil {
		attrs := []any{"reason", enrollmentFailureReason(err)}
		var coreErr *CoreError
		if errors.As(err, &coreErr) {
			attrs = append(attrs, "status", coreErr.Status, "code", safeCode(coreErr.Code))
		}
		r.logger.Error(
			"the new CONNECTOR_ENROLLMENT_SECRET was not accepted by Core; continuing with the previously enrolled identity. Create a new connector or issue a new enrollment secret in Core, update .env and restart",
			attrs...)
		return current
	}
	enrolled.EnrollmentDigest = digest
	if err = r.store.SaveIdentity(ctx, enrolled); err != nil {
		r.logger.Error(
			"re-enrollment succeeded but the new identity could not be saved; keeping the current identity",
			"error_type",
			fmt.Sprintf("%T", err),
		)
		return current
	}
	if err = r.store.ClearConfiguration(ctx); err != nil {
		r.logger.Warn(
			"cached configuration of the previous connector could not be cleared",
			"error_type",
			fmt.Sprintf("%T", err),
		)
	}
	r.logger.Info(
		"enrolled with the new CONNECTOR_ENROLLMENT_SECRET; the previous identity was replaced",
		"connector_id",
		enrolled.ConnectorID.String(),
	)
	return enrolled
}

func (r *Runtime) syncConfiguration(ctx context.Context, identity Identity) error {
	value, err := r.client.Configuration(ctx, identity.CredentialSecret)
	if err != nil {
		return err
	}
	r.mu.Lock()
	unchanged := r.revision == value.Revision
	r.mu.Unlock()
	if unchanged {
		return r.writeHealth("healthy")
	}
	if err = r.store.SaveConfiguration(ctx, value); err != nil {
		return err
	}
	r.apply(ctx, value)
	return r.writeHealth("healthy")
}

func (r *Runtime) apply(parent context.Context, value Configuration) {
	r.stopAdapters()
	r.mu.Lock()
	r.revision = value.Revision
	r.mu.Unlock()
	for _, raw := range value.Assignments {
		if !raw.Enabled {
			continue
		}
		id, err := uuid.Parse(raw.ID)
		if err != nil {
			continue
		}
		var adapter Adapter
		switch raw.AdapterKind {
		case AdapterSimulator:
			if raw.AdapterSchemaVersion != 1 {
				err = fmt.Errorf("unsupported simulator schema version %d", raw.AdapterSchemaVersion)
			} else {
				adapter, err = NewSimulator(raw.Settings)
			}
		case AdapterBambuH2D:
			adapter, err = NewBambuH2D(
				id,
				raw.ConfigurationVersion,
				raw.AdapterSchemaVersion,
				raw.Settings,
				raw.Secrets,
				r.store,
			)
		case AdapterBambuX1C:
			adapter, err = NewBambuX1C(
				id,
				raw.ConfigurationVersion,
				raw.AdapterSchemaVersion,
				raw.Settings,
				raw.Secrets,
				r.store,
			)
		default:
			err = errors.New("unsupported adapter")
		}
		if err != nil {
			code := "invalid_adapter_configuration"
			r.mu.Lock()
			r.health[id] = AssignmentHealth{
				AssignmentID:                raw.ID,
				AppliedConfigurationVersion: 0,
				State:                       HealthDegraded,
				ErrorCode:                   &code,
			}
			r.mu.Unlock()
			continue
		}
		//nolint:gosec // cancel is stored in r.adapters and invoked when the assignment stops or the runtime closes
		ctx, cancel := context.WithCancel(parent)
		r.mu.Lock()
		r.adapters[id] = cancel
		r.health[id] = AssignmentHealth{
			AssignmentID:                raw.ID,
			AppliedConfigurationVersion: raw.ConfigurationVersion,
			State:                       HealthConnected,
		}
		r.mu.Unlock()
		go func(assignmentID uuid.UUID, configVersion int64, adapter Adapter) {
			sink := &runtimeSink{
				store:                r.store,
				live:                 r.live,
				assignmentID:         assignmentID,
				adapterKind:          adapter.Descriptor().Kind,
				configurationVersion: configVersion,
				reportHealth: func(state HealthState, code *string) {
					r.mu.Lock()
					defer r.mu.Unlock()
					r.health[assignmentID] = AssignmentHealth{
						AssignmentID:                assignmentID.String(),
						AppliedConfigurationVersion: configVersion,
						State:                       state,
						ErrorCode:                   code,
					}
				},
			}
			if runErr := adapter.Run(ctx, sink); runErr != nil && !errors.Is(runErr, context.Canceled) {
				r.logger.Warn(
					"adapter stopped",
					"assignment_id",
					assignmentID.String(),
					"error_type",
					fmt.Sprintf("%T", runErr),
				)
				code := classifyAdapterError(runErr)
				r.mu.Lock()
				r.health[assignmentID] = AssignmentHealth{
					AssignmentID:                assignmentID.String(),
					AppliedConfigurationVersion: configVersion,
					State:                       HealthDegraded,
					ErrorCode:                   &code,
				}
				r.mu.Unlock()
			}
		}(id, raw.ConfigurationVersion, adapter)
	}
}

func (r *Runtime) stopAdapters() {
	r.live.Reset()
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, cancel := range r.adapters {
		cancel()
		delete(r.adapters, id)
	}
	r.health = map[uuid.UUID]AssignmentHealth{}
}

type runtimeSink struct {
	store                *Store
	live                 *liveStatusHub
	assignmentID         uuid.UUID
	adapterKind          AdapterKind
	configurationVersion int64
	reportHealth         func(HealthState, *string)
}

func (s *runtimeSink) Commit(ctx context.Context, observation Observation) error {
	if observation.Kind == ObservationConnectivity && s.reportHealth != nil {
		var value struct {
			State     ConnectivityState `json:"state"`
			ErrorCode *string           `json:"errorCode"`
		}
		if json.Unmarshal(observation.Payload, &value) == nil {
			switch value.State {
			case ConnectivityOnline:
				s.reportHealth(HealthConnected, nil)
			case ConnectivityOffline, ConnectivityDegraded:
				s.reportHealth(HealthDegraded, value.ErrorCode)
			}
		}
	}
	_, err := s.store.Enqueue(
		ctx,
		s.assignmentID,
		s.configurationVersion,
		observation.Kind,
		observation.Payload,
		observation.RunID,
		observation.HistoryComplete,
		observation.ExternalPrintID,
		observation.ReportRevision,
	)
	return err
}

// ReportLiveStatus keeps only the newest snapshot; delivery is throttled by the runtime.
func (s *runtimeSink) ReportLiveStatus(snapshot json.RawMessage) {
	if s.live != nil {
		s.live.Report(s.assignmentID, s.configurationVersion, snapshot)
	}
}

func (s *runtimeSink) CommitBambuState(
	ctx context.Context,
	observations []Observation,
	state bambuPersistedState,
) error {
	for _, observation := range observations {
		if observation.Kind == ObservationConnectivity && s.reportHealth != nil {
			var value struct {
				State     ConnectivityState `json:"state"`
				ErrorCode *string           `json:"errorCode"`
			}
			if json.Unmarshal(observation.Payload, &value) == nil {
				switch value.State {
				case ConnectivityOnline:
					s.reportHealth(HealthConnected, nil)
				case ConnectivityOffline, ConnectivityDegraded:
					s.reportHealth(HealthDegraded, value.ErrorCode)
				}
			}
		}
	}
	return s.store.EnqueueBambuStateFor(ctx, s.assignmentID, s.adapterKind, s.configurationVersion, observations, state)
}

func classifyAdapterError(err error) string {
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "serial mismatch"):
		return "tls_serial_mismatch"
	case strings.Contains(message, "expired") || strings.Contains(message, "not yet valid"):
		return "tls_certificate_expired"
	case strings.Contains(message, "unknown authority"):
		return "tls_unknown_ca"
	case strings.Contains(message, "ftps") && (strings.Contains(message, "auth") || strings.Contains(
		message,
		"password",
	) || strings.Contains(message, "login")):
		return "ftps_authentication_failed"
	case strings.Contains(message, "not authorized") || strings.Contains(
		message,
		"bad user name or password",
	) || strings.Contains(message, "bad username or password"):
		return "mqtt_authentication_failed"
	case strings.Contains(message, "mqtt"):
		return "mqtt_unavailable"
	case strings.Contains(message, "queue is full") || strings.Contains(message, "exceeds 2 gib"):
		return "artifact_backlog_full"
	case strings.Contains(message, "ambiguous"):
		return "artifact_ambiguous"
	case strings.Contains(message, "not available"):
		return "artifact_not_available"
	case strings.Contains(message, "negotiate bambu ftps data tls"):
		return "ftps_data_tls_failed"
	case strings.Contains(message, "negotiate bambu ftps control tls"):
		return "ftps_control_tls_failed"
	case strings.Contains(message, "certificate") || strings.Contains(message, "tls"):
		return "tls_certificate_error"
	case strings.Contains(message, "connect bambu ftps data channel"):
		return "ftps_data_connect_failed"
	case strings.Contains(message, "passive") || strings.Contains(message, "pasv"):
		return "ftps_passive_failed"
	case strings.Contains(message, "start bambu ftps transfer"):
		return "ftps_transfer_start_failed"
	case strings.Contains(message, "finish bambu ftps transfer"):
		return "ftps_transfer_finish_failed"
	case strings.Contains(message, "listing") || strings.Contains(message, "list line"):
		return "ftps_listing_failed"
	case strings.Contains(message, "connect to bambu ftps"):
		return "ftps_control_connect_failed"
	case strings.Contains(message, "ftps greeting") || strings.Contains(message, "initialize bambu ftps"):
		return "ftps_protocol_failed"
	case strings.Contains(message, "ftps"):
		return "ftps_unavailable"
	default:
		return "adapter_stopped"
	}
}

func (r *Runtime) deliver(ctx context.Context, identity Identity) error {
	events, err := r.store.Pending(ctx, 20)
	if err != nil || len(events) == 0 {
		return err
	}
	receipts, err := r.client.Send(ctx, identity.CredentialSecret, events)
	if err != nil {
		if queueErr := r.store.MarkDeliveryFailure(ctx, events); queueErr != nil {
			return fmt.Errorf("record delivery failure: %w", queueErr)
		}
		return err
	}
	return r.store.ApplyReceipts(ctx, receipts)
}

// deliverLiveStatus sends due snapshots. Failures are dropped, not queued: the
// next change or keep-alive sends a fresh snapshot. Core answers 404 or 409
// when the assignment ended or its configuration changed; the snapshot is then
// discarded and the restarted adapter reports a new one.
func (r *Runtime) deliverLiveStatus(ctx context.Context, identity Identity) {
	due := r.live.Due(func(id uuid.UUID) bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		return r.health[id].State == HealthConnected
	})
	for _, item := range due {
		err := r.client.PutLiveStatus(
			ctx,
			identity.CredentialSecret,
			item.AssignmentID,
			item.ConfigurationVersion,
			time.Now().UTC(),
			item.Snapshot,
		)
		var coreErr *CoreError
		switch {
		case err == nil:
			r.live.Delivered(item.AssignmentID, item.Snapshot)
		case errors.As(err, &coreErr) && (coreErr.Status == 404 || coreErr.Status == 409):
			r.live.Drop(item.AssignmentID)
		default:
			r.logFailure("live status delivery failed", err)
		}
	}
}

func (r *Runtime) deliverArtifacts(ctx context.Context, identity Identity) error {
	if err := r.store.QuarantineExpiredArtifactTransfers(ctx); err != nil {
		return err
	}
	transfers, err := r.store.PendingArtifactTransfers(ctx, 2)
	if err != nil {
		return err
	}
	for _, transfer := range transfers {
		if _, uploadErr := r.client.UploadArtifact(ctx, identity.CredentialSecret, transfer); uploadErr != nil {
			// 404 and 409 do not heal on retry: the assignment ended, the run
			// is unknown or deleted, or the configuration changed.
			var coreErr *CoreError
			if errors.As(uploadErr, &coreErr) && (coreErr.Status == 404 || coreErr.Status == 409) {
				r.logFailure("artifact rejected by Core; transfer quarantined", uploadErr)
				if queueErr := r.store.QuarantineRejectedArtifactTransfer(ctx, transfer.ID); queueErr != nil {
					return fmt.Errorf("quarantine rejected artifact: %w", queueErr)
				}
				continue
			}
			if queueErr := r.store.MarkArtifactTransferFailure(
				ctx,
				transfer.ID,
				classifyAdapterError(uploadErr),
			); queueErr != nil {
				return fmt.Errorf("record artifact delivery failure: %w", queueErr)
			}
			return uploadErr
		}
		if err = r.store.CompleteArtifactTransfer(ctx, transfer.ID); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runtime) sendHeartbeat(ctx context.Context, identity Identity) error {
	// The container remains healthy while its cached assignments are running,
	// even if Core is temporarily unreachable.
	if err := r.writeHealth("healthy"); err != nil {
		return err
	}
	pending, quarantined, err := r.store.QueueCounts(ctx)
	if err != nil {
		return err
	}
	r.mu.Lock()
	health := make([]AssignmentHealth, 0, len(r.health))
	state := HealthConnected
	for _, value := range r.health {
		health = append(health, value)
		if value.State == HealthDegraded {
			state = HealthDegraded
		}
	}
	revision := r.revision
	r.mu.Unlock()
	coreRevision, err := r.client.Heartbeat(
		ctx,
		identity.CredentialSecret,
		Heartbeat{
			SoftwareVersion:              Version,
			ProtocolVersion:              1,
			AppliedConfigurationRevision: revision,
			HealthState:                  state,
			PendingEventCount:            pending,
			QuarantinedEventCount:        quarantined,
			Assignments:                  health,
		},
	)
	if err != nil {
		return err
	}
	if coreRevision > revision {
		return r.syncConfiguration(ctx, identity)
	}
	return nil
}

func (r *Runtime) writeHealth(status string) error {
	value, _ := json.Marshal(map[string]any{"status": status, "updatedAt": time.Now().UTC()})
	path := filepath.Join(r.dataDir, "health.json")
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, value, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func CheckHealth(dataDir string) error {
	//nolint:gosec // path is the fixed health file name inside the operator-configured data directory
	value, err := os.ReadFile(
		filepath.Join(dataDir, "health.json"),
	)
	if err != nil {
		return err
	}
	var status struct {
		Status    string    `json:"status"`
		UpdatedAt time.Time `json:"updatedAt"`
	}
	if json.Unmarshal(value, &status) != nil || status.Status != "healthy" ||
		time.Since(status.UpdatedAt) > 2*time.Minute {
		return errors.New("connector health is stale")
	}
	return nil
}
