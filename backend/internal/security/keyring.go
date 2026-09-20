package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
)

const encryptedValueVersion byte = 1

type Keyring struct {
	keys []keyringEntry
}

type keyringEntry struct {
	id   [8]byte
	aead cipher.AEAD
}

func NewKeyring(keys [][]byte) (*Keyring, error) {
	if len(keys) == 0 {
		return nil, errors.New("at least one application encryption key is required")
	}
	entries := make([]keyringEntry, 0, len(keys))
	seen := map[[8]byte]struct{}{}
	for _, key := range keys {
		if len(key) != 32 {
			return nil, errors.New("application encryption keys must be 32 bytes")
		}
		digest := sha256.Sum256(key)
		var id [8]byte
		copy(id[:], digest[:8])
		if _, exists := seen[id]; exists {
			return nil, errors.New("application encryption keys must be distinct")
		}
		seen[id] = struct{}{}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return nil, err
		}
		entries = append(entries, keyringEntry{id: id, aead: aead})
	}
	return &Keyring{keys: entries}, nil
}

func (k *Keyring) Encrypt(plaintext []byte, purpose string) ([]byte, error) {
	if k == nil || len(k.keys) == 0 {
		return nil, errors.New("application encryption is not configured")
	}
	entry := k.keys[0]
	nonce := make([]byte, entry.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	result := make([]byte, 0, 1+len(entry.id)+len(nonce)+len(plaintext)+entry.aead.Overhead())
	result = append(result, encryptedValueVersion)
	result = append(result, entry.id[:]...)
	result = append(result, nonce...)
	return entry.aead.Seal(result, nonce, plaintext, []byte(purpose)), nil
}

func (k *Keyring) Decrypt(ciphertext []byte, purpose string) ([]byte, error) {
	if k == nil || len(ciphertext) < 1+8 {
		return nil, errors.New("encrypted value is invalid")
	}
	if ciphertext[0] != encryptedValueVersion {
		return nil, fmt.Errorf("unsupported encrypted value version")
	}
	var id [8]byte
	copy(id[:], ciphertext[1:9])
	for _, entry := range k.keys {
		if entry.id != id {
			continue
		}
		nonceSize := entry.aead.NonceSize()
		if len(ciphertext) < 9+nonceSize+entry.aead.Overhead() {
			return nil, errors.New("encrypted value is truncated")
		}
		nonce := ciphertext[9 : 9+nonceSize]
		return entry.aead.Open(nil, nonce, ciphertext[9+nonceSize:], []byte(purpose))
	}
	return nil, errors.New("encrypted value key is unavailable")
}

func (k *Keyring) NeedsRotation(ciphertext []byte) bool {
	return k == nil || len(k.keys) == 0 || len(ciphertext) < 9 || string(ciphertext[1:9]) != string(k.keys[0].id[:])
}
