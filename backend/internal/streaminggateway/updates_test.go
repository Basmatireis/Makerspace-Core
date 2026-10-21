package streaminggateway

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/localupdater"
	"github.com/google/uuid"
)

func TestGatewayHandsUpdateRequestsToItsUpdater(t *testing.T) {
	g, core, _, _ := newTestGateway(t)
	ctx := context.Background()
	root := t.TempDir()
	g.options.Updates = localupdater.NewExchange(root, localupdater.ComponentStreamingGateway)

	// A Core without the update field never gets an updater report.
	core.set(testConfiguration(1), nil)
	if err := g.Sync(ctx, Identity{CredentialSecret: "x"}); err != nil {
		t.Fatal(err)
	}
	if heartbeat := g.BuildHeartbeat(ctx); heartbeat.Updater != nil {
		t.Fatalf("updater report sent to an old Core: %+v", heartbeat.Updater)
	}

	dir := filepath.Join(root, string(localupdater.ComponentStreamingGateway))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	presence, _ := json.Marshal(localupdater.Presence{Version: "0.8.2", UpdatedAt: time.Now().UTC()})
	if err := os.WriteFile(filepath.Join(dir, "updater.json"), presence, 0o644); err != nil {
		t.Fatal(err)
	}
	request := localupdater.Request{RequestID: uuid.Must(uuid.NewV7()), Version: "0.8.3"}
	configuration := testConfiguration(1)
	configuration.Update = localupdater.Offer{Present: true, Request: &request}
	core.set(configuration, nil)
	if err := g.Sync(ctx, Identity{CredentialSecret: "x"}); err != nil {
		t.Fatal(err)
	}
	var written localupdater.Request
	data, err := os.ReadFile(filepath.Join(dir, "request.json"))
	if err != nil || json.Unmarshal(data, &written) != nil || written != request {
		t.Fatalf("request file: %s %v", data, err)
	}
	heartbeat := g.BuildHeartbeat(ctx)
	if heartbeat.Updater == nil || !heartbeat.Updater.Available || heartbeat.Updater.Result != nil {
		t.Fatalf("updater report: %+v", heartbeat.Updater)
	}
	// The update request is not part of the stored configuration.
	if stored := g.store.Configuration(); stored == nil || stored.Update.Present || stored.Update.Request != nil {
		t.Fatalf("stored configuration: %+v", stored)
	}
}

func TestConfigurationUpdateFieldTellsPresence(t *testing.T) {
	var without, withNull, withRequest Configuration
	if json.Unmarshal([]byte(`{"revision":1}`), &without) != nil || without.Update.Present {
		t.Fatal("absent field")
	}
	if json.Unmarshal([]byte(`{"revision":1,"update":null}`), &withNull) != nil || !withNull.Update.Present ||
		withNull.Update.Request != nil {
		t.Fatal("null field")
	}
	if json.Unmarshal(
		[]byte(`{"update":{"requestId":"0192f6f8-743e-7c77-a349-cd07c3e8a930","version":"0.8.3"}}`),
		&withRequest,
	) != nil || withRequest.Update.Request == nil || withRequest.Update.Request.Version != "0.8.3" {
		t.Fatal("request field")
	}
	encoded, _ := json.Marshal(Configuration{})
	var raw map[string]any
	if json.Unmarshal(encoded, &raw) != nil {
		t.Fatal("decode")
	}
	if _, ok := raw["update"]; ok {
		t.Fatalf("an empty offer is written: %s", encoded)
	}
}
