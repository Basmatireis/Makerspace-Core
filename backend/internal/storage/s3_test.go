package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestS3IntegrityReadsBytesRatherThanTrustingObjectMetadata(t *testing.T) {
	original := sha256.Sum256([]byte("original"))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/private/01/01995ea6-6d00-7000-8000-000000000002" {
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("<Error><Code>NoSuchKey</Code></Error>"))
			return
		}
		w.Header().Set("X-Amz-Meta-Sha256", hex.EncodeToString(original[:]))
		_, _ = w.Write([]byte("tampered")) // Same length; a HEAD-only check used to pass.
	}))
	defer server.Close()
	store, err := NewS3(context.Background(), S3Config{Endpoint: server.URL, Region: "test", Bucket: "private", AccessKeyID: "local-test", SecretAccessKey: "local-test", UsePathStyle: true})
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := store.Metadata(context.Background(), "01/01995ea6-6d00-7000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	if metadata.Size != 8 || metadata.SHA256 != sha256.Sum256([]byte("tampered")) {
		t.Fatalf("unverified metadata returned: %#v", metadata)
	}
	if _, err := store.Metadata(context.Background(), "01/01995ea6-6d00-7000-8000-000000000002"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing object error = %v", err)
	}
}
