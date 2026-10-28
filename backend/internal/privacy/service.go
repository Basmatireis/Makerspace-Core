package privacy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	privacydb "github.com/Basmatireis/Makerspace-Core/backend/internal/privacy/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Settings are the installation's privacy settings.
type Settings struct {
	ControllerName        string
	ControllerAddress     string
	DataProtectionContact string
	AutomaticRunsEnabled  bool
	RunIntervalMinutes    int32
	Version               int64
	UpdatedAt             *time.Time
}

// SettingsInput changes the settings with an optimistic version.
type SettingsInput struct {
	ControllerName        string
	ControllerAddress     string
	DataProtectionContact string
	AutomaticRunsEnabled  bool
	RunIntervalMinutes    int32
	ExpectedVersion       int64
}

// Category is a definition with its registry status.
type Category struct {
	Definition
	// Orphaned snapshots belong to a category no code declares any more.
	Orphaned    bool
	FirstSeenAt time.Time
	LastSeenAt  time.Time
}

// Overview summarises the registry for the privacy settings page.
type Overview struct {
	Categories           int
	OrphanedCategories   int
	AutomaticRunsEnabled bool
}

// Service reads the registry and settings and runs retention.
type Service struct {
	pool     *pgxpool.Pool
	catalog  *Catalog
	handlers map[CategoryID]RetentionHandler
	legacy   LegacyPeriods
	now      func() time.Time

	mu       sync.Mutex
	snapshot bool
	drafts   bool
}

// NewService wires the registry to the database.
func NewService(pool *pgxpool.Pool, catalog *Catalog) *Service {
	return &Service{pool: pool, catalog: catalog, handlers: map[CategoryID]RetentionHandler{}, now: time.Now}
}

// Catalog exposes the declared categories.
func (s *Service) Catalog() *Catalog { return s.catalog }

// snapshotDefinition is what the registry persists about a category, so an
// orphaned category keeps a readable description after its code is gone.
type snapshotDefinition struct {
	Name     string   `json:"name"`
	Subject  string   `json:"subject"`
	Fields   []string `json:"fields"`
	Triggers []string `json:"triggers"`
	Actions  []string `json:"actions"`
}

// EnsureSnapshots records every declared category and marks the rest as
// orphaned. It runs once per process on first use.
func (s *Service) EnsureSnapshots(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.snapshot {
		return nil
	}
	q := privacydb.New(s.pool)
	declared := make([]string, 0, len(s.catalog.order))
	for _, definition := range s.catalog.Definitions() {
		encoded, err := json.Marshal(snapshotDefinition{
			Name: definition.Name, Subject: string(definition.Subject), Fields: definition.Fields,
			Triggers: triggerNames(definition.Triggers), Actions: actionNames(definition.Actions),
		})
		if err != nil {
			return err
		}
		if err := q.UpsertCategorySnapshot(ctx, privacydb.UpsertCategorySnapshotParams{
			CategoryID: string(definition.ID), OwnerModuleID: string(definition.Owner), Definition: string(encoded),
		}); err != nil {
			return fmt.Errorf("snapshot category %s: %w", definition.ID, err)
		}
		declared = append(declared, string(definition.ID))
	}
	if _, err := q.OrphanCategorySnapshots(ctx, declared); err != nil {
		return err
	}
	s.snapshot = true
	return nil
}

func triggerNames(triggers []Trigger) []string {
	result := make([]string, 0, len(triggers))
	for _, trigger := range triggers {
		result = append(result, string(trigger))
	}
	return result
}

func actionNames(actions []Action) []string {
	result := make([]string, 0, len(actions))
	for _, action := range actions {
		result = append(result, string(action))
	}
	return result
}

// Categories lists the declared and orphaned categories (privacy.read).
func (s *Service) Categories(ctx context.Context, p authorization.Principal) ([]Category, error) {
	if !p.Has(authorization.PrivacyRead) {
		return nil, apperror.PermissionDenied
	}
	return s.categories(ctx)
}

func (s *Service) categories(ctx context.Context) ([]Category, error) {
	if err := s.EnsureSnapshots(ctx); err != nil {
		return nil, err
	}
	rows, err := privacydb.New(s.pool).ListCategorySnapshots(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Category, 0, len(rows))
	for _, row := range rows {
		category := Category{FirstSeenAt: row.FirstSeenAt, LastSeenAt: row.LastSeenAt, Orphaned: row.Orphaned}
		if definition, declared := s.catalog.Lookup(CategoryID(row.CategoryID)); declared {
			category.Definition = definition
		} else {
			category.Definition = orphanedDefinition(row)
		}
		result = append(result, category)
	}
	return result, nil
}

func orphanedDefinition(row privacydb.PrivacyCategorySnapshot) Definition {
	var stored snapshotDefinition
	_ = json.Unmarshal(row.Definition, &stored)
	definition := Definition{
		ID:          CategoryID(row.CategoryID),
		Owner:       ModuleID(row.OwnerModuleID),
		Name:        stored.Name,
		Description: "No longer declared by any module or plugin; its data may still exist.",
		Fields:      stored.Fields,
		Subject:     Subject(stored.Subject),
	}
	for _, trigger := range stored.Triggers {
		definition.Triggers = append(definition.Triggers, Trigger(trigger))
	}
	for _, action := range stored.Actions {
		definition.Actions = append(definition.Actions, Action(action))
	}
	if definition.Name == "" {
		definition.Name = row.CategoryID
	}
	return definition
}

// Overview summarises the registry (privacy.read).
func (s *Service) Overview(ctx context.Context, p authorization.Principal) (Overview, error) {
	if !p.Has(authorization.PrivacyRead) {
		return Overview{}, apperror.PermissionDenied
	}
	categories, err := s.categories(ctx)
	if err != nil {
		return Overview{}, err
	}
	settings, err := privacydb.New(s.pool).GetPrivacySettings(ctx)
	if err != nil {
		return Overview{}, err
	}
	overview := Overview{AutomaticRunsEnabled: settings.AutomaticRunsEnabled}
	for _, category := range categories {
		overview.Categories++
		if category.Orphaned {
			overview.OrphanedCategories++
		}
	}
	return overview, nil
}

// GetSettings returns the privacy settings (privacy.read).
func (s *Service) GetSettings(ctx context.Context, p authorization.Principal) (Settings, error) {
	if !p.Has(authorization.PrivacyRead) {
		return Settings{}, apperror.PermissionDenied
	}
	row, err := privacydb.New(s.pool).GetPrivacySettings(ctx)
	if err != nil {
		return Settings{}, err
	}
	return settingsFrom(row), nil
}

// AutomaticRunsEnabled reports the scheduler switch for the retention job.
func (s *Service) AutomaticRunsEnabled(ctx context.Context) (bool, time.Duration, error) {
	row, err := privacydb.New(s.pool).GetPrivacySettings(ctx)
	if err != nil {
		return false, 0, err
	}
	return row.AutomaticRunsEnabled, time.Duration(row.RunIntervalMinutes) * time.Minute, nil
}

func settingsFrom(row privacydb.PrivacySetting) Settings {
	settings := Settings{
		ControllerName:        row.ControllerName,
		ControllerAddress:     row.ControllerAddress,
		DataProtectionContact: row.DataProtectionContact,
		AutomaticRunsEnabled:  row.AutomaticRunsEnabled,
		RunIntervalMinutes:    row.RunIntervalMinutes,
		Version:               row.Version,
	}
	if row.UpdatedAt.Valid {
		at := row.UpdatedAt.Time
		settings.UpdatedAt = &at
	}
	return settings
}

// UpdateSettings changes the settings (privacy.settings.manage), audited as
// privacy.settings_updated with the changed field names only.
func (s *Service) UpdateSettings(
	ctx context.Context,
	p authorization.Principal,
	input SettingsInput,
	requestID *uuid.UUID,
) (Settings, error) {
	if !p.Has(authorization.PrivacySettingsManage) {
		return Settings{}, apperror.PermissionDenied
	}
	input.ControllerName = strings.TrimSpace(input.ControllerName)
	input.ControllerAddress = strings.TrimSpace(input.ControllerAddress)
	input.DataProtectionContact = strings.TrimSpace(input.DataProtectionContact)
	switch {
	case input.ExpectedVersion < 1:
		return Settings{}, apperror.InvalidField("expectedVersion must be at least 1")
	case len(input.ControllerName) > 200:
		return Settings{}, apperror.InvalidField("controllerName can have up to 200 characters")
	case len(input.ControllerAddress) > 1000:
		return Settings{}, apperror.InvalidField("controllerAddress can have up to 1000 characters")
	case len(input.DataProtectionContact) > 500:
		return Settings{}, apperror.InvalidField("dataProtectionContact can have up to 500 characters")
	case input.RunIntervalMinutes < 5 || input.RunIntervalMinutes > 1440:
		return Settings{}, apperror.InvalidField("runIntervalMinutes must be between 5 and 1440")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Settings{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := privacydb.New(tx)
	current, err := q.LockPrivacySettings(ctx)
	if err != nil {
		return Settings{}, err
	}
	if current.Version != input.ExpectedVersion {
		return Settings{}, apperror.StaleWrite
	}
	var changed []string
	if current.ControllerName != input.ControllerName {
		changed = append(changed, "controllerName")
	}
	if current.ControllerAddress != input.ControllerAddress {
		changed = append(changed, "controllerAddress")
	}
	if current.DataProtectionContact != input.DataProtectionContact {
		changed = append(changed, "dataProtectionContact")
	}
	if current.AutomaticRunsEnabled != input.AutomaticRunsEnabled {
		changed = append(changed, "automaticRunsEnabled")
	}
	if current.RunIntervalMinutes != input.RunIntervalMinutes {
		changed = append(changed, "runIntervalMinutes")
	}
	if len(changed) == 0 {
		return settingsFrom(current), nil
	}
	row, err := q.UpdatePrivacySettings(ctx, privacydb.UpdatePrivacySettingsParams{
		ControllerName:        input.ControllerName,
		ControllerAddress:     input.ControllerAddress,
		DataProtectionContact: input.DataProtectionContact,
		AutomaticRunsEnabled:  input.AutomaticRunsEnabled,
		RunIntervalMinutes:    input.RunIntervalMinutes,
		UpdatedByAccountID:    &p.AccountID,
		ExpectedVersion:       input.ExpectedVersion,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Settings{}, apperror.StaleWrite
	}
	if err != nil {
		return Settings{}, err
	}
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &p.AccountID,
		Action:         "privacy.settings_updated",
		ResourceType:   "privacy_settings",
		RequestID:      requestID,
		ChangedFields:  changed,
	}); err != nil {
		return Settings{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Settings{}, err
	}
	return settingsFrom(row), nil
}
