package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"testing"
)

func TestLocalStoreLifecycleAndIntegrity(t *testing.T) {
	store, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("private file contents")
	digest := sha256.Sum256(data)
	key := "01/01995ea6-6d00-7000-8000-000000000001"
	if err := store.Put(context.Background(), key, bytes.NewReader(data), Metadata{Size: int64(len(data)), SHA256: digest}); err != nil {
		t.Fatal(err)
	}
	metadata, err := store.Metadata(context.Background(), key)
	if err != nil || metadata.Size != int64(len(data)) || metadata.SHA256 != digest {
		t.Fatalf("unexpected metadata: %#v, %v", metadata, err)
	}
	reader, err := store.Open(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("unexpected contents %q: %v", got, err)
	}
	if err := store.Delete(context.Background(), key); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Open(context.Background(), key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
}

func TestLocalStoreRejectsTraversalAndIntegrityMismatch(t *testing.T) {
	store, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("contents")
	digest := sha256.Sum256(data)
	for _, key := range []string{"../outside", "01/../../outside", "/absolute", "not-generated"} {
		if err := store.Put(context.Background(), key, bytes.NewReader(data), Metadata{Size: int64(len(data)), SHA256: digest}); err == nil {
			t.Fatalf("expected invalid key %q to fail", key)
		}
	}
	key := "01/01995ea6-6d00-7000-8000-000000000001"
	if err := store.Put(context.Background(), key, bytes.NewReader(data), Metadata{Size: int64(len(data)) + 1, SHA256: digest}); err == nil {
		t.Fatal("expected integrity mismatch")
	}
	if _, err := store.Open(context.Background(), key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("failed upload must not become visible: %v", err)
	}
}
