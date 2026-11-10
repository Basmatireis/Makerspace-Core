package signage

import (
	"context"
	"sync"
	"time"

	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

// EmbedLoadsFlushInterval is how often the page loads of web embeds counted in memory are written: a page load
// never writes to the database itself.
const EmbedLoadsFlushInterval = time.Minute

// maxPendingEmbedLoads bounds the counter's memory: one entry per embed and UTC day. Loads beyond it are not counted.
const maxPendingEmbedLoads = 4096

type embedLoadKey struct {
	embed uuid.UUID
	day   time.Time
}

type embedLoads struct {
	count int
	last  time.Time
}

// embedLoadCounter counts page loads of web embeds per embed and UTC day until the next flush.
type embedLoadCounter struct {
	mu      sync.Mutex
	pending map[embedLoadKey]embedLoads
}

func newEmbedLoadCounter() *embedLoadCounter {
	return &embedLoadCounter{pending: map[embedLoadKey]embedLoads{}}
}

// record counts one page load; it reports false when the counter is full and the load was dropped.
func (c *embedLoadCounter) record(embed uuid.UUID, now time.Time) bool {
	key := embedLoadKey{embed: embed, day: utcDate(now)}
	c.mu.Lock()
	defer c.mu.Unlock()
	current, known := c.pending[key]
	if !known && len(c.pending) >= maxPendingEmbedLoads {
		return false
	}
	current.count++
	if now.After(current.last) {
		current.last = now
	}
	c.pending[key] = current
	return true
}

// today returns the loads of an embed on the UTC day of now that are not written yet.
func (c *embedLoadCounter) today(embed uuid.UUID, now time.Time) embedLoads {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pending[embedLoadKey{embed: embed, day: utcDate(now)}]
}

// take hands over everything counted so far and starts afresh.
func (c *embedLoadCounter) take() map[embedLoadKey]embedLoads {
	c.mu.Lock()
	defer c.mu.Unlock()
	taken := c.pending
	c.pending = map[embedLoadKey]embedLoads{}
	return taken
}

// giveBack merges loads whose write failed into the counter again, within its bound.
func (c *embedLoadCounter) giveBack(loads map[embedLoadKey]embedLoads) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, value := range loads {
		current, known := c.pending[key]
		if !known && len(c.pending) >= maxPendingEmbedLoads {
			continue
		}
		current.count += value.count
		if value.last.After(current.last) {
			current.last = value.last
		}
		c.pending[key] = current
	}
}

// FlushEmbedLoads writes the page loads counted in memory; the scheduler calls it every EmbedLoadsFlushInterval
// and the API once more on shutdown. Loads whose write failed are kept for the next flush.
func (s *Service) FlushEmbedLoads(ctx context.Context) (int, error) {
	taken := s.embedLoads.take()
	q := signagedb.New(s.pool)
	written := 0
	for key, value := range taken {
		if err := q.AddSignageWebEmbedLoads(ctx, signagedb.AddSignageWebEmbedLoadsParams{
			LastLoadedAt: value.last,
			Day:          pgtype.Date{Time: key.day, Valid: true},
			Loads:        int32(min(value.count, 1<<30)),
			DisplayID:    key.embed,
		}); err != nil {
			s.embedLoads.giveBack(taken)
			return written, err
		}
		delete(taken, key)
		written += value.count
	}
	return written, nil
}
