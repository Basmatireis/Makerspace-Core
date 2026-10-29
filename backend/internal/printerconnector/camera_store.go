package printerconnector

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// go2rtcCredentials protect the bundled go2rtc's HTTP API. They are random, generated once and kept
// sealed in the local store; the generated go2rtc configuration (mode 0600) carries them too.
type go2rtcCredentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// go2rtcCredentials returns the stored go2rtc API credentials and creates them on first use.
func (s *Store) go2rtcCredentials(ctx context.Context) (go2rtcCredentials, error) {
	var encrypted []byte
	err := s.db.QueryRowContext(ctx, `SELECT value FROM metadata WHERE key='go2rtc_api'`).Scan(&encrypted)
	if err == nil {
		plain, openErr := s.open(encrypted)
		if openErr != nil {
			return go2rtcCredentials{}, openErr
		}
		var value go2rtcCredentials
		if err = json.Unmarshal(plain, &value); err != nil {
			return go2rtcCredentials{}, err
		}
		if value.Username != "" && value.Password != "" {
			return value, nil
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return go2rtcCredentials{}, err
	}
	password, err := newSecret()
	if err != nil {
		return go2rtcCredentials{}, err
	}
	value := go2rtcCredentials{Username: "connector", Password: password}
	//nolint:gosec // the credentials are marshaled only to be sealed into the local store
	plain, err := json.Marshal(value)
	if err != nil {
		return go2rtcCredentials{}, err
	}
	encrypted, err = s.seal(plain)
	if err != nil {
		return go2rtcCredentials{}, err
	}
	_, err = s.db.ExecContext(
		ctx,
		`INSERT INTO metadata(key,value) VALUES('go2rtc_api',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		encrypted,
	)
	return value, err
}
