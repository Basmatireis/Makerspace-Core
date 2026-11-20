package workinggroups

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func ptr[T any](v T) *T { return &v }

func checklistOpen(open []string) error {
	err := apperror.Conflicting("project_checklist_open", "The project cannot be handed in yet")
	err.Details["open"] = open
	return err
}

func (s *Service) setStatus(
	ctx context.Context,
	tx pgx.Tx,
	pc *projectCtx,
	p authorization.Principal,
	id uuid.UUID,
	status, reason, action string,
	requestID *uuid.UUID,
) error {
	if err := pc.q.SetWorkingGroupProjectStatus(ctx, workinggroupsdb.SetWorkingGroupProjectStatusParams{ID: id, Status: status}); err != nil {
		return err
	}
	if err := addProjectHistory(ctx, pc.q, p, id, status, reason); err != nil {
		return err
	}
	fields := []string{"status"}
	if reason != "" {
		fields = append(fields, "reason")
	}
	return writeTaskAudit(ctx, tx, p, action, "working_group_project", id, requestID, fields)
}

// startRunning turns the planned purchases of a project that starts into approved ones, in the period open today.
func (s *Service) startRunning(ctx context.Context, pc *projectCtx, id uuid.UUID) error {
	purchases, err := pc.q.ListWorkingGroupProjectPurchases(ctx, &id)
	if err != nil {
		return err
	}
	planned := false
	for _, pu := range purchases {
		planned = planned || pu.Status == PurchasePlanned
	}
	if !planned {
		return nil
	}
	today := s.today()
	periodID, err := pc.q.CurrentWorkingGroupBudgetPeriod(ctx, dateParam(&today))
	if err != nil {
		if errors.Is(noRows(err), apperror.NotFound) {
			return errNoPeriod
		}
		return err
	}
	if _, err := pc.q.ShareLockWorkingGroupBudgetPeriod(ctx, periodID); err != nil {
		return err
	}
	return pc.q.StartWorkingGroupProjectPurchases(ctx, workinggroupsdb.StartWorkingGroupProjectPurchasesParams{ProjectID: &id, PeriodID: periodID})
}

// SubmitProject hands a draft or returned project in. It is refused (409 project_checklist_open) while the checklist
// has open points.
func (s *Service) SubmitProject(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	if expected < 1 {
		return Project{}, apperror.Invalid("expectedVersion must be positive")
	}
	err := s.changeProject(ctx, p, id, projectChange{
		role: roleFields, state: func(pc *projectCtx) bool { return pc.editFields() }, version: expected, keepVersion: true,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			project, err := s.loadProject(ctx, pc.q, p, id)
			if err != nil {
				return nil, err
			}
			if !project.Checklist.Complete {
				return nil, checklistOpen(project.Checklist.Open)
			}
			return nil, s.setStatus(ctx, tx, pc, p, id, ProjectSubmitted, "", "working_group_project.submitted", requestID)
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, id)
}

func (s *Service) decide(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	reason, status, action string,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	if expected < 1 {
		return Project{}, apperror.Invalid("expectedVersion must be positive")
	}
	err := s.changeProject(ctx, p, id, projectChange{
		role: roleFinanceP, state: projectIs(ProjectSubmitted), version: expected, keepVersion: true,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			clean, err := validateText(reason, "reason", MaxProjectReasonRunes, true)
			if err != nil {
				return nil, err
			}
			return nil, s.setStatus(ctx, tx, pc, p, id, status, clean, action, requestID)
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, id)
}

// ReturnProject sends a submitted project back for changes with a reason.
func (s *Service) ReturnProject(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	reason string,
	requestID *uuid.UUID,
) (Project, error) {
	return s.decide(ctx, p, id, expected, reason, ProjectReturned, "working_group_project.returned", requestID)
}

// DeclineProject declines a submitted project with a reason.
func (s *Service) DeclineProject(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	reason string,
	requestID *uuid.UUID,
) (Project, error) {
	return s.decide(ctx, p, id, expected, reason, ProjectDeclined, "working_group_project.declined", requestID)
}

// ApproveProject approves a submitted project. When the wiRef has to decide, the project waits in `wiref` and the
// Projektantrag is mailed after the commit; otherwise it runs and its planned purchases are approved.
func (s *Service) ApproveProject(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input ApproveProjectInput,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	if err := s.precheckProject(ctx, p, id, roleFinanceP); err != nil {
		return Project{}, err
	}
	if input.ExpectedVersion < 1 {
		return Project{}, apperror.Invalid("expectedVersion must be positive")
	}
	if input.PaidFrom != PaidFromGroup && input.PaidFrom != PaidFromExternal {
		return Project{}, apperror.InvalidField("paidFrom")
	}
	q := workinggroupsdb.New(s.pool)
	project, err := s.loadProject(ctx, q, p, id)
	if err != nil {
		return Project{}, err
	}
	form, signature, err := s.buildRequestForm(ctx, q, p, project, input.Form)
	if err != nil {
		return Project{}, err
	}
	formJSON, err := json.Marshal(form)
	if err != nil {
		return Project{}, err
	}
	var storedSignature *uuid.UUID
	if len(signature) > 0 {
		file, err := s.storeSignature(ctx, p, signature, requestID)
		if err != nil {
			return Project{}, err
		}
		storedSignature = &file.ID
	}
	signer := p.PersonID
	needed := false
	err = s.changeProject(ctx, p, id, projectChange{
		role: roleFinanceP, state: projectIs(ProjectSubmitted), version: input.ExpectedVersion, keepVersion: true,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			needed = wirefNeeded(input.PaidFrom, dbMoney(pc.core.PlannedTotal), dbMoney(pc.rules.ProjectThreshold))
			if needed && storedSignature == nil {
				return nil, apperror.New(422, "signature_required", "A project that needs the wiRef needs a signature")
			}
			if err := pc.q.SetWorkingGroupProjectRequest(ctx, workinggroupsdb.SetWorkingGroupProjectRequestParams{
				ID: id, Form: string(formJSON), SignatureFileID: storedSignature, SignedBy: &signer, PaidFrom: input.PaidFrom,
			}); err != nil {
				return nil, err
			}
			if pc.core.AdvanceRequested {
				if err := pc.q.SetWorkingGroupProjectAdvanceAsked(ctx, id); err != nil {
					return nil, err
				}
			}
			status := ProjectRunning
			if needed {
				status = ProjectWiRef
			} else if err := s.startRunning(ctx, pc, id); err != nil {
				return nil, err
			}
			if err := addProjectHistory(ctx, pc.q, p, id, "paid_from", input.PaidFrom); err != nil {
				return nil, err
			}
			return []*uuid.UUID{pc.core.RequestSignatureFileID}, s.setStatus(ctx, tx, pc, p, id, status, "",
				"working_group_project.approved", requestID)
		},
	})
	if err != nil {
		s.discardFiles(storedSignature)
		return Project{}, err
	}
	if needed {
		// The decision is committed; a mail that cannot be sent leaves the request pending for send-to-wiref.
		_ = s.sendRequest(ctx, p, id, requestID, RequestFormInput{})
	}
	return s.reloaded(ctx, p, id)
}

// RecordWiRefDecision stores the number and the chosen offers of the wiRef's decision and starts the project.
func (s *Service) RecordWiRefDecision(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input WiRefDecisionInput,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	if input.ExpectedVersion < 1 {
		return Project{}, apperror.Invalid("expectedVersion must be positive")
	}
	err := s.changeProject(ctx, p, id, projectChange{
		role: roleFinanceP, state: projectIs(ProjectWiRef), version: input.ExpectedVersion, keepVersion: true,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			number, err := validateShortText(input.Number, "number", MaxProjectNumberRunes)
			if err != nil {
				return nil, err
			}
			items, err := pc.q.ListWorkingGroupProjectItems(ctx, id)
			if err != nil {
				return nil, err
			}
			offers, err := pc.q.ListWorkingGroupProjectOffers(ctx, id)
			if err != nil {
				return nil, err
			}
			itemOffers := map[uuid.UUID]map[uuid.UUID]bool{}
			for _, o := range offers {
				if itemOffers[o.ItemID] == nil {
					itemOffers[o.ItemID] = map[uuid.UUID]bool{}
				}
				itemOffers[o.ItemID][o.ID] = true
			}
			chosen := map[uuid.UUID]uuid.UUID{}
			for _, c := range input.ChosenOffers {
				if !itemOffers[c.ItemID][c.OfferID] {
					return nil, apperror.InvalidField("chosenOffers")
				}
				if _, dup := chosen[c.ItemID]; dup {
					return nil, apperror.InvalidField("chosenOffers")
				}
				chosen[c.ItemID] = c.OfferID
			}
			offersThreshold := dbMoney(pc.rules.OffersThreshold)
			for _, it := range items {
				if _, ok := chosen[it.ID]; !ok && dbMoney(it.PlannedAmount).GreaterThanOrEqual(offersThreshold) && len(itemOffers[it.ID]) > 0 {
					return nil, apperror.InvalidField("chosenOffers")
				}
			}
			for itemID, offerID := range chosen {
				params := workinggroupsdb.ChooseWorkingGroupProjectOfferParams{ItemID: itemID, OfferID: &offerID}
				if err := pc.q.ChooseWorkingGroupProjectOffer(ctx, params); err != nil {
					return nil, err
				}
			}
			if err := pc.q.SetWorkingGroupProjectWiRef(ctx, workinggroupsdb.SetWorkingGroupProjectWiRefParams{ID: id, Number: &number}); err != nil {
				return nil, err
			}
			if err := s.startRunning(ctx, pc, id); err != nil {
				return nil, err
			}
			if err := addProjectHistory(ctx, pc.q, p, id, ProjectRunning, ""); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_project.wiref_decided", "working_group_project", id, requestID,
				[]string{"status", "wirefNumber", "chosenOffers", "plannedAmount"})
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, id)
}

// SetProjectPaidFrom changes who pays, at any time before the project is closed.
func (s *Service) SetProjectPaidFrom(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	paidFrom, reason string,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	if expected < 1 {
		return Project{}, apperror.Invalid("expectedVersion must be positive")
	}
	err := s.changeProject(ctx, p, id, projectChange{
		role: roleFinanceP, version: expected, keepVersion: true,
		state: projectIs(ProjectDraft, ProjectSubmitted, ProjectReturned, ProjectWiRef, ProjectRunning),
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			if paidFrom != PaidFromGroup && paidFrom != PaidFromExternal {
				return nil, apperror.InvalidField("paidFrom")
			}
			clean, err := validateText(reason, "reason", MaxProjectReasonRunes, false)
			if err != nil {
				return nil, err
			}
			if err := pc.q.SetWorkingGroupProjectPaidFrom(ctx, workinggroupsdb.SetWorkingGroupProjectPaidFromParams{ID: id, PaidFrom: &paidFrom}); err != nil {
				return nil, err
			}
			text := paidFrom
			if clean != "" {
				text += ": " + clean
			}
			if err := addProjectHistory(ctx, pc.q, p, id, "paid_from", text); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_project.paid_from_changed", "working_group_project", id, requestID,
				[]string{"paidFrom", "reason"})
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, id)
}

// MarkProjectAdvanceReceived records that the advance arrived.
func (s *Service) MarkProjectAdvanceReceived(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	if expected < 1 {
		return Project{}, apperror.Invalid("expectedVersion must be positive")
	}
	err := s.changeProject(ctx, p, id, projectChange{
		role: roleFinanceP, version: expected, keepVersion: true,
		state: func(pc *projectCtx) bool {
			return pc.core.AdvanceRequested && pc.core.AdvanceStatus == AdvanceAsked && (pc.status() == ProjectWiRef || pc.status() == ProjectRunning)
		},
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			params := workinggroupsdb.SetWorkingGroupProjectAdvanceParams{ID: id, AdvanceStatus: ptr(AdvanceReceived)}
			if err := pc.q.SetWorkingGroupProjectAdvance(ctx, params); err != nil {
				return nil, err
			}
			if err := addProjectHistory(ctx, pc.q, p, id, "advance_received", ""); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_project.advance_received", "working_group_project", id, requestID, []string{"advanceStatus"})
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, id)
}

// CompleteProject closes a running project with an optional report: the lead of the group or a finance manager.
func (s *Service) CompleteProject(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	report string,
	requestID *uuid.UUID,
) (Project, error) {
	if err := requireRead(p); err != nil {
		return Project{}, err
	}
	if expected < 1 {
		return Project{}, apperror.Invalid("expectedVersion must be positive")
	}
	err := s.changeProject(ctx, p, id, projectChange{
		role: func(pc *projectCtx) bool { return pc.lead || pc.finance }, state: projectIs(ProjectRunning), version: expected, keepVersion: true,
		change: func(tx pgx.Tx, pc *projectCtx) ([]*uuid.UUID, error) {
			clean, err := validateText(report, "report", MaxProjectReportRunes, false)
			if err != nil {
				return nil, err
			}
			var text *string
			if clean != "" {
				text = &clean
			}
			if err := pc.q.CompleteWorkingGroupProject(ctx, workinggroupsdb.CompleteWorkingGroupProjectParams{ID: id, Report: text}); err != nil {
				return nil, err
			}
			if err := addProjectHistory(ctx, pc.q, p, id, ProjectCompleted, ""); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_project.completed", "working_group_project", id, requestID, []string{"status", "report"})
		},
	})
	if err != nil {
		return Project{}, err
	}
	return s.reloaded(ctx, p, id)
}
