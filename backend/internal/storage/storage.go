package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
)

var validKey = regexp.MustCompile(`^[0-9a-f]{2}/[0-9a-f-]{36}$`)

var ErrNotFound = errors.New("storage object not found")

type Metadata struct {
	Size   int64
	SHA256 [sha256.Size]byte
}

type Store interface {
	Put(context.Context, string, io.Reader, Metadata) error
	Open(context.Context, string) (io.ReadCloser, error)
	Delete(context.Context, string) error
	Metadata(context.Context, string) (Metadata, error)
}

func ValidateKey(key string) error {
	if !validKey.MatchString(key) {
		return fmt.Errorf("invalid generated storage key")
	}
	return nil
}

func SHA256Hex(value [sha256.Size]byte) string { return hex.EncodeToString(value[:]) }
