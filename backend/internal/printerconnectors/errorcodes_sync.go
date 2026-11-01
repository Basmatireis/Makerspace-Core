package printerconnectors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/printerconnectors/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	// ErrorCodeSyncInterval is how often the published code list is fetched.
	ErrorCodeSyncInterval = 24 * time.Hour
	// errorCodeSourceMaxBytes bounds the fetched document (the list is about 350 kB).
	errorCodeSourceMaxBytes = 16 << 20
	errorCodeSourceTimeout  = 30 * time.Second
)

var (
	hmsECode   = regexp.MustCompile(`^[0-9A-Fa-f]{16}$`)
	printECode = regexp.MustCompile(`^[0-9A-Fa-f]{8}$`)
)

// ErrorCodeSyncStatus says whether and when the published code list was fetched.
type ErrorCodeSyncStatus struct {
	Enabled       bool
	LastAttemptAt *time.Time
	LastSuccessAt *time.Time
	LastError     *string
	ImportedCount int
}

// FetchedErrorCode is one meaning from the published list, in the form the catalog stores.
type FetchedErrorCode struct {
	SourceFamily string
	Code         string
	Title        string
	Description  string
}

// SetErrorCodeSource sets where the code meanings are fetched from; empty turns the sync off.
func (s *Service) SetErrorCodeSource(url string) {
	s.errorCodeSourceURL = strings.TrimSpace(url)
	s.errorCodeClient = &http.Client{Timeout: errorCodeSourceTimeout}
}

// ParseBambuErrorCodes reads Bambu Lab's published list: data.device_hms.en[] with 16-hex-digit ecodes (the four
// groups of an HMS code) and data.device_error.en[] with 8-hex-digit print error codes. Entries without a text are
// skipped; the first sentence becomes the title, the whole text the description.
func ParseBambuErrorCodes(document []byte) ([]FetchedErrorCode, error) {
	var payload struct {
		Data struct {
			DeviceHMS   map[string]json.RawMessage `json:"device_hms"`
			DeviceError map[string]json.RawMessage `json:"device_error"`
		} `json:"data"`
	}
	if err := json.Unmarshal(document, &payload); err != nil {
		return nil, fmt.Errorf("the code list is not the expected JSON: %w", err)
	}
	type entry struct {
		ECode string `json:"ecode"`
		Intro string `json:"intro"`
	}
	decode := func(raw json.RawMessage) ([]entry, error) {
		if len(raw) == 0 {
			return nil, nil
		}
		var entries []entry
		if err := json.Unmarshal(raw, &entries); err != nil {
			return nil, fmt.Errorf("the code list has an unexpected shape: %w", err)
		}
		return entries, nil
	}
	hms, err := decode(payload.Data.DeviceHMS["en"])
	if err != nil {
		return nil, err
	}
	printErrors, err := decode(payload.Data.DeviceError["en"])
	if err != nil {
		return nil, err
	}
	if len(hms) == 0 && len(printErrors) == 0 {
		return nil, errors.New("the code list carries no English entries")
	}
	result := make([]FetchedErrorCode, 0, len(hms)+len(printErrors))
	seen := map[string]bool{}
	add := func(family, code, intro string) {
		title, description := splitMeaning(intro)
		if title == "" || seen[family+":"+code] {
			return
		}
		seen[family+":"+code] = true
		result = append(result, FetchedErrorCode{SourceFamily: family, Code: code, Title: title, Description: description})
	}
	for _, item := range hms {
		code := strings.ToUpper(strings.TrimSpace(item.ECode))
		if !hmsECode.MatchString(code) {
			continue
		}
		add("hms", code[0:4]+"-"+code[4:8]+"-"+code[8:12]+"-"+code[12:16], item.Intro)
	}
	for _, item := range printErrors {
		code := strings.ToUpper(strings.TrimSpace(item.ECode))
		if !printECode.MatchString(code) {
			continue
		}
		add("print", code, item.Intro)
	}
	return result, nil
}

// splitMeaning makes a short title (the first sentence, at most 160 characters) and keeps the whole text as the
// description (at most 2000 characters).
func splitMeaning(intro string) (title, description string) {
	text := strings.Join(strings.Fields(intro), " ")
	if text == "" {
		return "", ""
	}
	title = text
	if cut := strings.Index(text, ". "); cut > 0 {
		title = text[:cut+1]
	}
	title = clipRunes(title, maxErrorTitle)
	return title, clipRunes(text, maxErrorDescription)
}

func clipRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:limit-1])) + "…"
}

// SyncErrorCodes fetches the published list and stores its meanings: codes the catalog does not know are added,
// earlier fetched meanings are refreshed, meanings written here stay. It records the attempt either way and returns
// how many codes the list carried.
func (s *Service) SyncErrorCodes(ctx context.Context) (int, error) {
	if s.errorCodeSourceURL == "" {
		return 0, apperror.Conflicting("sync_disabled", "Fetching the code list is turned off (PRINTER_ERROR_CODE_SOURCE_URL is empty)")
	}
	now := time.Now().UTC()
	codes, err := s.fetchErrorCodes(ctx)
	if err != nil {
		reason := clipRunes(err.Error(), 500)
		if recordErr := db.New(s.pool).RecordPrinterErrorCodeSyncFailure(ctx, db.RecordPrinterErrorCodeSyncFailureParams{
			At: pgtype.Timestamptz{Time: now, Valid: true}, LastError: &reason,
		}); recordErr != nil {
			return 0, recordErr
		}
		return 0, apperror.New(http.StatusBadGateway, "sync_failed", "The code list could not be fetched: "+reason)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	for _, code := range codes {
		if _, err := q.UpsertFetchedPrinterErrorCode(ctx, db.UpsertFetchedPrinterErrorCodeParams{
			ID: ids.New(), SourceFamily: code.SourceFamily, Code: code.Code, Title: code.Title, Description: code.Description,
		}); err != nil {
			return 0, fmt.Errorf("store fetched code %s: %w", code.Code, err)
		}
	}
	if err := q.RecordPrinterErrorCodeSyncSuccess(ctx, db.RecordPrinterErrorCodeSyncSuccessParams{
		At: pgtype.Timestamptz{Time: now, Valid: true}, ImportedCount: int32(min(len(codes), 1<<30)), //nolint:gosec // bounded
	}); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(codes), nil
}

func (s *Service) fetchErrorCodes(ctx context.Context) ([]FetchedErrorCode, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.errorCodeSourceURL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "makerspace-core")
	client := s.errorCodeClient
	if client == nil {
		client = &http.Client{Timeout: errorCodeSourceTimeout}
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the source answered HTTP %d", response.StatusCode)
	}
	document, err := io.ReadAll(io.LimitReader(response.Body, errorCodeSourceMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(document) > errorCodeSourceMaxBytes {
		return nil, errors.New("the code list is larger than 16 MiB")
	}
	return ParseBambuErrorCodes(document)
}

// SyncErrorCodesNow runs the fetch for a person and audits it.
func (s *Service) SyncErrorCodesNow(ctx context.Context, p authorization.Principal, requestID *uuid.UUID) error {
	if !p.Has(authorization.MachinesManage) {
		return apperror.PermissionDenied
	}
	count, err := s.SyncErrorCodes(ctx)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	actor := p.AccountID
	if err := audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &actor,
		Action:         "printer_error_codes.synced",
		ResourceType:   "printer_error_code",
		RequestID:      requestID,
		Metadata:       map[string]any{"countCodes": fmt.Sprint(count)},
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ErrorCodeSyncStatus reports the state of the automatic fetch.
func (s *Service) ErrorCodeSyncStatus(ctx context.Context) (ErrorCodeSyncStatus, error) {
	row, err := db.New(s.pool).GetPrinterErrorCodeSync(ctx)
	if err != nil {
		return ErrorCodeSyncStatus{}, err
	}
	status := ErrorCodeSyncStatus{Enabled: s.errorCodeSourceURL != "", LastError: row.LastError, ImportedCount: int(row.ImportedCount)}
	if row.LastAttemptAt.Valid {
		at := row.LastAttemptAt.Time.UTC()
		status.LastAttemptAt = &at
	}
	if row.LastSuccessAt.Valid {
		at := row.LastSuccessAt.Time.UTC()
		status.LastSuccessAt = &at
	}
	return status, nil
}
