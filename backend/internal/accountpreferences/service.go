package accountpreferences

import (
	"context"
	"fmt"
	"slices"
	"time"

	accountpreferencesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/accountpreferences/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Key names one preference.
type Key string

// KeyOpenDaysView is the List/Calendar choice shared by every open-day page.
const KeyOpenDaysView Key = "openDays.view"

// allowed lists every key with the values it accepts. A new preference is one more entry here, plus the key in the
// OpenAPI enum.
var allowed = map[Key][]string{
	KeyOpenDaysView: {"list", "calendar"},
}

// Preference is one stored choice.
type Preference struct {
	Key       Key
	Value     string
	UpdatedAt time.Time
}

// Service reads and writes the principal's own preferences.
type Service struct {
	pool *pgxpool.Pool
	now  func() time.Time
}

// NewService builds the service.
func NewService(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, now: func() time.Time { return time.Now().UTC() }}
}

// List returns the principal's stored preferences ordered by key. Keys without an entry use their default.
func (s *Service) List(ctx context.Context, principal authorization.Principal) ([]Preference, error) {
	rows, err := accountpreferencesdb.New(s.pool).ListOwnAccountPreferences(ctx, principal.AccountID)
	if err != nil {
		return nil, fmt.Errorf("list account preferences: %w", err)
	}
	items := make([]Preference, 0, len(rows))
	for _, row := range rows {
		// A key that is no longer allowed (removed in a later release) is not served.
		if _, ok := allowed[Key(row.Key)]; ok {
			items = append(items, Preference{Key: Key(row.Key), Value: row.Value, UpdatedAt: row.UpdatedAt})
		}
	}
	return items, nil
}

// Set creates or overwrites the principal's value for a key. Unknown keys and values outside the key's list are
// refused.
func (s *Service) Set(
	ctx context.Context, principal authorization.Principal, key Key, value string,
) (Preference, error) {
	values, ok := allowed[key]
	if !ok {
		return Preference{}, apperror.InvalidField("key")
	}
	if !slices.Contains(values, value) {
		return Preference{}, apperror.InvalidField("value")
	}
	row, err := accountpreferencesdb.New(s.pool).UpsertOwnAccountPreference(
		ctx, accountpreferencesdb.UpsertOwnAccountPreferenceParams{
			AccountID: principal.AccountID, Key: string(key), Value: value, UpdatedAt: s.now(),
		})
	if err != nil {
		return Preference{}, fmt.Errorf("store account preference: %w", err)
	}
	return Preference{Key: Key(row.Key), Value: row.Value, UpdatedAt: row.UpdatedAt}, nil
}
