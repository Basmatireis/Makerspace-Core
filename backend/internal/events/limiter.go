package events

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
	"sync"
	"time"
)

const signupRateWindow = 15 * time.Minute
const maxSignupRateKeys = 10000

type signupLimiter struct {
	mu       sync.Mutex
	key      []byte
	attempts map[string][]time.Time
}

func newSignupLimiter(key []byte) *signupLimiter {
	copyKey := append([]byte(nil), key...)
	return &signupLimiter{key: copyKey, attempts: map[string][]time.Time{}}
}

func (l *signupLimiter) allow(clientIP, publicID string, contacts ...*string) bool {
	now := time.Now().UTC()
	keys := []struct {
		value string
		limit int
	}{{value: "ip:" + strings.TrimSpace(clientIP), limit: 20}}
	values := make([]string, 0, len(contacts))
	for _, contact := range contacts {
		if contact != nil {
			values = append(values, *contact)
		}
	}
	sort.Strings(values)
	if len(values) != 0 {
		mac := hmac.New(sha256.New, l.key)
		_, _ = mac.Write([]byte(publicID + "\x00" + strings.Join(values, "\x00")))
		keys = append(keys, struct {
			value string
			limit int
		}{value: "contact:" + hex.EncodeToString(mac.Sum(nil)), limit: 5})
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for key, list := range l.attempts {
		kept := list[:0]
		for _, at := range list {
			if now.Sub(at) < signupRateWindow {
				kept = append(kept, at)
			}
		}
		if len(kept) == 0 {
			delete(l.attempts, key)
		} else {
			l.attempts[key] = kept
		}
	}
	allowed := true
	for _, key := range keys {
		if len(l.attempts[key.value]) >= key.limit {
			allowed = false
		}
		if _, exists := l.attempts[key.value]; !exists && len(l.attempts) >= maxSignupRateKeys {
			allowed = false
		}
	}
	if allowed {
		for _, key := range keys {
			l.attempts[key.value] = append(l.attempts[key.value], now)
		}
	}
	return allowed
}
