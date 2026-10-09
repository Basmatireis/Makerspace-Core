package devicebridge

import (
	"context"
	"encoding/hex"
	"strings"
	"sync"
	"time"
)

const maxBufferedEvents = 256

type Broker struct {
	mu          sync.Mutex
	events      []Event
	sequence    uint64
	notify      chan struct{}
	lastScans   map[string]lastScan
	duplicateIn time.Duration
}

type lastScan struct {
	uid string
	at  time.Time
}

func NewBroker() *Broker {
	return &Broker{notify: make(chan struct{}), lastScans: make(map[string]lastScan), duplicateIn: 1500 * time.Millisecond}
}

func (b *Broker) Publish(raw RawEvent) (Event, error) {
	now := time.Now().UTC()
	event := Event{ProtocolVersion: ProtocolVersion, Kind: raw.Kind, Source: raw.Source, OccurredAt: now, State: raw.State, ErrorCode: raw.ErrorCode}
	if raw.ReaderID != "" || raw.ReaderName != "" {
		event.Reader = &ReaderMetadata{ID: raw.ReaderID, Name: raw.ReaderName, Protocol: raw.Protocol, ATR: strings.ToUpper(raw.ATR)}
	}
	if raw.Kind == "nfc_scan" {
		uid, err := normalizeUID(raw.UID)
		if err != nil {
			return Event{}, err
		}
		event.NFC = &NFCMetadata{UID: uid, UIDFormat: "hex"}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if event.Kind == "nfc_scan" && event.NFC != nil {
		previous := b.lastScans[raw.ReaderID]
		event.Duplicate = event.NFC.UID == previous.uid && now.Sub(previous.at) <= b.duplicateIn
		b.lastScans[raw.ReaderID] = lastScan{uid: event.NFC.UID, at: now}
	} else if event.Kind == "nfc_removed" {
		delete(b.lastScans, raw.ReaderID)
	}
	b.sequence++
	event.Sequence = b.sequence
	b.events = append(b.events, event)
	if len(b.events) > maxBufferedEvents {
		b.events = append([]Event(nil), b.events[len(b.events)-maxBufferedEvents:]...)
	}
	close(b.notify)
	b.notify = make(chan struct{})
	return event, nil
}

func (b *Broker) LatestSequence() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sequence
}

func (b *Broker) Wait(ctx context.Context, after uint64, maximum time.Duration) EventPage {
	deadline := time.NewTimer(maximum)
	defer deadline.Stop()
	for {
		b.mu.Lock()
		page := b.pageLocked(after)
		wake := b.notify
		b.mu.Unlock()
		if len(page.Events) > 0 || maximum <= 0 {
			return page
		}
		select {
		case <-ctx.Done():
			return EventPage{Events: []Event{}, NextSequence: after}
		case <-deadline.C:
			return EventPage{Events: []Event{}, NextSequence: after}
		case <-wake:
		}
	}
}

func (b *Broker) pageLocked(after uint64) EventPage {
	items := make([]Event, 0)
	for _, event := range b.events {
		if event.Sequence > after {
			items = append(items, event)
		}
	}
	next := after
	if len(items) > 0 {
		next = items[len(items)-1].Sequence
	}
	return EventPage{Events: items, NextSequence: next}
}

func normalizeUID(value string) (string, error) {
	normalized := strings.NewReplacer(":", "", "-", "", " ", "").Replace(strings.TrimSpace(value))
	if len(normalized) < 2 || len(normalized) > 64 || len(normalized)%2 != 0 {
		return "", ErrInvalidUID
	}
	if _, err := hex.DecodeString(normalized); err != nil {
		return "", ErrInvalidUID
	}
	return strings.ToUpper(normalized), nil
}
