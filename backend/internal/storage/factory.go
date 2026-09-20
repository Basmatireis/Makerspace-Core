package storage

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
)

func NewFromConfig(ctx context.Context, cfg config.Config) (Store, error) {
	switch cfg.StorageBackend {
	case "", "local":
		root := cfg.LocalStorageRoot
		if root == "" {
			root = filepath.Join(os.TempDir(), "makerspace-core-files")
		}
		store, err := NewLocal(root)
		if err != nil {
			return nil, fmt.Errorf("initialize local storage: %w", err)
		}
		return store, nil
	case "s3":
		store, err := NewS3(ctx, S3Config{
			Endpoint: cfg.S3Endpoint, Region: cfg.S3Region, Bucket: cfg.S3Bucket,
			AccessKeyID: cfg.S3AccessKeyID, SecretAccessKey: cfg.S3SecretAccessKey,
			UsePathStyle: cfg.S3UsePathStyle, DisableTLS: cfg.S3DisableTLS,
		})
		if err != nil {
			return nil, fmt.Errorf("initialize S3 storage: %w", err)
		}
		return store, nil
	default:
		return nil, fmt.Errorf("unsupported storage backend %q", cfg.StorageBackend)
	}
}
