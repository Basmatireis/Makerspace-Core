package surveys

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

type fakeDeliverer struct {
	calls  atomic.Int32
	limit  atomic.Int32
	failOn int32
	signal chan struct{}
}

func (f *fakeDeliverer) DeliverDue(_ context.Context, limit int32) (int, error) {
	n := f.calls.Add(1)
	f.limit.Store(limit)
	defer func() {
		select {
		case f.signal <- struct{}{}:
		default:
		}
	}()
	if n == f.failOn {
		return 0, errors.New("smtp secret@example.org token-123")
	}
	return 1, nil
}

func TestRunDeliveryTicksSurvivesErrorsAndStops(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	deliverer := &fakeDeliverer{failOn: 1, signal: make(chan struct{}, 16)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		RunDelivery(ctx, deliverer, 5*time.Millisecond, 7, logger)
		close(done)
	}()
	for range 3 {
		select {
		case <-deliverer.signal:
		case <-time.After(5 * time.Second):
			t.Fatal("delivery loop did not tick")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("delivery loop ignored cancellation")
	}
	if deliverer.calls.Load() < 3 || deliverer.limit.Load() != 7 {
		t.Fatalf("calls=%d limit=%d", deliverer.calls.Load(), deliverer.limit.Load())
	}
	if bytes.Contains(logs.Bytes(), []byte("secret@example.org")) || bytes.Contains(logs.Bytes(), []byte("token-123")) {
		t.Fatalf("log leaked error text: %s", logs.String())
	}
	if !bytes.Contains(logs.Bytes(), []byte("survey delivery failed")) {
		t.Fatalf("error was not logged: %s", logs.String())
	}
}

func TestRunDeliveryDisabledReturnsImmediately(t *testing.T) {
	deliverer := &fakeDeliverer{signal: make(chan struct{}, 1)}
	RunDelivery(context.Background(), deliverer, 0, 10, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	if deliverer.calls.Load() != 0 {
		t.Fatal("disabled loop delivered")
	}
}
