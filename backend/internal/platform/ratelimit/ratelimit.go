// Package ratelimit provides a small in-memory sliding-window attempt limiter for the
// single-instance deployment.
package ratelimit

import (
	"net/netip"
	"strings"
	"sync"
	"time"
)

// maxLimiterKeys bounds the memory of one Limiter. At the cap, expired keys are swept
// (at most once per minute); if the table is still full, the key whose latest attempt is
// oldest is evicted. Refusing new keys instead would let anyone who can mint 4096 keys lock
// every other client out.
const (
	maxLimiterKeys     = 4096
	limiterSweepPeriod = time.Minute
)

// Limiter is a small in-memory sliding-window counter (single-instance deployment).
type Limiter struct {
	mu        sync.Mutex
	limit     int
	window    time.Duration
	maxKeys   int
	entries   map[string][]time.Time
	lastSweep time.Time
}

func New(limit int, window time.Duration) *Limiter {
	return &Limiter{limit: limit, window: window, maxKeys: maxLimiterKeys, entries: map[string][]time.Time{}}
}

// recentLocked drops the expired attempts of key and returns the remaining ones. It never
// touches other keys.
func (l *Limiter) recentLocked(key string, now time.Time) []time.Time {
	attempts, ok := l.entries[key]
	if !ok {
		return nil
	}
	recent := attempts[:0:0]
	for _, at := range attempts {
		if now.Sub(at) < l.window {
			recent = append(recent, at)
		}
	}
	if len(recent) == 0 {
		delete(l.entries, key)
		return nil
	}
	l.entries[key] = recent
	return recent
}

// sweepLocked removes every key without a live attempt.
func (l *Limiter) sweepLocked(now time.Time) {
	l.lastSweep = now
	for key := range l.entries {
		l.recentLocked(key, now)
	}
}

// makeRoomLocked ensures a key that is not in the table yet can be tracked: it sweeps expired
// keys first and, if the table is still full, evicts the least recently active key.
func (l *Limiter) makeRoomLocked(key string, now time.Time) {
	if _, tracked := l.entries[key]; tracked || len(l.entries) < l.maxKeys {
		return
	}
	if now.Sub(l.lastSweep) >= limiterSweepPeriod || now.Before(l.lastSweep) {
		l.sweepLocked(now)
	}
	if len(l.entries) < l.maxKeys {
		return
	}
	var oldestKey string
	var oldest time.Time
	for candidate, attempts := range l.entries {
		latest := attempts[len(attempts)-1]
		if oldestKey == "" || latest.Before(oldest) {
			oldestKey, oldest = candidate, latest
		}
	}
	delete(l.entries, oldestKey)
}

// Blocked reports whether key already used up its attempts.
func (l *Limiter) Blocked(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.recentLocked(key, now)) >= l.limit
}

// Take counts an attempt and reports whether it was within the limit.
func (l *Limiter) Take(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.recentLocked(key, now)) >= l.limit {
		return false
	}
	l.makeRoomLocked(key, now)
	l.entries[key] = append(l.entries[key], now)
	return true
}

// Reset forgets every attempt of key, for example after a successful login.
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}

// Refund gives back one attempt that Take counted at the given time.
func (l *Limiter) Refund(key string, at time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	attempts := l.entries[key]
	for index, candidate := range attempts {
		if candidate.Equal(at) {
			attempts = append(attempts[:index:index], attempts[index+1:]...)
			break
		}
	}
	if len(attempts) == 0 {
		delete(l.entries, key)
	} else {
		l.entries[key] = attempts
	}
}

// KeyForIP maps a client address to its rate-limit key: IPv4 by full address, IPv6 by /64
// (one subscriber typically controls a whole /64, so per-address keys would be free to mint).
func KeyForIP(raw string) string {
	address, err := netip.ParseAddr(strings.TrimSpace(raw))
	if err != nil {
		return "unknown"
	}
	address = address.WithZone("").Unmap()
	if address.Is6() {
		return netip.PrefixFrom(address, 64).Masked().String()
	}
	return address.String()
}
