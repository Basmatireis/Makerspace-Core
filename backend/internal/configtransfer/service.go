package configtransfer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime/debug"
	"slices"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/branding"
	configtransferdb "github.com/Basmatireis/Makerspace-Core/backend/internal/configtransfer/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/laborordnung"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/mail"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/printing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/roles"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/staffing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/surveys"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/visitor"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Services are the feature services an import writes through.
type Services struct {
	Files          *files.Service
	ManagedDevices *manageddevices.Service
	Roles          *roles.Service
	MachineLogbook *machinelogbook.Service
	Printing       *printing.Service
	Staffing       *staffing.Service
	Visitor        *visitor.Service
	Branding       *branding.Service
	LabRules       *laborordnung.Service
	Surveys        *surveys.Service
	Mail           *mail.Service
}

type Service struct {
	pool       *pgxpool.Pool
	services   Services
	appVersion string
	now        func() time.Time
}

func NewService(pool *pgxpool.Pool, services Services) *Service {
	return &Service{pool: pool, services: services, appVersion: buildVersion(), now: time.Now}
}

// buildVersion is the module version the binary was built from; it is informational only.
func buildVersion() string {
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version
	}
	return "development"
}

// Export is a configuration file ready for download.
type Export struct {
	Filename string
	Data     []byte
}

// Sections lists every section key in import order.
func Sections() []SectionKey {
	keys := make([]SectionKey, 0, len(registry))
	for _, definition := range registry {
		keys = append(keys, definition.key)
	}
	return keys
}

// selectSections checks the requested keys and returns their definitions in import order.
func selectSections(keys []SectionKey) ([]section, error) {
	if len(keys) == 0 {
		return nil, apperror.InvalidField("choose at least one section")
	}
	chosen := map[SectionKey]bool{}
	for _, key := range keys {
		if _, ok := sectionByKey(key); !ok {
			return nil, apperror.InvalidField("unknown section: " + string(key))
		}
		if chosen[key] {
			return nil, apperror.InvalidField("sections must be unique")
		}
		chosen[key] = true
	}
	selected := make([]section, 0, len(keys))
	for _, definition := range registry {
		if chosen[definition.key] {
			selected = append(selected, definition)
		}
	}
	return selected, nil
}

func authorize(p authorization.Principal, operation authorization.Permission, selected []section, manage bool) error {
	if !p.Has(operation) {
		return apperror.PermissionDenied
	}
	for _, definition := range selected {
		required := definition.read
		if manage {
			required = append(slices.Clone(definition.read), definition.manage...)
		}
		for _, permission := range required {
			if !p.Has(permission) {
				e := apperror.New(http.StatusForbidden, "permission_denied", "Permission denied")
				e.Details["section"] = string(definition.key)
				return e
			}
		}
	}
	return nil
}

// Export writes the chosen sections. Database state is read in one read-only snapshot; stored files (branding assets,
// Lab Rules PDFs) are read after it closes. Secrets are never part of the read model.
func (s *Service) Export(
	ctx context.Context,
	p authorization.Principal,
	keys []SectionKey,
	requestID *uuid.UUID,
) (Export, error) {
	selected, err := selectSections(keys)
	if err != nil {
		return Export{}, err
	}
	if err := authorize(p, authorization.ConfigurationExport, selected, false); err != nil {
		return Export{}, err
	}
	values := make(map[SectionKey]any, len(selected))
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Export{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := configtransferdb.New(tx)
	for _, definition := range selected {
		value, err := definition.export(ctx, q)
		if err != nil {
			return Export{}, fmt.Errorf("export section %s: %w", definition.key, err)
		}
		values[definition.key] = value
	}
	if err := tx.Rollback(ctx); err != nil {
		return Export{}, err
	}
	sections := make(map[SectionKey]json.RawMessage, len(selected))
	for _, definition := range selected {
		value := values[definition.key]
		if definition.attach != nil {
			if value, err = definition.attach(ctx, s.services.Files, value); err != nil {
				return Export{}, fmt.Errorf("attach files of section %s: %w", definition.key, err)
			}
		}
		raw, err := json.Marshal(value)
		if err != nil {
			return Export{}, err
		}
		sections[definition.key] = raw
	}
	now := s.now().UTC().Truncate(time.Second)
	data, err := json.MarshalIndent(file{
		Format:     FormatName,
		Version:    FormatVersion,
		AppVersion: s.appVersion,
		ExportedAt: now,
		Sections:   sections,
	}, "", "  ")
	if err != nil {
		return Export{}, err
	}
	data = append(data, '\n')
	if len(data) > MaxFileBytes {
		return Export{}, apperror.New(
			http.StatusUnprocessableEntity,
			"configuration_export_too_large",
			"The export exceeds 64 MiB; leave out branding or Lab Rules and export them separately",
		)
	}
	actor := p.AccountID
	if err := audit.Write(ctx, s.pool, audit.Event{
		ActorAccountID: &actor,
		Action:         "configuration.exported",
		ResourceType:   "configuration",
		RequestID:      requestID,
		ChangedFields:  sectionNames(selected),
	}); err != nil {
		return Export{}, err
	}
	return Export{Filename: "makerspace-configuration-" + now.Format("2006-01-02") + ".json", Data: data}, nil
}

func sectionNames(selected []section) []string {
	names := make([]string, 0, len(selected))
	for _, definition := range selected {
		names = append(names, string(definition.key))
	}
	return names
}

// Preview runs the import in a transaction that is always rolled back and reports what applying would do, with the
// fingerprint of the current state of the chosen sections.
func (s *Service) Preview(
	ctx context.Context,
	p authorization.Principal,
	mode Mode,
	keys []SectionKey,
	body io.Reader,
) (Report, error) {
	return s.execute(ctx, p, mode, keys, body, "", true, nil)
}

// Apply imports the chosen sections in one transaction. It refuses when the chosen sections changed since the preview
// that produced fingerprint, or when any entry conflicts.
func (s *Service) Apply(
	ctx context.Context,
	p authorization.Principal,
	mode Mode,
	keys []SectionKey,
	fingerprint string,
	body io.Reader,
	requestID *uuid.UUID,
) (Report, error) {
	if fingerprint == "" {
		return Report{}, apperror.InvalidField("fingerprint from the preview is required")
	}
	return s.execute(ctx, p, mode, keys, body, fingerprint, false, requestID)
}

func configurationChanged() *apperror.Error {
	return apperror.Conflicting(
		"configuration_changed",
		"The configuration changed since the preview; preview the import again",
	)
}

func (s *Service) execute(
	ctx context.Context,
	p authorization.Principal,
	mode Mode,
	keys []SectionKey,
	body io.Reader,
	expectedFingerprint string,
	dryRun bool,
	requestID *uuid.UUID,
) (Report, error) {
	if !mode.Valid() {
		return Report{}, apperror.InvalidField("mode must be overwrite or insert")
	}
	selected, err := selectSections(keys)
	if err != nil {
		return Report{}, err
	}
	if err := authorize(p, authorization.ConfigurationImport, selected, true); err != nil {
		return Report{}, err
	}
	parsed, warnings, err := readFile(body)
	if err != nil {
		return Report{}, err
	}
	decoded := make([]any, len(selected))
	for i, definition := range selected {
		raw, ok := parsed.Sections[definition.key]
		if !ok {
			return Report{}, invalidSection(definition.key, "the file does not contain this section")
		}
		if decoded[i], err = definition.decode(raw); err != nil {
			return Report{}, err
		}
	}
	report := Report{
		Mode:       mode,
		AppVersion: parsed.AppVersion,
		ExportedAt: parsed.ExportedAt,
		Sections:   make([]SectionReport, len(selected)),
		Warnings:   append([]string{}, warnings...),
	}
	r := &run{ctx: ctx, p: p, mode: mode, dryRun: dryRun, requestID: requestID, svc: s.services}
	defer func() {
		if !r.committed {
			for _, cleanup := range r.cleanups {
				cleanup()
			}
		}
	}()
	err = s.inImportTransaction(ctx, r, func() error {
		fingerprint, err := currentFingerprint(ctx, r.q, selected)
		if err != nil {
			return err
		}
		report.Fingerprint = fingerprint
		if !dryRun && fingerprint != expectedFingerprint {
			return configurationChanged()
		}
		prunes := make([]func() error, len(selected))
		for i, definition := range selected {
			report.Sections[i].Key = definition.key
			r.report = &report.Sections[i]
			prune, err := definition.apply(r, decoded[i])
			if err != nil {
				return fmt.Errorf("import section %s: %w", definition.key, err)
			}
			prunes[i] = prune
		}
		// Entries missing from the file go last and in reverse order, so an entry is only deleted after the
		// sections that may still reference it were imported.
		if mode == ModeOverwrite {
			for i := len(selected) - 1; i >= 0; i-- {
				if prunes[i] == nil {
					continue
				}
				r.report = &report.Sections[i]
				if err := prunes[i](); err != nil {
					return fmt.Errorf("prune section %s: %w", selected[i].key, err)
				}
			}
		}
		r.report = nil
		if dryRun {
			return errDryRun
		}
		if conflicts := report.Conflicts(); conflicts > 0 {
			e := apperror.Conflicting(
				"configuration_import_conflicts",
				"The import has conflicts; preview it again and resolve them first",
			)
			e.Details["conflicts"] = conflicts
			return e
		}
		for _, section := range report.Sections {
			if err := writeSectionAudit(ctx, r.tx, p, mode, section, requestID); err != nil {
				return err
			}
		}
		return nil
	})
	if errors.Is(err, errDryRun) {
		return report, nil
	}
	if err != nil {
		return Report{}, err
	}
	for _, after := range r.afterCommit {
		after(context.WithoutCancel(ctx))
	}
	report.Applied = true
	return report, nil
}

var errDryRun = errors.New("dry run")

// inImportTransaction runs fn in one serializable transaction and commits unless fn fails. A concurrent change to
// the configuration surfaces as a serialization failure and is reported like a stale fingerprint.
func (s *Service) inImportTransaction(ctx context.Context, r *run, fn func() error) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	r.tx, r.q = tx, configtransferdb.New(tx)
	if err := fn(); err != nil {
		if isSerializationFailure(err) {
			return configurationChanged()
		}
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		if isSerializationFailure(err) {
			return configurationChanged()
		}
		return err
	}
	r.committed = true
	return nil
}

func isSerializationFailure(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40001" || pgErr.Code == "40P01")
}

// currentFingerprint hashes the canonical export of the chosen sections. Stored files contribute their SHA-256, so
// computing it reads no blobs.
func currentFingerprint(ctx context.Context, q *configtransferdb.Queries, selected []section) (string, error) {
	hash := sha256.New()
	for _, definition := range selected {
		value, err := definition.export(ctx, q)
		if err != nil {
			return "", fmt.Errorf("fingerprint section %s: %w", definition.key, err)
		}
		raw, err := json.Marshal(value)
		if err != nil {
			return "", err
		}
		hash.Write([]byte(definition.key))
		hash.Write([]byte{0})
		hash.Write(raw)
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// writeSectionAudit records one privacy-minimized summary per imported section next to the events the services
// wrote for each entry; the action names the mode.
func writeSectionAudit(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	mode Mode,
	section SectionReport,
	requestID *uuid.UUID,
) error {
	action := "configuration.section_overwritten"
	if mode == ModeInsert {
		action = "configuration.section_inserted"
	}
	actor := p.AccountID
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         action,
		ResourceType:   "configuration",
		RequestID:      requestID,
		ChangedFields:  []string{string(section.Key)},
	})
}

// run is the state of one preview or import.
type run struct {
	ctx       context.Context
	tx        pgx.Tx
	q         *configtransferdb.Queries
	p         authorization.Principal
	mode      Mode
	dryRun    bool
	requestID *uuid.UUID
	svc       Services
	report    *SectionReport
	// cleanups remove blobs stored during the transaction when it does not commit.
	cleanups []func()
	// afterCommit deletes files the import replaced.
	afterCommit []func(context.Context)
	committed   bool
}

func (r *run) record(name string, action Action, reason string) {
	r.report.add(Item{Name: name, Action: action, Reason: reason})
}

func (r *run) skip(name, reason string) { r.record(name, ActionSkip, reason) }

func (r *run) keep(name, reason string) { r.record(name, ActionKeep, reason) }

func (r *run) conflict(name, code, reason string) {
	r.report.add(Item{Name: name, Action: ActionConflict, Reason: reason, Code: code})
}

// attempt runs the writes of one entry in a savepoint of the import transaction. A client-visible error rolls the
// savepoint back and becomes a conflict of that entry, so the preview can report every problem at once; any other
// error aborts the import. It reports whether the writes succeeded.
func (r *run) attempt(name string, action Action, reason string, fn func(tx pgx.Tx) error) (bool, error) {
	ok, err := r.try(name, fn)
	if ok {
		r.record(name, action, reason)
	}
	return ok, err
}

// try is attempt without recording success, for entries that need several writes.
func (r *run) try(name string, fn func(tx pgx.Tx) error) (bool, error) {
	savepoint, err := r.tx.Begin(r.ctx)
	if err != nil {
		return false, err
	}
	if err := fn(savepoint); err != nil {
		_ = savepoint.Rollback(r.ctx)
		var appErr *apperror.Error
		if errors.As(err, &appErr) {
			r.conflict(name, appErr.Code, conflictReason(appErr))
			return false, nil
		}
		return false, err
	}
	return true, savepoint.Commit(r.ctx)
}

func conflictReason(err *apperror.Error) string {
	message := err.Message
	if reason, ok := err.Details["reason"].(string); ok && reason != "" {
		message += ": " + reason
	}
	return message
}
