package streaminggateway

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

// Identity is the gateway's runtime credential.
type Identity struct {
	GatewayID           uuid.UUID `json:"gatewayId"`
	CredentialID        uuid.UUID `json:"credentialId"`
	CredentialSecret    string    `json:"credentialSecret"`
	CredentialExpiresAt time.Time `json:"credentialExpiresAt"`
	Enrolled            bool      `json:"enrolled"`
}

type persisted struct {
	Identity      *Identity      `json:"identity,omitempty"`
	Configuration *Configuration `json:"configuration,omitempty"`
}

// Store keeps the identity and the last accepted configuration encrypted in the data directory.
// The key lives next to the data, so the encryption protects against accidental disclosure of the
// state file (backups, logs), not against someone with access to the whole volume.
type Store struct {
	dataDir  string
	aead     cipher.AEAD
	lockFile *os.File
	state    persisted
}

const stateAAD = "streaming-gateway-local-state-v1"

// OpenStore creates the data directory, takes the process lock and loads the saved state.
func OpenStore(dataDir string) (*Store, error) {
	if dataDir == "" {
		return nil, errors.New("data directory is required")
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	if err := os.Chmod(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("protect data directory: %w", err)
	}
	lockFile, err := os.OpenFile(filepath.Join(dataDir, "gateway.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open process lock: %w", err)
	}
	if err = unix.Flock(int(lockFile.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = lockFile.Close()
		return nil, errors.New("gateway data directory is already in use")
	}
	aead, err := loadAEAD(filepath.Join(dataDir, "local.key"))
	if err != nil {
		_ = lockFile.Close()
		return nil, err
	}
	store := &Store{dataDir: dataDir, aead: aead, lockFile: lockFile}
	if err = store.load(); err != nil {
		_ = store.Close()
		return nil, err
	}
	return store, nil
}

func loadAEAD(path string) (cipher.AEAD, error) {
	key, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		if err = os.WriteFile(path, key, 0o600); err != nil {
			return nil, fmt.Errorf("write local encryption key: %w", err)
		}
	} else if err != nil {
		return nil, err
	}
	if len(key) != 32 {
		return nil, errors.New("local encryption key must contain exactly 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (s *Store) path() string { return filepath.Join(s.dataDir, "state.enc") }

func (s *Store) load() error {
	raw, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(raw) < s.aead.NonceSize() {
		return errors.New("encrypted local state is truncated")
	}
	plain, err := s.aead.Open(nil, raw[:s.aead.NonceSize()], raw[s.aead.NonceSize():], []byte(stateAAD))
	if err != nil {
		return errors.New("encrypted local state cannot be decrypted")
	}
	return json.Unmarshal(plain, &s.state)
}

func (s *Store) save() error {
	plain, err := json.Marshal(s.state)
	if err != nil {
		return err
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	sealed := s.aead.Seal(nonce, nonce, plain, []byte(stateAAD))
	temporary := s.path() + ".tmp"
	if err = os.WriteFile(temporary, sealed, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, s.path())
}

func (s *Store) Identity() *Identity {
	if s.state.Identity == nil {
		return nil
	}
	copy := *s.state.Identity
	return &copy
}

func (s *Store) SaveIdentity(value Identity) error {
	s.state.Identity = &value
	return s.save()
}

func (s *Store) Configuration() *Configuration {
	if s.state.Configuration == nil {
		return nil
	}
	copy := *s.state.Configuration
	return &copy
}

func (s *Store) SaveConfiguration(value Configuration) error {
	s.state.Configuration = &value
	return s.save()
}

func (s *Store) Close() error {
	if s.lockFile != nil {
		_ = unix.Flock(int(s.lockFile.Fd()), unix.LOCK_UN)
		return s.lockFile.Close()
	}
	return nil
}
