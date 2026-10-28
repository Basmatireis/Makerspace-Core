package main

import (
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/inbox"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacy"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/privacycatalog"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/runrecordings"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/jackc/pgx/v5/pgxpool"
)

// categoryList collects repeated --category flags.
type categoryList []string

func (c *categoryList) String() string { return strings.Join(*c, ",") }

func (c *categoryList) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return errors.New("category must not be empty")
	}
	*c = append(*c, value)
	return nil
}

func (c categoryList) ids() []privacy.CategoryID {
	result := make([]privacy.CategoryID, 0, len(c))
	for _, value := range c {
		result = append(result, privacy.CategoryID(value))
	}
	return result
}

// newRetentionEngine builds the privacy service with the built-in retention
// handlers, exactly as the API process does, so `admin cleanup` runs the same
// code as the scheduler.
func newRetentionEngine(
	pool *pgxpool.Pool,
	cfg config.Config,
	store storage.Store,
	auditRetention, eventSignupRetention time.Duration,
) (*privacy.Service, error) {
	privacyCatalog, err := privacycatalog.Catalog()
	if err != nil {
		return nil, err
	}
	service := privacy.NewService(pool, privacyCatalog)
	fileService := files.NewService(pool, store)
	logbook := machinelogbook.NewService(pool, inbox.NewEmitter())
	recordings := runrecordings.NewService(pool, fileService, logbook, cfg.PrinterTimelapseMaxBytes)
	privacycatalog.RegisterBuiltinHandlers(service, recordings, privacy.LegacyPeriods{
		AuditRetention:       &auditRetention,
		EventSignupRetention: &eventSignupRetention,
	})
	return service, nil
}
