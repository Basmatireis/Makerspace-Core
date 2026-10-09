package devicebridge

import (
	"context"
	"testing"
	"time"
)

func TestBrokerNormalizesUIDAndMarksDuplicatesUntilRemoval(t *testing.T) {
	broker := NewBroker()
	first, err := broker.Publish(RawEvent{Kind: "nfc_scan", Source: "simulator", ReaderID: "reader", UID: "04:a7-31 0b"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := broker.Publish(RawEvent{Kind: "nfc_scan", Source: "simulator", ReaderID: "reader", UID: "04A7310B"})
	if err != nil {
		t.Fatal(err)
	}
	if first.NFC == nil || first.NFC.UID != "04A7310B" || first.Duplicate || !second.Duplicate {
		t.Fatalf("unexpected normalized events: first=%+v second=%+v", first, second)
	}
	if _, err = broker.Publish(RawEvent{Kind: "nfc_removed", Source: "simulator", ReaderID: "reader"}); err != nil {
		t.Fatal(err)
	}
	third, err := broker.Publish(RawEvent{Kind: "nfc_scan", Source: "simulator", ReaderID: "reader", UID: "04A7310B"})
	if err != nil {
		t.Fatal(err)
	}
	if third.Duplicate {
		t.Fatal("scan after removal must not be marked duplicate")
	}
}

func TestBrokerRejectsInvalidUIDAndResumesAfterCursor(t *testing.T) {
	broker := NewBroker()
	if _, err := broker.Publish(RawEvent{Kind: "nfc_scan", UID: "not-a-uid"}); err != ErrInvalidUID {
		t.Fatalf("error = %v, want ErrInvalidUID", err)
	}
	first, _ := broker.Publish(RawEvent{Kind: "reader_state", State: "disconnected"})
	second, _ := broker.Publish(RawEvent{Kind: "reader_state", State: "connected"})
	page := broker.Wait(context.Background(), first.Sequence, 0)
	if len(page.Events) != 1 || page.Events[0].Sequence != second.Sequence || page.NextSequence != second.Sequence {
		t.Fatalf("unexpected resumed page: %+v", page)
	}
	started := time.Now()
	empty := broker.Wait(context.Background(), second.Sequence, 10*time.Millisecond)
	if len(empty.Events) != 0 || time.Since(started) < 8*time.Millisecond {
		t.Fatalf("long poll returned incorrectly: %+v", empty)
	}
}

func TestBrokerDebouncesReadersIndependently(t *testing.T) {
	broker := NewBroker()
	first, _ := broker.Publish(RawEvent{Kind: "nfc_scan", Source: "simulator", ReaderID: "reader-a", UID: "04A7"})
	other, _ := broker.Publish(RawEvent{Kind: "nfc_scan", Source: "simulator", ReaderID: "reader-b", UID: "04A7"})
	again, _ := broker.Publish(RawEvent{Kind: "nfc_scan", Source: "simulator", ReaderID: "reader-a", UID: "04A7"})
	if first.Duplicate || other.Duplicate || !again.Duplicate {
		t.Fatalf("reader-local duplicate state was not preserved: first=%v other=%v again=%v", first.Duplicate, other.Duplicate, again.Duplicate)
	}
	_, _ = broker.Publish(RawEvent{Kind: "nfc_removed", Source: "simulator", ReaderID: "reader-b"})
	again, _ = broker.Publish(RawEvent{Kind: "nfc_scan", Source: "simulator", ReaderID: "reader-a", UID: "04A7"})
	if !again.Duplicate {
		t.Fatal("removing a tag from another reader cleared duplicate state")
	}
}
