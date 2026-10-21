package printerconnector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/netip"
	"regexp"
	"strings"
	"sync"
	"time"

	MQTT "github.com/eclipse/paho.mqtt.golang"
	"github.com/google/uuid"
)

const (
	bambuH2DSchemaVersion = 1
	bambuX1CSchemaVersion = 1
	bambuMQTTPort         = 8883
	bambuFTPPort          = 990
	maximumReducerBytes   = 256 << 10
)

var bambuSerialPattern = regexp.MustCompile(`^[A-Z0-9]{8,32}$`)

// BambuH2DSettings is the complete non-secret V1 assignment contract.
type BambuH2DSettings struct {
	IPAddress        netip.Addr
	SerialNumber     string
	AutoDetectSpools bool
}

// BambuH2DSecrets contains the only H2D credential stored in an assignment.
type BambuH2DSecrets struct {
	LANAccessCode string
}

func parseBambuH2DConfiguration(
	settings map[string]any,
	secrets map[string]string,
) (BambuH2DSettings, BambuH2DSecrets, error) {
	return parseBambuConfiguration(AdapterBambuH2D, settings, secrets)
}

func parseBambuConfiguration(
	kind AdapterKind,
	settings map[string]any,
	secrets map[string]string,
) (BambuH2DSettings, BambuH2DSecrets, error) {
	if len(settings) < 2 || len(settings) > 3 {
		return BambuH2DSettings{}, BambuH2DSecrets{}, fmt.Errorf(
			"%s settings must contain ipAddress, serialNumber, and optional autoDetectSpools",
			kind,
		)
	}
	for key := range settings {
		if key != "ipAddress" && key != "serialNumber" && key != "autoDetectSpools" {
			return BambuH2DSettings{}, BambuH2DSecrets{}, fmt.Errorf("%s settings contain an unsupported field", kind)
		}
	}
	ipText, ipOK := settings["ipAddress"].(string)
	serial, serialOK := settings["serialNumber"].(string)
	if !ipOK || !serialOK {
		return BambuH2DSettings{}, BambuH2DSecrets{}, fmt.Errorf("%s ipAddress and serialNumber must be strings", kind)
	}
	ip, err := netip.ParseAddr(strings.TrimSpace(ipText))
	if err != nil || !ip.Is4() || ip.IsUnspecified() || ip.IsMulticast() ||
		ip == netip.MustParseAddr("255.255.255.255") {
		return BambuH2DSettings{}, BambuH2DSecrets{}, fmt.Errorf("%s ipAddress must be an IPv4 unicast literal", kind)
	}
	serial = strings.ToUpper(strings.TrimSpace(serial))
	if !bambuSerialPattern.MatchString(serial) {
		return BambuH2DSettings{}, BambuH2DSecrets{}, fmt.Errorf(
			"%s serialNumber must contain 8 to 32 ASCII letters or digits",
			kind,
		)
	}
	autoDetect := false
	if raw, exists := settings["autoDetectSpools"]; exists {
		var ok bool
		autoDetect, ok = raw.(bool)
		if !ok {
			return BambuH2DSettings{}, BambuH2DSecrets{}, fmt.Errorf("%s autoDetectSpools must be a boolean", kind)
		}
	}
	if len(secrets) != 1 {
		return BambuH2DSettings{}, BambuH2DSecrets{}, fmt.Errorf("%s secrets must contain exactly lanAccessCode", kind)
	}
	accessCode := strings.TrimSpace(secrets["lanAccessCode"])
	if accessCode == "" || len(accessCode) > 128 {
		return BambuH2DSettings{}, BambuH2DSecrets{}, fmt.Errorf(
			"%s lanAccessCode is required and must not exceed 128 bytes",
			kind,
		)
	}
	return BambuH2DSettings{
		IPAddress:        ip,
		SerialNumber:     serial,
		AutoDetectSpools: autoDetect,
	}, BambuH2DSecrets{
		LANAccessCode: accessCode,
	}, nil
}

type bambuH2DAdapter struct {
	kind                 AdapterKind
	assignmentID         uuid.UUID
	configurationVersion int64
	settings             BambuH2DSettings
	secrets              BambuH2DSecrets
	store                *Store
	newMQTT              func(BambuH2DSettings, BambuH2DSecrets) (bambuMQTTClient, error)
}

func NewBambuH2D(
	assignmentID uuid.UUID,
	configurationVersion int64,
	schemaVersion int,
	settings map[string]any,
	secrets map[string]string,
	store *Store,
) (Adapter, error) {
	return newBambuLANAdapter(
		AdapterBambuH2D,
		assignmentID,
		configurationVersion,
		schemaVersion,
		settings,
		secrets,
		store,
	)
}

func NewBambuX1C(
	assignmentID uuid.UUID,
	configurationVersion int64,
	schemaVersion int,
	settings map[string]any,
	secrets map[string]string,
	store *Store,
) (Adapter, error) {
	return newBambuLANAdapter(
		AdapterBambuX1C,
		assignmentID,
		configurationVersion,
		schemaVersion,
		settings,
		secrets,
		store,
	)
}

func newBambuLANAdapter(
	kind AdapterKind,
	assignmentID uuid.UUID,
	configurationVersion int64,
	schemaVersion int,
	settings map[string]any,
	secrets map[string]string,
	store *Store,
) (Adapter, error) {
	if assignmentID == uuid.Nil {
		return nil, fmt.Errorf("%s assignment ID is required", kind)
	}
	if configurationVersion < 1 {
		return nil, fmt.Errorf("%s configuration version is required", kind)
	}
	if schemaVersion != 1 {
		return nil, fmt.Errorf("unsupported %s schema version %d", kind, schemaVersion)
	}
	if store == nil {
		return nil, fmt.Errorf("%s store is required", kind)
	}
	parsedSettings, parsedSecrets, err := parseBambuConfiguration(kind, settings, secrets)
	if err != nil {
		return nil, err
	}
	return &bambuH2DAdapter{
		kind:                 kind,
		assignmentID:         assignmentID,
		configurationVersion: configurationVersion,
		settings:             parsedSettings,
		secrets:              parsedSecrets,
		store:                store,
		newMQTT:              newPahoBambuClient,
	}, nil
}

func (a *bambuH2DAdapter) Descriptor() AdapterDescriptor {
	return AdapterDescriptor{
		Kind:          a.adapterKind(),
		SchemaVersion: 1,
		Capabilities: []Capability{
			CapabilityStatus,
			CapabilityProgress,
			CapabilitySlots,
			CapabilityConsumption,
			CapabilityTerminal,
		},
	}
}

func (a *bambuH2DAdapter) adapterKind() AdapterKind {
	if a.kind == "" {
		return AdapterBambuH2D
	}
	return a.kind
}

type bambuMQTTMessage struct {
	payload []byte
	err     error
	state   ConnectivityState
}

type bambuMQTTClient interface {
	Messages() <-chan bambuMQTTMessage
	Connect(context.Context) error
	Close()
}

type bambuStateSink interface {
	CommitBambuState(context.Context, []Observation, bambuPersistedState) error
}

func (a *bambuH2DAdapter) Run(ctx context.Context, sink Sink) error {
	processor, err := newBambuProcessorFor(ctx, a.assignmentID, a.adapterKind(), a.store)
	if err != nil {
		return err
	}
	processor.configureAutoDetectSpools(a.settings.AutoDetectSpools)
	client, err := a.newMQTT(a.settings, a.secrets)
	if err != nil {
		return err
	}
	defer client.Close()
	if err = client.Connect(ctx); err != nil {
		return err
	}
	snapshotTimer := time.NewTimer(15 * time.Second)
	defer snapshotTimer.Stop()
	disconnectTimer := time.NewTicker(5 * time.Second)
	defer disconnectTimer.Stop()
	ready := processor.ready()
	retrievalResults := make(chan error, 1)
	go a.runArtifactRetrievals(ctx, retrievalResults)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-snapshotTimer.C:
			if !ready {
				payload := mustJSON(map[string]any{"state": ConnectivityDegraded, "errorCode": "snapshot_timeout"})
				if err = sink.Commit(ctx, Observation{Kind: ObservationConnectivity, Payload: payload}); err != nil {
					return err
				}
			}
		case now := <-disconnectTimer.C:
			observations := processor.expireDisconnectedRun(now.UTC())
			if len(observations) > 0 {
				if err = commitBambuProcessorState(ctx, sink, processor, observations); err != nil {
					return err
				}
			}
		case retrievalErr := <-retrievalResults:
			if retrievalErr == nil {
				if ready {
					if err = sink.Commit(
						ctx,
						Observation{Kind: ObservationConnectivity, Payload: mustJSON(map[string]any{"state": ConnectivityOnline})},
					); err != nil {
						return err
					}
				}
				continue
			}
			code := classifyAdapterError(retrievalErr)
			if err = sink.Commit(
				ctx,
				Observation{
					Kind:    ObservationConnectivity,
					Payload: mustJSON(map[string]any{"state": ConnectivityDegraded, "errorCode": code}),
				},
			); err != nil {
				return err
			}
		case message, ok := <-client.Messages():
			if !ok {
				return fmt.Errorf("%s MQTT client stopped", a.kind)
			}
			if message.err != nil {
				payload := mustJSON(map[string]any{"state": ConnectivityOffline, "errorCode": classifyAdapterError(message.err)})
				if err = sink.Commit(ctx, Observation{Kind: ObservationConnectivity, Payload: payload}); err != nil {
					return err
				}
				if processor.noteDisconnected(time.Now().UTC()) {
					if err = commitBambuProcessorState(ctx, sink, processor, nil); err != nil {
						return err
					}
				}
				continue
			}
			if message.state != "" {
				if message.state == ConnectivityOnline {
					ready = false
					snapshotTimer.Reset(15 * time.Second)
				} else if message.state == ConnectivityOffline && processor.noteDisconnected(time.Now().UTC()) {
					if err = commitBambuProcessorState(ctx, sink, processor, nil); err != nil {
						return err
					}
				}
				if err = sink.Commit(
					ctx,
					Observation{Kind: ObservationConnectivity, Payload: mustJSON(map[string]any{"state": message.state})},
				); err != nil {
					return err
				}
				continue
			}
			observations, complete, processErr := processor.apply(ctx, message.payload, time.Now().UTC())
			if processErr != nil {
				payload := mustJSON(map[string]any{"state": ConnectivityDegraded, "errorCode": "invalid_mqtt_payload"})
				if err = sink.Commit(ctx, Observation{Kind: ObservationConnectivity, Payload: payload}); err != nil {
					return err
				}
				continue
			}
			// A socket-level connection alone is not enough to cancel an active
			// run's disconnect deadline. Wait until the printer supplies a valid
			// status payload so a silent reconnect still expires predictably.
			processor.noteConnected()
			if complete && !ready {
				ready = true
				if !snapshotTimer.Stop() {
					select {
					case <-snapshotTimer.C:
					default:
					}
				}
				if err = sink.Commit(
					ctx,
					Observation{Kind: ObservationConnectivity, Payload: mustJSON(map[string]any{"state": ConnectivityOnline})},
				); err != nil {
					return err
				}
			}
			if err = commitBambuProcessorState(ctx, sink, processor, observations); err != nil {
				return err
			}
			if live, ok := sink.(LiveStatusSink); ok && processor.ready() {
				live.ReportLiveStatus(processor.liveSnapshot(time.Now().UTC()))
			}
			if scheduleErr := a.scheduleArtifactRetrievals(ctx, observations); scheduleErr != nil {
				code := classifyAdapterError(scheduleErr)
				if err = sink.Commit(
					ctx,
					Observation{
						Kind:    ObservationConnectivity,
						Payload: mustJSON(map[string]any{"state": ConnectivityDegraded, "errorCode": code}),
					},
				); err != nil {
					return err
				}
			}
		}
	}
}

func (a *bambuH2DAdapter) scheduleArtifactRetrievals(ctx context.Context, observations []Observation) error {
	for _, observation := range observations {
		if observation.RunID == nil || (observation.Kind != ObservationOperationalState && observation.Kind != ObservationProgress) {
			continue
		}
		var payload struct {
			ArtifactPath string `json:"artifactPath"`
		}
		if json.Unmarshal(observation.Payload, &payload) != nil {
			continue
		}
		reportedPath := strings.TrimSpace(payload.ArtifactPath)
		if !isBambuArchivePath(reportedPath) {
			continue
		}
		expiresAt := time.Now().UTC().Add(24 * time.Hour)
		if err := a.store.ScheduleArtifactRetrieval(
			ctx,
			a.assignmentID,
			*observation.RunID,
			a.configurationVersion,
			reportedPath,
			expiresAt,
		); err != nil {
			return err
		}
		if err := a.store.ExtendArtifactTransferExpiry(ctx, a.assignmentID, *observation.RunID, expiresAt); err != nil {
			return err
		}
	}
	return nil
}

func commitBambuProcessorState(
	ctx context.Context,
	sink Sink,
	processor *bambuProcessor,
	observations []Observation,
) error {
	if persistent, ok := sink.(bambuStateSink); ok {
		return persistent.CommitBambuState(ctx, observations, processor.state)
	}
	for _, observation := range observations {
		if err := sink.Commit(ctx, observation); err != nil {
			return err
		}
	}
	return processor.persist(ctx)
}

type pahoBambuClient struct {
	settings BambuH2DSettings
	secrets  BambuH2DSecrets
	client   MQTT.Client
	messages chan bambuMQTTMessage
	mu       sync.Mutex
	lastPush time.Time
	ctx      context.Context
	cancel   context.CancelFunc
	retrying bool
}

func newPahoBambuClient(settings BambuH2DSettings, secrets BambuH2DSecrets) (bambuMQTTClient, error) {
	tlsConfig, err := bambuTLSConfig(settings.SerialNumber)
	if err != nil {
		return nil, err
	}
	c := &pahoBambuClient{settings: settings, secrets: secrets, messages: make(chan bambuMQTTMessage, 256)}
	options := MQTT.NewClientOptions()
	options.AddBroker(fmt.Sprintf("ssl://%s:%d", settings.IPAddress.String(), bambuMQTTPort))
	options.SetClientID("makerspace-core-" + uuid.NewString())
	options.SetUsername("bblp")
	options.SetPassword(secrets.LANAccessCode)
	options.SetTLSConfig(tlsConfig)
	options.SetProtocolVersion(4) // MQTT 3.1.1
	options.SetCleanSession(true)
	options.SetAutoReconnect(false)
	options.SetConnectRetry(false)
	options.SetOrderMatters(false)
	options.SetConnectionLostHandler(func(_ MQTT.Client, err error) {
		c.offer(bambuMQTTMessage{err: fmt.Errorf("bambu MQTT connection lost: %w", err)})
		c.startReconnect()
	})
	options.SetOnConnectHandler(func(client MQTT.Client) { c.connected(client) })
	c.client = MQTT.NewClient(options)
	return c, nil
}

func (c *pahoBambuClient) Messages() <-chan bambuMQTTMessage { return c.messages }

func (c *pahoBambuClient) Connect(ctx context.Context) error {
	c.mu.Lock()
	c.ctx, c.cancel = context.WithCancel(ctx)
	c.mu.Unlock()
	if err := c.connectOnce(ctx); err != nil {
		c.offer(bambuMQTTMessage{err: err})
		c.startReconnect()
	}
	return nil
}

func (c *pahoBambuClient) connectOnce(ctx context.Context) error {
	token := c.client.Connect()
	for !token.WaitTimeout(100 * time.Millisecond) {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	if err := token.Error(); err != nil {
		return fmt.Errorf("connect to Bambu MQTT: %w", err)
	}
	return nil
}

func (c *pahoBambuClient) startReconnect() {
	c.mu.Lock()
	if c.retrying || c.ctx == nil || c.ctx.Err() != nil {
		c.mu.Unlock()
		return
	}
	c.retrying = true
	ctx := c.ctx
	c.mu.Unlock()
	go func() {
		defer func() {
			c.mu.Lock()
			c.retrying = false
			shouldRetry := c.ctx != nil && c.ctx.Err() == nil && !c.client.IsConnected()
			c.mu.Unlock()
			if shouldRetry {
				c.startReconnect()
			}
		}()
		delay := time.Second
		for {
			wait := bambuReconnectDelay(delay)
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			if c.client.IsConnected() {
				return
			}
			if err := c.connectOnce(ctx); err == nil {
				return
			} else if !errors.Is(err, context.Canceled) {
				c.offer(bambuMQTTMessage{err: err})
			}
			if delay < time.Minute {
				delay *= 2
				if delay > time.Minute {
					delay = time.Minute
				}
			}
		}
	}()
}

func bambuReconnectDelay(delay time.Duration) time.Duration {
	// Symmetric jitter avoids synchronized reconnects without allowing an
	// attempt sooner than one second or later than the one-minute ceiling.
	quarter := delay / 4
	wait := delay - quarter
	if quarter > 0 {
		wait += time.Duration(rand.Int64N(int64(2*quarter) + 1)) //nolint:gosec // reconnect backoff jitter needs no cryptographic randomness
	}
	if wait < time.Second {
		return time.Second
	}
	if wait > time.Minute {
		return time.Minute
	}
	return wait
}

func (c *pahoBambuClient) connected(client MQTT.Client) {
	reportTopic := "device/" + c.settings.SerialNumber + "/report"
	if token := client.Subscribe(reportTopic, 1, func(_ MQTT.Client, message MQTT.Message) {
		payload := append([]byte(nil), message.Payload()...)
		c.offer(bambuMQTTMessage{payload: payload})
	}); token.Wait() && token.Error() != nil {
		c.offer(bambuMQTTMessage{err: token.Error()})
		return
	}
	c.offer(bambuMQTTMessage{state: ConnectivityOnline})
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.lastPush) < 15*time.Second {
		return
	}
	c.lastPush = time.Now()
	requestTopic := "device/" + c.settings.SerialNumber + "/request"
	payload := `{"pushing":{"sequence_id":"0","command":"pushall"}}`
	if token := client.Publish(requestTopic, 1, false, payload); token.Wait() && token.Error() != nil {
		c.offer(bambuMQTTMessage{err: token.Error()})
	}
}

func (c *pahoBambuClient) offer(message bambuMQTTMessage) {
	select {
	case c.messages <- message:
	default:
		// A bounded channel prevents an untrusted printer from exhausting memory.
		select {
		case c.messages <- bambuMQTTMessage{err: errors.New("MQTT message buffer full")}:
		default:
		}
	}
}

func (c *pahoBambuClient) Close() {
	c.mu.Lock()
	if c.cancel != nil {
		c.cancel()
	}
	c.mu.Unlock()
	if c.client != nil && c.client.IsConnected() {
		c.client.Disconnect(250)
	}
}

func mustJSON(value any) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}
