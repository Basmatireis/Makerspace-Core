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

func parseBambuH2DConfiguration(settings map[string]any, secrets map[string]string) (BambuH2DSettings, BambuH2DSecrets, error) {
	if len(settings) < 2 || len(settings) > 3 {
		return BambuH2DSettings{}, BambuH2DSecrets{}, errors.New("bambu_h2d settings must contain ipAddress, serialNumber, and optional autoDetectSpools")
	}
	for key := range settings {
		if key != "ipAddress" && key != "serialNumber" && key != "autoDetectSpools" {
			return BambuH2DSettings{}, BambuH2DSecrets{}, errors.New("bambu_h2d settings contain an unsupported field")
		}
	}
	ipText, ipOK := settings["ipAddress"].(string)
	serial, serialOK := settings["serialNumber"].(string)
	if !ipOK || !serialOK {
		return BambuH2DSettings{}, BambuH2DSecrets{}, errors.New("bambu_h2d ipAddress and serialNumber must be strings")
	}
	ip, err := netip.ParseAddr(strings.TrimSpace(ipText))
	if err != nil || !ip.Is4() || ip.IsUnspecified() || ip.IsMulticast() || ip == netip.MustParseAddr("255.255.255.255") {
		return BambuH2DSettings{}, BambuH2DSecrets{}, errors.New("bambu_h2d ipAddress must be an IPv4 unicast literal")
	}
	serial = strings.ToUpper(strings.TrimSpace(serial))
	if !bambuSerialPattern.MatchString(serial) {
		return BambuH2DSettings{}, BambuH2DSecrets{}, errors.New("bambu_h2d serialNumber must contain 8 to 32 ASCII letters or digits")
	}
	autoDetect := false
	if raw, exists := settings["autoDetectSpools"]; exists {
		var ok bool
		autoDetect, ok = raw.(bool)
		if !ok {
			return BambuH2DSettings{}, BambuH2DSecrets{}, errors.New("bambu_h2d autoDetectSpools must be a boolean")
		}
	}
	if len(secrets) != 1 {
		return BambuH2DSettings{}, BambuH2DSecrets{}, errors.New("bambu_h2d secrets must contain exactly lanAccessCode")
	}
	accessCode := strings.TrimSpace(secrets["lanAccessCode"])
	if accessCode == "" || len(accessCode) > 128 {
		return BambuH2DSettings{}, BambuH2DSecrets{}, errors.New("bambu_h2d lanAccessCode is required and must not exceed 128 bytes")
	}
	return BambuH2DSettings{IPAddress: ip, SerialNumber: serial, AutoDetectSpools: autoDetect}, BambuH2DSecrets{LANAccessCode: accessCode}, nil
}

type bambuH2DAdapter struct {
	assignmentID         uuid.UUID
	configurationVersion int64
	settings             BambuH2DSettings
	secrets              BambuH2DSecrets
	store                *Store
	newMQTT              func(BambuH2DSettings, BambuH2DSecrets) (bambuMQTTClient, error)
}

func NewBambuH2D(assignmentID uuid.UUID, configurationVersion int64, schemaVersion int, settings map[string]any, secrets map[string]string, store *Store) (Adapter, error) {
	if assignmentID == uuid.Nil {
		return nil, errors.New("bambu_h2d assignment ID is required")
	}
	if configurationVersion < 1 {
		return nil, errors.New("bambu_h2d configuration version is required")
	}
	if schemaVersion != bambuH2DSchemaVersion {
		return nil, fmt.Errorf("unsupported bambu_h2d schema version %d", schemaVersion)
	}
	if store == nil {
		return nil, errors.New("bambu_h2d store is required")
	}
	parsedSettings, parsedSecrets, err := parseBambuH2DConfiguration(settings, secrets)
	if err != nil {
		return nil, err
	}
	return &bambuH2DAdapter{assignmentID: assignmentID, configurationVersion: configurationVersion, settings: parsedSettings, secrets: parsedSecrets, store: store, newMQTT: newPahoBambuClient}, nil
}

func (a *bambuH2DAdapter) Descriptor() AdapterDescriptor {
	return AdapterDescriptor{Kind: "bambu_h2d", SchemaVersion: bambuH2DSchemaVersion, Capabilities: []Capability{CapabilityStatus, CapabilityProgress, CapabilitySlots, CapabilityConsumption, CapabilityTerminal}}
}

type bambuMQTTMessage struct {
	payload []byte
	err     error
	state   string
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
	processor, err := newBambuProcessor(ctx, a.assignmentID, a.store)
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
	ready := processor.ready()
	retrievalErrors := make(chan error, 1)
	go a.runArtifactRetrievals(ctx, retrievalErrors)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-snapshotTimer.C:
			if !ready {
				payload := mustJSON(map[string]any{"state": "degraded", "errorCode": "snapshot_timeout"})
				if err = sink.Commit(ctx, Observation{Kind: "connectivity", Payload: payload}); err != nil {
					return err
				}
			}
		case retrievalErr := <-retrievalErrors:
			code := classifyAdapterError(retrievalErr)
			if err = sink.Commit(ctx, Observation{Kind: "connectivity", Payload: mustJSON(map[string]any{"state": "degraded", "errorCode": code})}); err != nil {
				return err
			}
		case message, ok := <-client.Messages():
			if !ok {
				return errors.New("bambu_h2d MQTT client stopped")
			}
			if message.err != nil {
				payload := mustJSON(map[string]any{"state": "offline", "errorCode": classifyAdapterError(message.err)})
				if err = sink.Commit(ctx, Observation{Kind: "connectivity", Payload: payload}); err != nil {
					return err
				}
				continue
			}
			if message.state != "" {
				if message.state == "online" {
					ready = false
					snapshotTimer.Reset(15 * time.Second)
				}
				if err = sink.Commit(ctx, Observation{Kind: "connectivity", Payload: mustJSON(map[string]any{"state": message.state})}); err != nil {
					return err
				}
				continue
			}
			observations, complete, processErr := processor.apply(ctx, message.payload, time.Now().UTC())
			if processErr != nil {
				payload := mustJSON(map[string]any{"state": "degraded", "errorCode": "invalid_mqtt_payload"})
				if err = sink.Commit(ctx, Observation{Kind: "connectivity", Payload: payload}); err != nil {
					return err
				}
				continue
			}
			if complete && !ready {
				ready = true
				if !snapshotTimer.Stop() {
					select {
					case <-snapshotTimer.C:
					default:
					}
				}
				if err = sink.Commit(ctx, Observation{Kind: "connectivity", Payload: mustJSON(map[string]any{"state": "online"})}); err != nil {
					return err
				}
			}
			if persistent, ok := sink.(bambuStateSink); ok {
				if err = persistent.CommitBambuState(ctx, observations, processor.state); err != nil {
					return err
				}
			} else {
				for _, observation := range observations {
					if err = sink.Commit(ctx, observation); err != nil {
						return err
					}
				}
				if err = processor.persist(ctx); err != nil {
					return err
				}
			}
			if scheduleErr := a.scheduleArtifactRetrievals(ctx, observations); scheduleErr != nil {
				code := classifyAdapterError(scheduleErr)
				if err = sink.Commit(ctx, Observation{Kind: "connectivity", Payload: mustJSON(map[string]any{"state": "degraded", "errorCode": code})}); err != nil {
					return err
				}
			}
		}
	}
}

func (a *bambuH2DAdapter) scheduleArtifactRetrievals(ctx context.Context, observations []Observation) error {
	for _, observation := range observations {
		if observation.RunID == nil || (observation.Kind != "operational_state" && observation.Kind != "progress") {
			continue
		}
		var payload struct {
			FileName string `json:"fileName"`
		}
		if json.Unmarshal(observation.Payload, &payload) != nil || strings.TrimSpace(payload.FileName) == "" {
			continue
		}
		expiresAt := time.Now().UTC().Add(24 * time.Hour)
		if err := a.store.ScheduleArtifactRetrieval(ctx, a.assignmentID, *observation.RunID, a.configurationVersion, payload.FileName, expiresAt); err != nil {
			return err
		}
		if err := a.store.ExtendArtifactTransferExpiry(ctx, a.assignmentID, *observation.RunID, expiresAt); err != nil {
			return err
		}
	}
	return nil
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
		c.offer(bambuMQTTMessage{err: fmt.Errorf("bambu_h2d MQTT connection lost: %w", err)})
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
		return fmt.Errorf("connect to bambu_h2d MQTT: %w", err)
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
		wait += time.Duration(rand.Int64N(int64(2*quarter) + 1))
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
	c.offer(bambuMQTTMessage{state: "online"})
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
