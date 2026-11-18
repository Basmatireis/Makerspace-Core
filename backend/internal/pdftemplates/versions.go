package pdftemplates

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Audit actions. Their details are the export, the version number and an asset id, never document content.
const (
	AuditDraftSaved     = "pdf_template.draft_saved"
	AuditDraftDiscarded = "pdf_template.draft_discarded"
	AuditPublished      = "pdf_template.published"
	AuditRestored       = "pdf_template.restored"
	AuditAssetUploaded  = "pdf_template_asset.uploaded"
	AuditAssetDeleted   = "pdf_template_asset.deleted"
)

const (
	auditTemplate = "pdf_template"
	auditAsset    = "pdf_template_asset"
)

// inTx runs fn in a transaction that also holds the advisory locks of the given exports, in the order given.
func (s *Service) inTx(ctx context.Context, locks []string, fn func(q *db.Queries, tx pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin pdf template transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	for _, lock := range locks {
		if err := q.LockExport(ctx, lock); err != nil {
			return fmt.Errorf("lock pdf template exports: %w", err)
		}
	}
	if err := fn(q, tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit pdf template transaction: %w", err)
	}
	return nil
}

func writeAudit(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	action string,
	kind engine.Kind,
	number int32,
	id uuid.UUID,
	requestID *uuid.UUID,
) error {
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &p.AccountID,
		Action:         action,
		ResourceType:   auditTemplate,
		ResourceID:     &id,
		RequestID:      requestID,
		Metadata: map[string]any{
			"exportKind":      string(kind),
			"templateVersion": strconv.Itoa(int(number)),
		},
	})
}

// SaveDraft stores a document as the draft of an export. The document is read strictly: structural violations
// are a 422 pdf_template_invalid. Problems that a draft may still have (unknown variables, dangling style
// references) are returned with the saved version instead. expectedRevision is the revision of the draft being
// replaced, nil when none exists yet; a draft that changed meanwhile is a 409.
func (s *Service) SaveDraft(
	ctx context.Context,
	p authorization.Principal,
	kind engine.Kind,
	raw []byte,
	expectedRevision *int,
	requestID *uuid.UUID,
) (DraftResult, error) {
	if err := requireManage(p); err != nil {
		return DraftResult{}, err
	}
	if err := validKind(kind); err != nil {
		return DraftResult{}, err
	}
	doc, err := decodeFor(kind, raw)
	if err != nil {
		return DraftResult{}, err
	}
	stored, err := engine.Encode(doc)
	if err != nil {
		return DraftResult{}, err
	}
	result := DraftResult{Problems: engine.Check(doc)}
	err = s.inTx(ctx, []string{string(kind)}, func(q *db.Queries, tx pgx.Tx) error {
		var row db.PdfTemplateVersion
		current, err := q.GetStateVersionForUpdate(ctx, db.GetStateVersionForUpdateParams{
			ExportKind: string(kind), State: string(StateDraft),
		})
		switch {
		case err == nil:
			if expectedRevision == nil || int32(*expectedRevision) != current.Revision {
				return apperror.StaleWrite
			}
			row, err = q.UpdateDraftDocument(ctx, db.UpdateDraftDocumentParams{
				ID: current.ID, Document: stored, ExpectedRevision: current.Revision,
			})
			if err != nil {
				return fmt.Errorf("update pdf template draft: %w", err)
			}
		case errors.Is(err, pgx.ErrNoRows):
			if expectedRevision != nil {
				// The draft was discarded or published meanwhile.
				return apperror.StaleWrite
			}
			row, err = s.insertDraft(ctx, q, p, kind, stored)
			if err != nil {
				return err
			}
		default:
			return fmt.Errorf("load pdf template draft: %w", err)
		}
		if err := writeAudit(ctx, tx, p, AuditDraftSaved, kind, row.Version, row.ID, requestID); err != nil {
			return fmt.Errorf("audit pdf template draft: %w", err)
		}
		loaded, err := loadVersion(ctx, q, row.ID, kind)
		if err != nil {
			return err
		}
		result.Version = loaded
		return nil
	})
	if err != nil {
		return DraftResult{}, err
	}
	return result, nil
}

// insertDraft starts a draft with the next version number of the export. A discarded draft is deleted, so its
// number is reused by the next draft; the audit events of both name different resource ids.
func (s *Service) insertDraft(
	ctx context.Context,
	q *db.Queries,
	p authorization.Principal,
	kind engine.Kind,
	document []byte,
) (db.PdfTemplateVersion, error) {
	next, err := q.NextVersionNumber(ctx, string(kind))
	if err != nil {
		return db.PdfTemplateVersion{}, fmt.Errorf("number pdf template version: %w", err)
	}
	row, err := q.InsertDraft(ctx, db.InsertDraftParams{
		ID: ids.New(), ExportKind: string(kind), Version: next, Document: document, CreatedByAccountID: &p.AccountID,
	})
	if err != nil {
		return db.PdfTemplateVersion{}, fmt.Errorf("insert pdf template draft: %w", err)
	}
	return row, nil
}

func loadVersion(ctx context.Context, q *db.Queries, id uuid.UUID, kind engine.Kind) (Version, error) {
	row, err := q.GetVersion(ctx, db.GetVersionParams{ID: id, ExportKind: string(kind)})
	if err != nil {
		return Version{}, fmt.Errorf("load pdf template version: %w", err)
	}
	return version(row.ID, row.ExportKind, row.Version, row.State, row.Revision, row.CreatedAt, row.UpdatedAt,
		row.PublishedAt, row.CreatedByName, row.PublishedByName, row.Document), nil
}

// DiscardDraft deletes the draft of an export; without a draft it is a 404. It deliberately takes no revision: the
// editor asks the person to confirm before it discards, and the draft is working state, never a published record.
func (s *Service) DiscardDraft(
	ctx context.Context,
	p authorization.Principal,
	kind engine.Kind,
	requestID *uuid.UUID,
) error {
	if err := requireManage(p); err != nil {
		return err
	}
	if err := validKind(kind); err != nil {
		return err
	}
	return s.inTx(ctx, []string{string(kind)}, func(q *db.Queries, tx pgx.Tx) error {
		deleted, err := q.DeleteDraft(ctx, string(kind))
		if errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		}
		if err != nil {
			return fmt.Errorf("delete pdf template draft: %w", err)
		}
		if err := writeAudit(ctx, tx, p, AuditDraftDiscarded, kind, deleted.Version, deleted.ID, requestID); err != nil {
			return fmt.Errorf("audit pdf template draft: %w", err)
		}
		return nil
	})
}

// Publish makes the draft the published version of its export and archives the previous published version. A
// draft with problems of severity error is refused with 422 pdf_template_has_problems and lists them.
func (s *Service) Publish(
	ctx context.Context,
	p authorization.Principal,
	kind engine.Kind,
	expectedRevision int,
	requestID *uuid.UUID,
) (Version, error) {
	if err := requireManage(p); err != nil {
		return Version{}, err
	}
	if err := validKind(kind); err != nil {
		return Version{}, err
	}
	var published Version
	err := s.inTx(ctx, []string{string(kind)}, func(q *db.Queries, tx pgx.Tx) error {
		draft, err := q.GetStateVersionForUpdate(ctx, db.GetStateVersionForUpdateParams{
			ExportKind: string(kind), State: string(StateDraft),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		}
		if err != nil {
			return fmt.Errorf("load pdf template draft: %w", err)
		}
		if int32(expectedRevision) != draft.Revision {
			return apperror.StaleWrite
		}
		doc, err := decodeFor(kind, draft.Document)
		if err != nil {
			return err
		}
		if problems := engine.Check(doc); engine.HasErrors(problems) {
			return hasProblems(problems)
		}
		// An image may have been deleted since the draft was saved; the export lock held here keeps DeleteAsset
		// (which takes every export lock) from removing one meanwhile.
		if referenced := engine.ReferencedAssets(doc); len(referenced) > 0 {
			ids := make([]uuid.UUID, 0, len(referenced))
			for _, id := range referenced {
				ids = append(ids, uuid.MustParse(id))
			}
			found, err := q.AssetsExist(ctx, ids)
			if err != nil {
				return fmt.Errorf("check pdf template assets: %w", err)
			}
			if int(found) != len(ids) {
				return hasProblems([]engine.Problem{{
					Severity: engine.SeverityError,
					Message:  "The template uses an uploaded image that no longer exists; remove it or upload it again",
				}})
			}
		}
		if _, err := q.ArchivePublished(ctx, string(kind)); err != nil {
			return fmt.Errorf("archive published pdf template: %w", err)
		}
		row, err := q.PublishDraft(ctx, db.PublishDraftParams{
			ID: draft.ID, ExpectedRevision: draft.Revision, PublishedByAccountID: &p.AccountID,
		})
		if err != nil {
			return fmt.Errorf("publish pdf template draft: %w", err)
		}
		if err := writeAudit(ctx, tx, p, AuditPublished, kind, row.Version, row.ID, requestID); err != nil {
			return fmt.Errorf("audit pdf template publication: %w", err)
		}
		published, err = loadVersion(ctx, q, row.ID, kind)
		return err
	})
	if err != nil {
		return Version{}, err
	}
	return published, nil
}

// hasProblems is the 422 of a publication refused because of errors in the template; the details list them.
func hasProblems(problems []engine.Problem) error {
	err := apperror.New(
		http.StatusUnprocessableEntity, CodeHasProblems, "The template has problems that must be fixed before publishing",
	)
	listed := make([]map[string]any, 0, len(problems))
	for _, problem := range problems {
		if problem.Severity == engine.SeverityError {
			listed = append(listed, map[string]any{"nodeId": problem.NodeID, "message": problem.Message})
		}
	}
	err.Details["problems"] = listed
	return err
}

// Restore copies a version into the draft of its export: it replaces an existing draft or starts a new one.
// Restoring the draft itself is a 409. Replacing the draft takes no revision check, deliberately: the editor asks
// the person to confirm that the current draft is overwritten.
func (s *Service) Restore(
	ctx context.Context,
	p authorization.Principal,
	kind engine.Kind,
	id uuid.UUID,
	requestID *uuid.UUID,
) (Version, error) {
	if err := requireManage(p); err != nil {
		return Version{}, err
	}
	if err := validKind(kind); err != nil {
		return Version{}, err
	}
	var restored Version
	err := s.inTx(ctx, []string{string(kind)}, func(q *db.Queries, tx pgx.Tx) error {
		source, err := q.GetVersionForUpdate(ctx, db.GetVersionForUpdateParams{ID: id, ExportKind: string(kind)})
		if errors.Is(err, pgx.ErrNoRows) {
			return apperror.NotFound
		}
		if err != nil {
			return fmt.Errorf("load pdf template version: %w", err)
		}
		if State(source.State) == StateDraft {
			return apperror.Conflicting(CodeVersionIsDraft, "The draft is already the working version")
		}
		var row db.PdfTemplateVersion
		current, err := q.GetStateVersionForUpdate(ctx, db.GetStateVersionForUpdateParams{
			ExportKind: string(kind), State: string(StateDraft),
		})
		switch {
		case err == nil:
			row, err = q.UpdateDraftDocumentAnyRevision(ctx, db.UpdateDraftDocumentAnyRevisionParams{
				ID: current.ID, Document: source.Document,
			})
			if err != nil {
				return fmt.Errorf("replace pdf template draft: %w", err)
			}
		case errors.Is(err, pgx.ErrNoRows):
			row, err = s.insertDraft(ctx, q, p, kind, source.Document)
			if err != nil {
				return err
			}
		default:
			return fmt.Errorf("load pdf template draft: %w", err)
		}
		// The audit event names the version that was restored, which is what an administrator looks for.
		if err := writeAudit(ctx, tx, p, AuditRestored, kind, source.Version, row.ID, requestID); err != nil {
			return fmt.Errorf("audit pdf template restore: %w", err)
		}
		restored, err = loadVersion(ctx, q, row.ID, kind)
		return err
	})
	if err != nil {
		return Version{}, err
	}
	return restored, nil
}
