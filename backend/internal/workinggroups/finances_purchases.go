package workinggroups

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	workinggroupsdb "github.com/Basmatireis/Makerspace-Core/backend/internal/workinggroups/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
)

const (
	MaxPurchaseItemRunes   = 160
	MaxPurchaseLinkRunes   = 300
	MaxDeclineReasonRunes  = 200
	MaxPurchasesPerRequest = 50
	MaxPurchaseQuantity    = 100000
	MaxPurchaseListRows    = 500
)

// purchaseAccess is what the caller is to one purchase.
type purchaseAccess struct {
	finance, member, lead, requester bool
}

// purchaseState is the part of a purchase that decides what can be done with it.
type purchaseState struct {
	status, how string
	estimated   decimal.Decimal
	closed      bool
	// planLocked: a planned purchase of a project that was handed in; only finance managers change it then.
	planLocked bool
}

func planLocked(status, projectStatus string) bool {
	return status == PurchasePlanned && projectStatus != ProjectDraft && projectStatus != ProjectReturned
}

func flagsFor(st purchaseState, a purchaseAccess, threshold decimal.Decimal) (bool, PurchaseFlags) {
	open := !st.closed
	needs := st.estimated.GreaterThanOrEqual(threshold)
	return needs, PurchaseFlags{
		CanApprove:       open && a.finance && st.status == PurchaseWanted && !needs,
		CanDecline:       open && a.finance && st.status == PurchaseWanted,
		CanHandInReceipt: open && st.how == HowSelf && st.status == PurchaseApproved && (a.requester || a.lead || a.finance),
		CanMarkArrived:   open && st.how == HowCentral && st.status == PurchaseOrdered && (a.member || a.finance),
		CanMarkRefunded:  open && a.finance && st.how == HowSelf && st.status == PurchaseBought,
		CanDelete:        open && st.deletableBy(a),
	}
}

func purchaseFromRow(row workinggroupsdb.ListWorkingGroupPurchasesRow, p authorization.Principal, threshold decimal.Decimal) Purchase {
	if row.ProjectRunning {
		// A project that runs is what the project threshold asks for.
		threshold = decimal.NewFromInt(maxMoney).Add(decimal.NewFromInt(1))
	}
	requester := row.RequesterPersonID != nil && *row.RequesterPersonID == p.PersonID
	needs, flags := flagsFor(
		purchaseState{
			status: row.Status, how: row.How, estimated: dbMoney(row.EstimatedTotal), closed: row.PeriodClosed,
			planLocked: planLocked(row.Status, row.ProjectStatus),
		},
		purchaseAccess{finance: isFinance(p), member: row.CallerIsMember, lead: row.CallerIsLead, requester: requester},
		threshold,
	)
	result := Purchase{
		ID: row.ID, GroupID: row.GroupID, GroupName: row.GroupName, PeriodID: row.PeriodID, PeriodName: row.PeriodName,
		PeriodClosed: row.PeriodClosed, Item: row.Item, Link: row.Link, Quantity: row.Quantity,
		UnitPrice: moneyText(dbMoney(row.UnitPrice)), EstimatedTotal: moneyText(dbMoney(row.EstimatedTotal)),
		How: row.How, Status: row.Status, DeclineReason: row.DeclineReason,
		Requester:    personRef(row.RequesterPersonID, row.RequesterDisplayName),
		NeedsProject: needs, HasAttachment: row.HasAttachment, HasReceipt: row.HasReceipt, OrderID: row.OrderID,
		CreatedAt: row.CreatedAt, ApprovedAt: timeValue(row.ApprovedAt), DeclinedAt: timeValue(row.DeclinedAt),
		OrderedAt: timeValue(row.OrderedAt), ReceivedAt: timeValue(row.ReceivedAt), BoughtAt: timeValue(row.BoughtAt),
		RefundedAt: timeValue(row.RefundedAt), ProjectID: row.ProjectID, ProjectItemID: row.ProjectItemID,
		PurchaseFlags: flags, Version: row.Version,
	}
	if row.ReceiptAmount != "" {
		actual := moneyText(dbMoney(row.ReceiptAmount))
		result.ActualTotal = &actual
	}
	return result
}

func (s *Service) queryPurchases(
	ctx context.Context,
	q *workinggroupsdb.Queries,
	p authorization.Principal,
	filter PurchaseFilter,
	id *uuid.UUID,
	limit int32,
) ([]Purchase, error) {
	rules, err := q.GetWorkingGroupFinanceRules(ctx)
	if err != nil {
		return nil, err
	}
	threshold := dbMoney(rules.ProjectThreshold)
	rows, err := q.ListWorkingGroupPurchases(ctx, workinggroupsdb.ListWorkingGroupPurchasesParams{
		CallerFinance: isFinance(p), CallerPersonID: p.PersonID, PurchaseID: id, GroupID: filter.GroupID,
		PeriodID: filter.PeriodID, Status: filter.Status, RowLimit: limit,
	})
	if err != nil {
		return nil, err
	}
	items := make([]Purchase, 0, len(rows))
	for _, row := range rows {
		items = append(items, purchaseFromRow(row, p, threshold))
	}
	return items, nil
}

func (s *Service) loadPurchase(ctx context.Context, q *workinggroupsdb.Queries, p authorization.Principal, id uuid.UUID) (Purchase, error) {
	items, err := s.queryPurchases(ctx, q, p, PurchaseFilter{}, &id, 1)
	if err != nil {
		return Purchase{}, err
	}
	if len(items) == 0 {
		return Purchase{}, apperror.NotFound
	}
	return items[0], nil
}

func validPurchaseStatus(value string) bool {
	switch value {
	case PurchasePlanned, PurchaseWanted, PurchaseApproved, PurchaseDeclined, PurchaseOrdered, PurchaseReceived, PurchaseBought, PurchaseRefunded:
		return true
	}
	return false
}

// ListPurchases lists the purchases the caller may see, newest first; truncated tells when more matched.
func (s *Service) ListPurchases(ctx context.Context, p authorization.Principal, filter PurchaseFilter) ([]Purchase, bool, error) {
	if err := requireRead(p); err != nil {
		return nil, false, err
	}
	if filter.Status != nil && !validPurchaseStatus(*filter.Status) {
		return nil, false, apperror.InvalidField("status")
	}
	items, err := s.queryPurchases(ctx, workinggroupsdb.New(s.pool), p, filter, nil, MaxPurchaseListRows+1)
	if err != nil {
		return nil, false, err
	}
	truncated := len(items) > MaxPurchaseListRows
	if truncated {
		items = items[:MaxPurchaseListRows]
	}
	return items, truncated, nil
}

// GetPurchase returns one purchase; for people who may not see it, it does not exist.
func (s *Service) GetPurchase(ctx context.Context, p authorization.Principal, id uuid.UUID) (Purchase, error) {
	if err := requireRead(p); err != nil {
		return Purchase{}, err
	}
	return s.loadPurchase(ctx, workinggroupsdb.New(s.pool), p, id)
}

func validatePurchaseItem(in PurchaseItemInput) (string, *string, decimal.Decimal, error) {
	item, err := validateShortText(in.Item, "item", MaxPurchaseItemRunes)
	if err == nil {
		err = noControl(item, "item")
	}
	if err != nil {
		return "", nil, decimal.Zero, err
	}
	var link *string
	if in.Link != nil {
		clean := strings.TrimSpace(*in.Link)
		if clean != "" {
			parsed, err := url.Parse(clean)
			if err != nil || parsed.Scheme != "https" || parsed.Host == "" || len([]rune(clean)) > MaxPurchaseLinkRunes {
				return "", nil, decimal.Zero, apperror.InvalidField("link")
			}
			link = &clean
		}
	}
	if in.Quantity < 1 || in.Quantity > MaxPurchaseQuantity {
		return "", nil, decimal.Zero, apperror.InvalidField("quantity")
	}
	price, err := parseMoney(in.UnitPrice, "unitPrice")
	if err != nil {
		return "", nil, decimal.Zero, err
	}
	return item, link, price, nil
}

// CreatePurchases adds purchases to the open period that contains today. Only members of the group may; a finance
// manager who is not a member is refused (403), anybody else does not see the group (404).
func (s *Service) CreatePurchases(
	ctx context.Context,
	p authorization.Principal,
	input CreatePurchasesInput,
	requestID *uuid.UUID,
) (result []Purchase, err error) {
	if err := requireRead(p); err != nil {
		return nil, err
	}
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := workinggroupsdb.New(tx)
		// Membership is decided under the group lock so a member removed meanwhile cannot still request.
		if _, err := q.LockWorkingGroup(ctx, input.GroupID); err != nil {
			return noRows(err)
		}
		member, err := q.IsWorkingGroupMember(ctx, workinggroupsdb.IsWorkingGroupMemberParams{GroupID: input.GroupID, PersonID: p.PersonID})
		if err != nil {
			return err
		}
		if !member {
			if isFinance(p) {
				return apperror.PermissionDenied
			}
			return apperror.NotFound
		}
		if input.How != HowSelf && input.How != HowCentral {
			return apperror.InvalidField("how")
		}
		if len(input.Items) == 0 || len(input.Items) > MaxPurchasesPerRequest {
			return apperror.InvalidField("items")
		}
		type clean struct {
			item  string
			link  *string
			price decimal.Decimal
			qty   int
		}
		cleaned := make([]clean, 0, len(input.Items))
		for _, in := range input.Items {
			item, link, price, err := validatePurchaseItem(in)
			if err != nil {
				return err
			}
			cleaned = append(cleaned, clean{item, link, price, in.Quantity})
		}
		today := s.today()
		periodID, err := q.CurrentWorkingGroupBudgetPeriod(ctx, dateParam(&today))
		if err != nil {
			if errors.Is(noRows(err), apperror.NotFound) {
				return apperror.New(http.StatusUnprocessableEntity, "budget_period_missing", "There is no open budget period for today")
			}
			return err
		}
		created := make([]uuid.UUID, 0, len(cleaned))
		requester := p.PersonID
		planned, err := projectForNewPurchases(ctx, q, p, input)
		if err != nil {
			return err
		}
		for _, c := range cleaned {
			id := ids.New()
			fields := []string{"groupId", "item", "link", "quantity", "unitPrice", "how"}
			if input.ProjectID != nil {
				fields = append(fields, "projectId", "projectItemId")
				params := workinggroupsdb.CreateWorkingGroupPurchaseParams{
					ID: id, GroupID: input.GroupID, PeriodID: periodID, Item: c.item, Link: c.link, Quantity: int32(c.qty),
					UnitPrice: moneyText(c.price), How: input.How, RequesterPersonID: &requester,
				}
				if planned {
					err = q.CreateWorkingGroupPlannedPurchase(ctx, workinggroupsdb.CreateWorkingGroupPlannedPurchaseParams{
						ID: params.ID, GroupID: params.GroupID, PeriodID: params.PeriodID, Item: params.Item, Link: params.Link,
						Quantity: params.Quantity, UnitPrice: params.UnitPrice, How: params.How, RequesterPersonID: params.RequesterPersonID,
						ProjectID: input.ProjectID, ProjectItemID: input.ProjectItemID,
					})
				} else {
					err = q.CreateWorkingGroupPurchase(ctx, params)
					if err == nil {
						err = q.LinkWorkingGroupRunningPurchase(ctx, workinggroupsdb.LinkWorkingGroupRunningPurchaseParams{
							ID: id, ProjectID: input.ProjectID, ProjectItemID: input.ProjectItemID,
						})
					}
				}
			} else {
				err = q.CreateWorkingGroupPurchase(ctx, workinggroupsdb.CreateWorkingGroupPurchaseParams{
					ID: id, GroupID: input.GroupID, PeriodID: periodID, Item: c.item, Link: c.link, Quantity: int32(c.qty),
					UnitPrice: moneyText(c.price), How: input.How, RequesterPersonID: &requester,
				})
			}
			if err != nil {
				return err
			}
			if err := writeTaskAudit(ctx, tx, p, "working_group_purchase.created", "working_group_purchase", id, requestID, fields); err != nil {
				return err
			}
			created = append(created, id)
		}
		result = make([]Purchase, 0, len(created))
		for _, id := range created {
			purchase, err := s.loadPurchase(ctx, q, p, id)
			if err != nil {
				return err
			}
			result = append(result, purchase)
		}
		return nil
	})
	return result, err
}

// purchaseCtx is a purchase locked for a change, with what the caller is to it.
type purchaseCtx struct {
	q         *workinggroupsdb.Queries
	core      workinggroupsdb.LockWorkingGroupPurchaseRow
	access    purchaseAccess
	closed    bool
	threshold decimal.Decimal
}

func (pc *purchaseCtx) state() purchaseState {
	return purchaseState{
		status: pc.core.Status, how: pc.core.How, estimated: dbMoney(pc.core.EstimatedTotal), closed: pc.closed,
		planLocked: planLocked(pc.core.Status, pc.core.ProjectStatus),
	}
}

// lockPurchase takes the group lock, the purchase lock and a share lock on its period, then decides what the caller
// is to the purchase. Whoever may not see it gets 404.
func lockPurchase(ctx context.Context, tx pgx.Tx, p authorization.Principal, id uuid.UUID) (*purchaseCtx, error) {
	q := workinggroupsdb.New(tx)
	groupID, err := q.GetWorkingGroupPurchaseGroup(ctx, id)
	if err != nil {
		return nil, noRows(err)
	}
	if _, err := q.LockWorkingGroup(ctx, groupID); err != nil {
		return nil, noRows(err)
	}
	core, err := q.LockWorkingGroupPurchase(ctx, id)
	if err != nil {
		return nil, noRows(err)
	}
	period, err := q.ShareLockWorkingGroupBudgetPeriod(ctx, core.PeriodID)
	if err != nil {
		return nil, err
	}
	member, err := q.IsWorkingGroupMember(ctx, workinggroupsdb.IsWorkingGroupMemberParams{GroupID: groupID, PersonID: p.PersonID})
	if err != nil {
		return nil, err
	}
	finance := isFinance(p)
	if !member && !finance {
		return nil, apperror.NotFound
	}
	lead, err := q.IsWorkingGroupLead(ctx, workinggroupsdb.IsWorkingGroupLeadParams{GroupID: groupID, PersonID: p.PersonID})
	if err != nil {
		return nil, err
	}
	rules, err := q.GetWorkingGroupFinanceRules(ctx)
	if err != nil {
		return nil, err
	}
	return &purchaseCtx{
		q: q, core: core, closed: period.ClosedAt.Valid, threshold: dbMoney(rules.ProjectThreshold),
		access: purchaseAccess{
			finance: finance, member: member, lead: lead,
			requester: core.RequesterPersonID != nil && *core.RequesterPersonID == p.PersonID,
		},
	}, nil
}

func purchaseStateConflict() error {
	return apperror.Conflicting("working_group_purchase_state", "The purchase cannot be changed this way in its current state")
}

// purchaseChange describes one change of a purchase: who may do it, in which states, and what it does.
type purchaseChange struct {
	role   func(a purchaseAccess) bool
	state  func(pc *purchaseCtx) bool
	change func(tx pgx.Tx, pc *purchaseCtx) (discard []*uuid.UUID, err error)
	reload bool
	// noVersion skips the optimistic lock for a change that only replaces a file.
	noVersion bool
	// allowClosed lets a change through in a closed period (redaction touches no figures).
	allowClosed bool
}

// changePurchase runs a change in one transaction. The order of refusals: unknown or invisible (404), not allowed to
// (403), invalid version (422), closed period (409 budget_period_closed), stale version (409 stale_write), wrong
// state (409). The change and its audit event commit together; replaced files are deleted afterwards.
func (s *Service) changePurchase(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	c purchaseChange,
) (result Purchase, err error) {
	var discard []*uuid.UUID
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		pc, err := lockPurchase(ctx, tx, p, id)
		if err != nil {
			return err
		}
		if !c.role(pc.access) {
			return apperror.PermissionDenied
		}
		if expected < 1 && !c.noVersion {
			return apperror.Invalid("expectedVersion must be positive")
		}
		if pc.closed && !c.allowClosed {
			return periodClosedError()
		}
		if pc.core.Version != expected && !c.noVersion {
			return apperror.StaleWrite
		}
		if !c.state(pc) {
			return purchaseStateConflict()
		}
		if discard, err = c.change(tx, pc); err != nil {
			return err
		}
		if c.reload {
			result, err = s.loadPurchase(ctx, pc.q, p, id)
		}
		return err
	})
	if err == nil {
		s.discardFiles(discard...)
	}
	return result, err
}

func roleFinance(a purchaseAccess) bool         { return a.finance }
func roleMemberOrFinance(a purchaseAccess) bool { return a.member || a.finance }
func roleRequesterLeadFinance(a purchaseAccess) bool {
	return a.requester || a.lead || a.finance
}

func stateIs(status string) func(pc *purchaseCtx) bool {
	return func(pc *purchaseCtx) bool { return pc.core.Status == status }
}

// ApprovePurchase approves a wanted purchase; one that reaches the project threshold cannot be approved.
func (s *Service) ApprovePurchase(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) (Purchase, error) {
	if err := requireRead(p); err != nil {
		return Purchase{}, err
	}
	return s.changePurchase(ctx, p, id, expected, purchaseChange{
		role: roleFinance, state: stateIs(PurchaseWanted), reload: true,
		change: func(tx pgx.Tx, pc *purchaseCtx) ([]*uuid.UUID, error) {
			if !pc.core.ProjectRunning && dbMoney(pc.core.EstimatedTotal).GreaterThanOrEqual(pc.threshold) {
				return nil, apperror.Conflicting("purchase_needs_project", "This purchase needs a project request and cannot be approved")
			}
			if err := pc.q.ApproveWorkingGroupPurchase(ctx, id); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_purchase.approved", "working_group_purchase", id, requestID, []string{"status"})
		},
	})
}

// DeclinePurchase declines a wanted purchase with an optional short reason.
func (s *Service) DeclinePurchase(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	reason *string,
	requestID *uuid.UUID,
) (Purchase, error) {
	if err := requireRead(p); err != nil {
		return Purchase{}, err
	}
	return s.changePurchase(ctx, p, id, expected, purchaseChange{
		role: roleFinance, state: stateIs(PurchaseWanted), reload: true,
		change: func(tx pgx.Tx, pc *purchaseCtx) ([]*uuid.UUID, error) {
			var text *string
			if reason != nil {
				clean, err := validateText(*reason, "reason", MaxDeclineReasonRunes, false)
				if err != nil {
					return nil, err
				}
				if clean != "" {
					text = &clean
				}
			}
			if err := pc.q.DeclineWorkingGroupPurchase(ctx, workinggroupsdb.DeclineWorkingGroupPurchaseParams{ID: id, Reason: text}); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_purchase.declined", "working_group_purchase", id, requestID, []string{"status", "reason"})
		},
	})
}

// MarkPurchaseArrived records that a collectively ordered purchase arrived.
func (s *Service) MarkPurchaseArrived(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) (Purchase, error) {
	if err := requireRead(p); err != nil {
		return Purchase{}, err
	}
	return s.changePurchase(ctx, p, id, expected, purchaseChange{
		role: roleMemberOrFinance, reload: true,
		state: func(pc *purchaseCtx) bool { return pc.core.Status == PurchaseOrdered && pc.core.How == HowCentral },
		change: func(tx pgx.Tx, pc *purchaseCtx) ([]*uuid.UUID, error) {
			if err := pc.q.ReceiveWorkingGroupPurchase(ctx, id); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_purchase.received", "working_group_purchase", id, requestID, []string{"status"})
		},
	})
}

// MarkPurchaseRefunded records that the money of a receipt was returned to the requester.
func (s *Service) MarkPurchaseRefunded(ctx context.Context, p authorization.Principal, id uuid.UUID, expected int64, requestID *uuid.UUID) (Purchase, error) {
	if err := requireRead(p); err != nil {
		return Purchase{}, err
	}
	return s.changePurchase(ctx, p, id, expected, purchaseChange{
		role: roleFinance, state: stateIs(PurchaseBought), reload: true,
		change: func(tx pgx.Tx, pc *purchaseCtx) ([]*uuid.UUID, error) {
			if err := pc.q.RefundWorkingGroupPurchase(ctx, id); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_purchase.refunded", "working_group_purchase", id, requestID, []string{"status"})
		},
	})
}

// DeletePurchase deletes a purchase with its files: the requester while it is wanted, a finance manager while it
// is wanted or declined.
func (s *Service) DeletePurchase(ctx context.Context, p authorization.Principal, id uuid.UUID, requestID *uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	var discard []*uuid.UUID
	err := database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		pc, err := lockPurchase(ctx, tx, p, id)
		if err != nil {
			return err
		}
		if !pc.access.requester && !pc.access.finance {
			return apperror.PermissionDenied
		}
		if pc.closed {
			return periodClosedError()
		}
		if !pc.state().deletableBy(pc.access) {
			return purchaseStateConflict()
		}
		removed, err := pc.q.DeleteWorkingGroupPurchase(ctx, id)
		if err != nil {
			return err
		}
		discard = []*uuid.UUID{removed.AttachmentFileID, removed.ReceiptFileID}
		return writeTaskAudit(ctx, tx, p, "working_group_purchase.deleted", "working_group_purchase", id, requestID, []string{"groupId"})
	})
	if err == nil {
		s.discardFiles(discard...)
	}
	return err
}

func (st purchaseState) deletableBy(a purchaseAccess) bool {
	return (a.requester && (st.status == PurchaseWanted || (st.status == PurchasePlanned && !st.planLocked))) ||
		(a.finance && (st.status == PurchaseWanted || st.status == PurchaseDeclined || st.status == PurchasePlanned))
}

// precheck refuses, before a file is stored, a caller who may not see the purchase (404) or may not hand in files
// for it (403). The real decision is taken again under the locks.
func (s *Service) precheck(ctx context.Context, p authorization.Principal, id uuid.UUID, allowed func(a purchaseAccess) bool) error {
	row, err := workinggroupsdb.New(s.pool).ListWorkingGroupPurchases(ctx, workinggroupsdb.ListWorkingGroupPurchasesParams{
		CallerFinance: isFinance(p), CallerPersonID: p.PersonID, PurchaseID: &id, RowLimit: 1,
	})
	if err != nil {
		return err
	}
	if len(row) == 0 {
		return apperror.NotFound
	}
	access := purchaseAccess{
		finance: isFinance(p), member: row[0].CallerIsMember, lead: row[0].CallerIsLead,
		requester: row[0].RequesterPersonID != nil && *row[0].RequesterPersonID == p.PersonID,
	}
	if !allowed(access) {
		return apperror.PermissionDenied
	}
	return nil
}

// HandInReceipt records the receipt of a self purchase: the actual total and the receipt file. Only the requester,
// the lead of the group and finance managers may; a total that reaches the project threshold is refused.
func (s *Service) HandInReceipt(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input ReceiptInput,
	requestID *uuid.UUID,
) (Purchase, error) {
	if err := requireRead(p); err != nil {
		return Purchase{}, err
	}
	if err := s.precheck(ctx, p, id, roleRequesterLeadFinance); err != nil {
		return Purchase{}, err
	}
	amount, err := parseMoney(input.Amount, "amount")
	if err != nil {
		return Purchase{}, err
	}
	if input.ExpectedVersion < 1 {
		return Purchase{}, apperror.Invalid("expectedVersion must be positive")
	}
	stored, err := s.storeFile(ctx, p, input.File, requestID)
	if err != nil {
		return Purchase{}, err
	}
	result, err := s.changePurchase(ctx, p, id, input.ExpectedVersion, purchaseChange{
		role: roleRequesterLeadFinance, reload: true,
		state: func(pc *purchaseCtx) bool { return pc.core.Status == PurchaseApproved && pc.core.How == HowSelf },
		change: func(tx pgx.Tx, pc *purchaseCtx) ([]*uuid.UUID, error) {
			if !pc.core.ProjectRunning && amount.GreaterThanOrEqual(pc.threshold) {
				return nil, apperror.Conflicting("receipt_needs_project", "A receipt of this amount needs a project request")
			}
			fileID := stored.ID
			if err := pc.q.HandInWorkingGroupPurchaseReceipt(ctx, workinggroupsdb.HandInWorkingGroupPurchaseReceiptParams{
				ID: id, Amount: moneyText(amount), FileID: &fileID,
			}); err != nil {
				return nil, err
			}
			return nil, writeTaskAudit(ctx, tx, p, "working_group_purchase.receipt_added", "working_group_purchase", id, requestID,
				[]string{"status", "receiptAmount", "receiptFile"})
		},
	})
	if err != nil {
		s.discardFiles(&stored.ID)
	}
	return result, err
}

// SetAttachment attaches the offer or cart to a wanted purchase, replacing an earlier file.
func (s *Service) SetAttachment(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	upload FileUpload,
	requestID *uuid.UUID,
) (Purchase, error) {
	if err := requireRead(p); err != nil {
		return Purchase{}, err
	}
	if err := s.precheck(ctx, p, id, roleRequesterLeadFinance); err != nil {
		return Purchase{}, err
	}
	stored, err := s.storeFile(ctx, p, upload, requestID)
	if err != nil {
		return Purchase{}, err
	}
	result, err := s.changePurchase(ctx, p, id, 0, purchaseChange{
		noVersion: true,
		role:      roleRequesterLeadFinance, reload: true,
		state: func(pc *purchaseCtx) bool {
			return pc.core.Status == PurchaseWanted ||
				(pc.core.Status == PurchasePlanned && (!pc.state().planLocked || pc.access.finance))
		},
		change: func(tx pgx.Tx, pc *purchaseCtx) ([]*uuid.UUID, error) {
			fileID := stored.ID
			if err := pc.q.SetWorkingGroupPurchaseAttachment(
				ctx, workinggroupsdb.SetWorkingGroupPurchaseAttachmentParams{ID: id, FileID: &fileID},
			); err != nil {
				return nil, err
			}
			if err := writeTaskAudit(ctx, tx, p, "working_group_purchase.attachment_set", "working_group_purchase", id, requestID, []string{"attachment"}); err != nil {
				return nil, err
			}
			return []*uuid.UUID{pc.core.AttachmentFileID}, nil
		},
	})
	if err != nil {
		s.discardFiles(&stored.ID)
	}
	return result, err
}

// OpenPurchaseFile opens the offer or cart (receipt false) or the receipt of a purchase for whoever may see it.
func (s *Service) OpenPurchaseFile(ctx context.Context, p authorization.Principal, id uuid.UUID, receipt bool) (files.File, io.ReadCloser, error) {
	if err := requireRead(p); err != nil {
		return files.File{}, nil, err
	}
	q := workinggroupsdb.New(s.pool)
	if _, err := s.loadPurchase(ctx, q, p, id); err != nil {
		return files.File{}, nil, err
	}
	core, err := q.GetWorkingGroupPurchaseFiles(ctx, id)
	if err != nil {
		return files.File{}, nil, noRows(err)
	}
	if receipt {
		return s.openFile(ctx, core.ReceiptFileID)
	}
	return s.openFile(ctx, core.AttachmentFileID)
}

// CheckPurchaseUpload is the refusal an upload handler runs before it reads the body: unknown or invisible purchase
// (404), a caller who may not hand in files for it (403).
func (s *Service) CheckPurchaseUpload(ctx context.Context, p authorization.Principal, id uuid.UUID) error {
	if err := requireRead(p); err != nil {
		return err
	}
	return s.precheck(ctx, p, id, roleRequesterLeadFinance)
}

// RedactPurchase removes personal data from a purchase of any status, also in a closed period: the texts become
// "Removed" (link and decline reason are cleared) and/or the offer and receipt files are deleted. The receipt amount
// stays, so no figure changes. Finance managers only.
func (s *Service) RedactPurchase(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	expected int64,
	text, files bool,
	requestID *uuid.UUID,
) (Purchase, error) {
	if err := requireRead(p); err != nil {
		return Purchase{}, err
	}
	return s.changePurchase(ctx, p, id, expected, purchaseChange{
		role: roleFinance, allowClosed: true, reload: true,
		state: func(*purchaseCtx) bool { return true },
		change: func(tx pgx.Tx, pc *purchaseCtx) ([]*uuid.UUID, error) {
			if !text && !files {
				return nil, apperror.InvalidField("text")
			}
			if err := pc.q.RedactWorkingGroupPurchase(ctx, workinggroupsdb.RedactWorkingGroupPurchaseParams{
				ID: id, RedactText: text, RedactFiles: files,
			}); err != nil {
				return nil, err
			}
			var fields []string
			var discard []*uuid.UUID
			if text {
				fields = append(fields, "item", "link", "declineReason")
			}
			if files {
				fields = append(fields, "attachment", "receiptFile")
				discard = []*uuid.UUID{pc.core.AttachmentFileID, pc.core.ReceiptFileID}
			}
			return discard, writeTaskAudit(ctx, tx, p, "working_group_purchase.redacted", "working_group_purchase", id, requestID, fields)
		},
	})
}
