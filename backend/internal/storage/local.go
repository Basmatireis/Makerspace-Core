package storage

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type Local struct{ root string }

func NewLocal(root string) (*Local, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return nil, fmt.Errorf("create local storage root: %w", err)
	}
	return &Local{root: absolute}, nil
}

func (s *Local) Put(ctx context.Context, key string, reader io.Reader, expected Metadata) error {
	path, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(s.root, ".upload-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temporary, hash), &contextReader{ctx: ctx, reader: reader})
	if copyErr == nil && (written != expected.Size || !equalDigest(hash.Sum(nil), expected.SHA256)) {
		copyErr = fmt.Errorf("storage object integrity mismatch")
	}
	if copyErr == nil {
		copyErr = temporary.Sync()
	}
	if closeErr := temporary.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return copyErr
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err == nil {
		err = directory.Sync()
		_ = directory.Close()
	}
	return err
}

func (s *Local) Open(_ context.Context, key string) (io.ReadCloser, error) {
	path, err := s.path(key)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return file, err
}

func (s *Local) Delete(_ context.Context, key string) error {
	path, err := s.path(key)
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s *Local) Metadata(ctx context.Context, key string) (Metadata, error) {
	reader, err := s.Open(ctx, key)
	if err != nil {
		return Metadata{}, err
	}
	defer reader.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, &contextReader{ctx: ctx, reader: reader})
	if err != nil {
		return Metadata{}, err
	}
	var digest [sha256.Size]byte
	copy(digest[:], hash.Sum(nil))
	return Metadata{Size: size, SHA256: digest}, nil
}

func (s *Local) path(key string) (string, error) {
	if err := ValidateKey(key); err != nil {
		return "", err
	}
	path := filepath.Join(s.root, filepath.FromSlash(key))
	relative, err := filepath.Rel(s.root, path)
	if err != nil || relative == ".." || filepath.IsAbs(relative) {
		return "", fmt.Errorf("storage key escaped root")
	}
	return path, nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(buffer []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.reader.Read(buffer)
	}
}

func equalDigest(value []byte, expected [sha256.Size]byte) bool {
	if len(value) != len(expected) {
		return false
	}
	var difference byte
	for index := range value {
		difference |= value[index] ^ expected[index]
	}
	return difference == 0
}
