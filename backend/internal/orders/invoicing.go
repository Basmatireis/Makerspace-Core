package orders

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

func dateValue(v string) (pgtype.Date, error) {
	if v == "" {
		return pgtype.Date{}, nil
	}
	t, err := time.Parse("2006-01-02", v)
	if err != nil {
		return pgtype.Date{}, apperror.Invalid("Service period dates must be YYYY-MM-DD")
	}
	return pgtype.Date{Time: t, Valid: true}, nil
}
func dateString(v pgtype.Date) string {
	if !v.Valid {
		return ""
	}
	return v.Time.Format("2006-01-02")
}
func (s *Service) requirements(ctx context.Context, q *db.Queries, org *uuid.UUID) (InvoicingRequirements, error) {
	if org == nil {
		return InvoicingRequirements{}, nil
	}
	r, err := q.GetRequirements(ctx, *org)
	if errors.Is(err, pgx.ErrNoRows) {
		return InvoicingRequirements{}, nil
	}
	return InvoicingRequirements{
		RequirePurchaseOrderReference: r.RequirePurchaseOrderReference,
		Version:                       r.Version,
	}, err
}

func (s *Service) GetRequirements(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
) (InvoicingRequirements, error) {
	if err := require(p, authorization.OrdersRead); err != nil {
		return InvoicingRequirements{}, err
	}
	q := db.New(s.pool)
	if _, err := q.GetOrganization(ctx, id); err != nil {
		return InvoicingRequirements{}, databaseError(err)
	}
	return s.requirements(ctx, q, &id)
}

func (s *Service) UpdateRequirements(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input UpdateInvoicingRequirements,
	requestID *uuid.UUID,
) (InvoicingRequirements, error) {
	if err := require(p, authorization.OrdersRead, authorization.OrganizationsManage); err != nil {
		return InvoicingRequirements{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InvoicingRequirements{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if err = q.LockOrganizationRequirements(ctx, id); err != nil {
		return InvoicingRequirements{}, err
	}
	if _, err = q.GetOrganization(ctx, id); err != nil {
		return InvoicingRequirements{}, databaseError(err)
	}
	old, err := s.requirements(ctx, q, &id)
	if err != nil {
		return old, err
	}
	if old.Version != input.ExpectedVersion {
		return old, apperror.StaleWrite
	}
	r, err := q.SaveRequirements(
		ctx,
		db.SaveRequirementsParams{
			OrganizationID:                id,
			RequirePurchaseOrderReference: input.RequirePurchaseOrderReference,
			UpdatedByAccountID:            &p.AccountID,
		},
	)
	if err != nil {
		return InvoicingRequirements{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"organization.invoicing_requirements_updated",
		"organization",
		id,
		requestID,
		"requirePurchaseOrderReference",
	); err != nil {
		return InvoicingRequirements{}, err
	}
	return InvoicingRequirements{
		RequirePurchaseOrderReference: r.RequirePurchaseOrderReference,
		Version:                       r.Version,
	}, tx.Commit(
		ctx,
	)
}

func (s *Service) saveDetails(
	ctx context.Context,
	q *db.Queries,
	r db.ExternalInvoiceRequest,
	input InvoiceRequestDetails,
	ready bool,
) error {
	old, err := q.GetRequestDetails(ctx, r.ID)
	if err != nil {
		return err
	}
	policy, err := s.requirements(ctx, q, old.RecipientOrganizationID)
	if err != nil {
		return err
	}
	start, err := dateValue(input.ServiceStartsOn)
	if err != nil {
		return err
	}
	end, err := dateValue(input.ServiceEndsOn)
	if err != nil {
		return err
	}
	if start.Valid && end.Valid && start.Time.After(end.Time) {
		return apperror.Invalid("Service period must be ordered")
	}
	fields := []string{
		input.RecipientName,
		input.AddressLine1,
		input.AddressLine2,
		input.PostalCode,
		input.Locality,
		input.Region,
		input.ContactName,
		input.ContactChannel,
		input.PurchaseOrderReference,
	}
	for _, v := range fields {
		if len(v) > 200 {
			return apperror.Invalid("Invoice recipient fields exceed their length limits")
		}
	}
	if len(input.ServiceDescription) > 2000 {
		return apperror.Invalid("Service description is too long")
	}
	if input.ContactPersonID != nil {
		if _, err = q.GetPerson(ctx, *input.ContactPersonID); err != nil {
			return databaseError(err)
		}
	}
	if ready {
		for _, v := range []string{
			input.RecipientName,
			input.AddressLine1,
			input.PostalCode,
			input.Locality,
			input.CountryCode,
			input.ServiceDescription,
		} {
			if strings.TrimSpace(v) == "" {
				return apperror.Invalid("Recipient, billing address, service period and description are required")
			}
		}
		if len(input.CountryCode) != 2 || !start.Valid || !end.Valid {
			return apperror.Invalid("Country code and complete service period are required")
		}
		if CustomerKind(old.RecipientKind) == CustomerOrganization && strings.TrimSpace(input.ContactName) == "" {
			return apperror.Invalid("Organizations require a contact person")
		}
		if policy.RequirePurchaseOrderReference && strings.TrimSpace(input.PurchaseOrderReference) == "" {
			return apperror.Invalid("This organization requires a purchase order reference")
		}
	}
	return q.UpdateRequestDetails(
		ctx,
		db.UpdateRequestDetailsParams{
			RequestID:                     r.ID,
			RecipientName:                 strings.TrimSpace(input.RecipientName),
			AddressLine1:                  strings.TrimSpace(input.AddressLine1),
			AddressLine2:                  strings.TrimSpace(input.AddressLine2),
			PostalCode:                    strings.TrimSpace(input.PostalCode),
			Locality:                      strings.TrimSpace(input.Locality),
			Region:                        strings.TrimSpace(input.Region),
			CountryCode:                   strings.ToUpper(strings.TrimSpace(input.CountryCode)),
			ContactPersonID:               input.ContactPersonID,
			ContactName:                   strings.TrimSpace(input.ContactName),
			ContactChannel:                strings.TrimSpace(input.ContactChannel),
			ServiceStartsOn:               start,
			ServiceEndsOn:                 end,
			ServiceDescription:            strings.TrimSpace(input.ServiceDescription),
			PurchaseOrderReference:        strings.TrimSpace(input.PurchaseOrderReference),
			RequirementsVersion:           policy.Version,
			RequirePurchaseOrderReference: policy.RequirePurchaseOrderReference,
		},
	)
}

func (s *Service) CreateRequest(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input CreateInvoiceRequest,
	requestID *uuid.UUID,
) (ExternalInvoiceRequest, error) {
	if err := require(
		p,
		authorization.OrdersRead,
		authorization.ExternalInvoiceRequestsRead,
		authorization.ExternalInvoiceRequestsManage,
	); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	old, hash, err := beginOperation(ctx, q, p, input.OperationKey, "request.create", struct {
		ID    uuid.UUID
		Input CreateInvoiceRequest
	}{id, input})
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if old != nil && old.RequestID != nil {
		return s.loadRequest(ctx, q, *old.RequestID)
	}
	o, err := q.LockOrder(ctx, id)
	if err != nil {
		return ExternalInvoiceRequest{}, databaseError(err)
	}
	if err = checkVersion(o, input.ExpectedVersion); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if OrderStatus(o.Status) != OrderFinalized || CustomerKind(o.CustomerKind) == CustomerAnonymous {
		return ExternalInvoiceRequest{}, apperror.Conflicting(
			"external_invoice_requires_customer",
			"External invoicing requires a finalized named-customer order",
		)
	}
	if !d(o.TotalAmount).IsPositive() {
		return ExternalInvoiceRequest{}, apperror.Conflicting(
			"nothing_to_invoice",
			"An order that charges nothing cannot be invoiced",
		)
	}
	active, e := q.ActiveRequest(ctx, &id)
	if e == nil {
		return ExternalInvoiceRequest{}, apperror.Conflicting(
			"request_already_exists",
			"An active request already exists: "+active.Reference,
		)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return ExternalInvoiceRequest{}, e
	}
	n, err := q.NextRequestReference(ctx)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	var supersedes *uuid.UUID
	previous, e := q.LatestRequest(ctx, &id)
	if e == nil {
		supersedes = &previous.ID
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return ExternalInvoiceRequest{}, e
	}
	r, err := q.CreateRequest(
		ctx,
		db.CreateRequestParams{
			ID:                  ids.New(),
			Reference:           reference("W", n),
			OrderID:             &id,
			OrderReference:      o.Reference,
			RequestedAmount:     o.TotalAmount,
			SupersedesRequestID: supersedes,
		},
	)
	if err != nil {
		return ExternalInvoiceRequest{}, databaseError(err)
	}
	order, e := s.load(ctx, q, id)
	if e != nil {
		return ExternalInvoiceRequest{}, e
	}
	items := []OrderItem{}
	for _, item := range order.Items {
		if item.RemovedAt == nil {
			items = append(items, item)
		}
	}
	summary, err := json.Marshal(items)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = q.CreateRequestDetails(
		ctx,
		db.CreateRequestDetailsParams{
			RequestID:               r.ID,
			RecipientKind:           o.CustomerKind,
			RecipientPersonID:       o.CustomerPersonID,
			RecipientOrganizationID: o.CustomerOrganizationID,
			ItemSummary:             summary,
		},
	); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	details := input.Details
	if details.RecipientName == "" && order.CustomerName != nil {
		details.RecipientName = *order.CustomerName
	}
	if err = s.saveDetails(ctx, q, r, details, false); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	// An order with cash or card payments may be invoiced; the request records how much was already paid.
	if err = s.syncAlreadyPaid(ctx, q, id); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = q.BumpOrder(ctx, id); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"external_invoice_request.created",
		"external_invoice_request",
		r.ID,
		requestID,
		"details",
	); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = finishOperation(ctx, q, p, input.OperationKey, "request.create", hash, &id, &r.ID); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	v, err := s.loadRequest(ctx, q, r.ID)
	if err != nil {
		return v, err
	}
	return v, databaseError(tx.Commit(ctx))
}
func detailsFromRow(d db.ExternalInvoiceRequestDetail) InvoiceRequestDetails {
	return InvoiceRequestDetails{
		RecipientName:          d.RecipientName,
		AddressLine1:           d.AddressLine1,
		AddressLine2:           d.AddressLine2,
		PostalCode:             d.PostalCode,
		Locality:               d.Locality,
		Region:                 d.Region,
		CountryCode:            d.CountryCode,
		ContactPersonID:        d.ContactPersonID,
		ContactName:            d.ContactName,
		ContactChannel:         d.ContactChannel,
		ServiceStartsOn:        dateString(d.ServiceStartsOn),
		ServiceEndsOn:          dateString(d.ServiceEndsOn),
		ServiceDescription:     d.ServiceDescription,
		PurchaseOrderReference: d.PurchaseOrderReference,
	}
}
func (s *Service) loadRequest(ctx context.Context, q *db.Queries, id uuid.UUID) (ExternalInvoiceRequest, error) {
	r, err := q.GetRequest(ctx, id)
	if err != nil {
		return ExternalInvoiceRequest{}, databaseError(err)
	}
	d, err := q.GetRequestDetails(ctx, id)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	v := ExternalInvoiceRequest{
		ID:                            r.ID,
		Reference:                     r.Reference,
		OrderID:                       r.OrderID,
		OrderReference:                r.OrderReference,
		Provider:                      r.Provider,
		State:                         InvoiceState(r.State),
		Currency:                      r.Currency,
		RequestedAmount:               money(r.RequestedAmount),
		AlreadyPaid:                   money(d.AlreadyPaid),
		Details:                       detailsFromRow(d),
		RequirePurchaseOrderReference: d.RequirePurchaseOrderReference,
		RequirementsVersion:           d.RequirementsVersion,
		SupersedesRequestID:           r.SupersedesRequestID,
		Version:                       r.Version,
		CreatedAt:                     r.CreatedAt,
		ItemSummary:                   []OrderItem{},
		Events:                        []InvoiceRequestEvent{},
	}
	if err = json.Unmarshal(d.ItemSummary, &v.ItemSummary); err != nil {
		return v, err
	}
	delivery, err := q.GetRequestWiRefDelivery(ctx, id)
	switch {
	case err == nil:
		v.WiRefDelivery = &WiRefDelivery{
			Status:      delivery.Status,
			AttemptedAt: delivery.AttemptedAt,
			FailureCode: delivery.FailureCode,
		}
	case !errors.Is(err, pgx.ErrNoRows):
		return v, err
	}
	events, err := q.RequestEvents(ctx, id)
	if err != nil {
		return v, err
	}
	for _, e := range events {
		event := InvoiceRequestEvent{
			ID:                 e.ID,
			Kind:               InvoiceEventKind(e.Kind),
			ExternalReference:  e.ExternalReference,
			ReconciliationKind: ReconciliationKind(e.ReconciliationKind),
			Reason:             e.Reason,
			EffectiveAt:        e.EffectiveAt,
			RecordedAt:         e.RecordedAt,
		}
		if e.ActorPersonID != nil {
			event.RecordedBy = &Actor{ID: *e.ActorPersonID, DisplayName: e.ActorName}
		}
		v.Events = append(v.Events, event)
	}
	return v, nil
}

func (s *Service) GetRequest(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
) (ExternalInvoiceRequest, error) {
	if err := require(p, authorization.ExternalInvoiceRequestsRead); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	return s.loadRequest(ctx, db.New(s.pool), id)
}

func (s *Service) ListRequests(
	ctx context.Context,
	p authorization.Principal,
	search, status string,
	orderID *uuid.UUID,
	page, size int,
) (ExternalInvoiceRequestPage, error) {
	if err := require(p, authorization.ExternalInvoiceRequestsRead); err != nil {
		return ExternalInvoiceRequestPage{}, err
	}
	limit, offset, err := pageBounds(page, size)
	if err != nil {
		return ExternalInvoiceRequestPage{}, err
	}
	q := db.New(s.pool)
	rows, err := q.ListRequests(
		ctx,
		db.ListRequestsParams{Search: search, Status: status, OrderID: orderID, PageLimit: limit, PageOffset: offset},
	)
	if err != nil {
		return ExternalInvoiceRequestPage{}, err
	}
	v := ExternalInvoiceRequestPage{Items: []ExternalInvoiceRequest{}, Page: int64(page), PageSize: int64(size)}
	v.Total, err = q.CountRequests(ctx, db.CountRequestsParams{Search: search, Status: status, OrderID: orderID})
	if err != nil {
		return v, err
	}
	for _, row := range rows {
		r, e := s.loadRequest(ctx, q, row.ID)
		if e != nil {
			return v, e
		}
		v.Items = append(v.Items, r)
	}
	return v, nil
}

// lockRequest always locks the order first, matching payment and reversal ordering.
func lockRequest(ctx context.Context, q *db.Queries, id uuid.UUID) (db.ExternalInvoiceRequest, error) {
	r, err := q.GetRequest(ctx, id)
	if err != nil {
		return r, databaseError(err)
	}
	if r.OrderID != nil {
		if _, err = q.LockOrder(ctx, *r.OrderID); err != nil {
			return r, err
		}
	}
	return q.LockRequest(ctx, id)
}

func (s *Service) UpdateRequest(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input UpdateInvoiceRequest,
	requestID *uuid.UUID,
) (ExternalInvoiceRequest, error) {
	if err := require(p, authorization.OrdersRead, authorization.ExternalInvoiceRequestsRead); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if !p.Has(authorization.ExternalInvoiceRequestsManage) && !p.Has(authorization.ExternalInvoiceRequestsApprove) {
		return ExternalInvoiceRequest{}, apperror.PermissionDenied
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	r, err := lockRequest(ctx, q, id)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if r.Version != input.ExpectedVersion {
		return ExternalInvoiceRequest{}, apperror.StaleWrite
	}
	// Staff edit drafts; only approvers edit a request that awaits approval.
	switch InvoiceState(r.State) {
	case "draft":
		err = require(p, authorization.ExternalInvoiceRequestsManage)
	case "submitted":
		err = require(p, authorization.ExternalInvoiceRequestsApprove)
	default:
		err = apperror.Conflicting(
			"request_frozen",
			"Recipient details can only change while the request is a draft or awaiting approval",
		)
	}
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = s.saveDetails(ctx, q, r, input.Details, false); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = q.TransitionRequest(ctx, db.TransitionRequestParams{ID: id, State: r.State}); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = writeAudit(
		ctx,
		tx,
		p,
		"external_invoice_request.updated",
		"external_invoice_request",
		id,
		requestID,
		"details",
	); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	v, err := s.loadRequest(ctx, q, id)
	if err != nil {
		return v, err
	}
	return v, databaseError(tx.Commit(ctx))
}

// settleByInvoice records the payment that an issued invoice stands for: method external, allocated to the
// order for whatever is still open. Cash and card received earlier keep their own payments.
func (s *Service) settleByInvoice(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	o db.Order,
	r db.ExternalInvoiceRequest,
	op uuid.UUID,
	requestID *uuid.UUID,
) error {
	q := db.New(tx)
	allocated, err := q.SumAllocations(ctx, &o.ID)
	if err != nil {
		return err
	}
	open := d(o.TotalAmount).Sub(d(allocated))
	if !open.IsPositive() {
		return nil
	}
	n, err := q.NextPaymentReference(ctx)
	if err != nil {
		return err
	}
	payment, err := q.InsertPayment(
		ctx,
		db.InsertPaymentParams{
			ID:                       ids.New(),
			Reference:                reference("P", n),
			EntryKind:                string(EntryReceipt),
			Method:                   string(PaymentExternal),
			Amount:                   numeric(open),
			OccurredAt:               time.Now().UTC(),
			ActorAccountID:           &p.AccountID,
			ExternalSource:           "wiRef",
			ExternalReference:        r.Reference,
			ExternalInvoiceRequestID: &r.ID,
			SplitPart:                1,
		},
	)
	if err != nil {
		return databaseError(err)
	}
	if err = s.allocate(ctx, q, p, payment, o, open, op); err != nil {
		return err
	}
	return writeAudit(
		ctx,
		tx,
		p,
		"payment.recorded",
		"payment",
		payment.ID,
		requestID,
		"amount",
		"method",
		"allocations",
	)
}

// reverseInvoiceSettlement undoes the external payments that an invoice request settled, once wiRef confirmed
// the cancellation. The balance of the order opens again.
func (s *Service) reverseInvoiceSettlement(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	o db.Order,
	receipts []db.Payment,
	kind, externalReference string,
	effective time.Time,
	op uuid.UUID,
	requestID *uuid.UUID,
) error {
	q := db.New(tx)
	for _, original := range receipts {
		n, err := q.NextPaymentReference(ctx)
		if err != nil {
			return err
		}
		reasonKind := "external_correction"
		reversal, err := q.InsertPayment(
			ctx,
			db.InsertPaymentParams{
				ID:                       ids.New(),
				Reference:                reference("P", n),
				EntryKind:                string(EntryReversal),
				Method:                   original.Method,
				Amount:                   original.Amount,
				OccurredAt:               effective.UTC(),
				ActorAccountID:           &p.AccountID,
				ReversesPaymentID:        &original.ID,
				ReversedPaymentReference: &original.Reference,
				ReversalReasonKind:       &reasonKind,
				Reason:                   "Invoice cancelled in wiRef (" + kind + ")",
				ExternalSource:           original.ExternalSource,
				ExternalReference:        externalReference,
				ExternalInvoiceRequestID: original.ExternalInvoiceRequestID,
				SplitPart:                original.SplitPart,
			},
		)
		if err != nil {
			return databaseError(err)
		}
		if err = s.allocate(ctx, q, p, original, o, d(original.Amount).Neg(), op); err != nil {
			return err
		}
		if err = writeAudit(
			ctx,
			tx,
			p,
			"payment.reversed",
			"payment",
			reversal.ID,
			requestID,
			"reversal",
			"allocations",
		); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) RequestCommand(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	input InvoiceRequestCommand,
	action InvoiceAction,
	requestID *uuid.UUID,
) (ExternalInvoiceRequest, error) {
	if err := require(p, authorization.OrdersRead, authorization.ExternalInvoiceRequestsRead); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	switch action {
	case InvoiceActionSubmit, InvoiceActionRequestCancellation, InvoiceActionConfirmCancellation:
		if err := require(p, authorization.ExternalInvoiceRequestsManage); err != nil {
			return ExternalInvoiceRequest{}, err
		}
	case InvoiceActionReturn, InvoiceActionForward:
		if err := require(p, authorization.ExternalInvoiceRequestsApprove); err != nil {
			return ExternalInvoiceRequest{}, err
		}
	case InvoiceActionCancel, InvoiceActionReferenceCorrection:
		// Which of the two is needed depends on the state; drafts need manage, a request awaiting approval needs approve.
		if !p.Has(authorization.ExternalInvoiceRequestsManage) && !p.Has(authorization.ExternalInvoiceRequestsApprove) {
			return ExternalInvoiceRequest{}, apperror.PermissionDenied
		}
	default:
		return ExternalInvoiceRequest{}, apperror.Invalid("Unsupported request action")
	}
	input.Reason = strings.TrimSpace(input.Reason)
	input.ExternalReference = strings.TrimSpace(input.ExternalReference)
	if len(input.ExternalReference) > 200 || len(input.Reason) > 500 {
		return ExternalInvoiceRequest{}, apperror.Invalid("Reference or reason is too long")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	kind := "request." + action
	old, hash, err := beginOperation(ctx, q, p, input.OperationKey, string(kind), struct {
		ID    uuid.UUID
		Input InvoiceRequestCommand
	}{id, input})
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if old != nil && old.RequestID != nil {
		return s.loadRequest(ctx, q, *old.RequestID)
	}
	r, err := lockRequest(ctx, q, id)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if r.Version != input.ExpectedVersion {
		return ExternalInvoiceRequest{}, apperror.StaleWrite
	}
	var order *db.Order
	if r.OrderID != nil {
		o, e := q.GetOrder(ctx, *r.OrderID)
		if e != nil {
			return ExternalInvoiceRequest{}, e
		}
		order = &o
	}
	type recorded struct {
		kind                              InvoiceEventKind
		reference, reconciliation, reason string
	}
	effective := input.EffectiveAt
	if effective.IsZero() {
		effective = time.Now().UTC()
	}
	state := InvoiceState(r.State)
	next := state
	events := []recorded{}
	switch action {
	case InvoiceActionSubmit:
		if state != InvoiceDraft {
			return ExternalInvoiceRequest{}, apperror.Conflicting(
				"invalid_request_transition",
				"Only drafts can be submitted for approval",
			)
		}
		if order == nil || OrderStatus(order.Status) != OrderFinalized {
			return ExternalInvoiceRequest{}, apperror.Conflicting(
				"order_not_finalized",
				"The order is no longer finalized",
			)
		}
		details, e := q.GetRequestDetails(ctx, id)
		if e != nil {
			return ExternalInvoiceRequest{}, e
		}
		// The checklist has to be complete. The policy of the organization is captured now.
		if err = s.saveDetails(ctx, q, r, detailsFromRow(details), true); err != nil {
			return ExternalInvoiceRequest{}, err
		}
		if err = s.syncAlreadyPaid(ctx, q, order.ID); err != nil {
			return ExternalInvoiceRequest{}, err
		}
		next = InvoiceSubmitted
		events = append(events, recorded{kind: InvoiceEventSubmitted})
	case InvoiceActionReturn:
		if state != InvoiceSubmitted {
			return ExternalInvoiceRequest{}, apperror.Conflicting(
				"invalid_request_transition",
				"Only requests that await approval can be returned",
			)
		}
		if input.Reason == "" {
			return ExternalInvoiceRequest{}, apperror.Invalid("Say what has to be corrected")
		}
		next = InvoiceDraft
		events = append(events, recorded{kind: InvoiceEventReturned, reason: input.Reason})
	case InvoiceActionForward:
		if state != InvoiceSubmitted {
			return ExternalInvoiceRequest{}, apperror.Conflicting(
				"invalid_request_transition",
				"Only requests that await approval can be forwarded to wiRef",
			)
		}
		if order == nil || OrderStatus(order.Status) != OrderFinalized {
			return ExternalInvoiceRequest{}, apperror.Conflicting(
				"order_not_finalized",
				"The order is no longer finalized",
			)
		}
		details, e := q.GetRequestDetails(ctx, id)
		if e != nil {
			return ExternalInvoiceRequest{}, e
		}
		// Approvers may have edited the details; the checklist must still be complete.
		if err = s.saveDetails(ctx, q, r, detailsFromRow(details), true); err != nil {
			return ExternalInvoiceRequest{}, err
		}
		next = InvoiceIssued
		events = append(events, recorded{kind: InvoiceEventIssued})
		if input.ExternalReference != "" {
			events = append(events, recorded{kind: InvoiceEventReferenceAdded, reference: input.ExternalReference})
		}
		if err = s.settleByInvoice(ctx, tx, p, *order, r, input.OperationKey, requestID); err != nil {
			return ExternalInvoiceRequest{}, err
		}
	case InvoiceActionCancel:
		switch InvoiceState(r.State) {
		case InvoiceDraft:
			err = require(p, authorization.ExternalInvoiceRequestsManage)
		case InvoiceSubmitted:
			err = require(p, authorization.ExternalInvoiceRequestsApprove)
		default:
			err = apperror.Conflicting(
				"external_reconciliation_required",
				"Issued requests require external cancellation evidence",
			)
		}
		if err != nil {
			return ExternalInvoiceRequest{}, err
		}
		next = InvoiceCancelled
		events = append(events, recorded{kind: InvoiceEventCancelled, reason: input.Reason})
	case InvoiceActionRequestCancellation:
		if state != InvoiceIssued {
			return ExternalInvoiceRequest{}, apperror.Conflicting(
				"invalid_request_transition",
				"Only issued requests require external cancellation",
			)
		}
		next = InvoiceCancellationRequested
		events = append(events, recorded{kind: InvoiceEventCancellationRequested, reason: input.Reason})
	case InvoiceActionConfirmCancellation:
		if state != InvoiceCancellationRequested {
			return ExternalInvoiceRequest{}, apperror.Conflicting(
				"invalid_request_transition",
				"Request external cancellation first",
			)
		}
		if input.ExternalReference == "" || input.ReconciliationKind == "" || input.EffectiveAt.IsZero() {
			return ExternalInvoiceRequest{}, apperror.Invalid(
				"External correction kind, reference and date are required",
			)
		}
		switch input.ReconciliationKind {
		case ReconciliationCancellation, ReconciliationCreditNote, ReconciliationCorrectedInvoice,
			ReconciliationReallocation, ReconciliationOther:
		default:
			return ExternalInvoiceRequest{}, apperror.Invalid("Unsupported external accounting procedure")
		}
		next = InvoiceCancelled
		events = append(
			events,
			recorded{
				kind:           InvoiceEventCancelled,
				reference:      input.ExternalReference,
				reconciliation: string(input.ReconciliationKind),
				reason:         input.Reason,
			},
		)
		if order != nil {
			receipts, e := q.ActiveRequestReceipts(
				ctx,
				db.ActiveRequestReceiptsParams{OrderID: &order.ID, ExternalInvoiceRequestID: &id},
			)
			if e != nil {
				return ExternalInvoiceRequest{}, e
			}
			if len(receipts) > 0 {
				// The invoice settled the order; cancelling it gives money back, so the payment permissions apply.
				if err = require(p, authorization.PaymentsRead, authorization.PaymentsReverse); err != nil {
					return ExternalInvoiceRequest{}, err
				}
				if err = s.reverseInvoiceSettlement(
					ctx,
					tx,
					p,
					*order,
					receipts,
					string(input.ReconciliationKind),
					input.ExternalReference,
					effective,
					input.OperationKey,
					requestID,
				); err != nil {
					return ExternalInvoiceRequest{}, err
				}
			}
		}
	case InvoiceActionReferenceCorrection:
		if state != InvoiceIssued && state != InvoiceCancellationRequested {
			return ExternalInvoiceRequest{}, apperror.Conflicting(
				"invalid_request_transition",
				"A wiRef invoice number requires an issued invoice",
			)
		}
		if input.ExternalReference == "" || input.EffectiveAt.IsZero() {
			return ExternalInvoiceRequest{}, apperror.Invalid("Invoice number and date are required")
		}
		has, e := q.RequestHasReference(ctx, id)
		if e != nil {
			return ExternalInvoiceRequest{}, e
		}
		if has {
			if input.Reason == "" {
				return ExternalInvoiceRequest{}, apperror.Invalid("Say why the invoice number changes")
			}
			events = append(
				events,
				recorded{kind: InvoiceEventReferenceCorrected, reference: input.ExternalReference, reason: input.Reason},
			)
		} else {
			events = append(
				events,
				recorded{kind: InvoiceEventReferenceAdded, reference: input.ExternalReference, reason: input.Reason},
			)
		}
	}
	for _, e := range events {
		if err = q.InsertRequestEvent(
			ctx,
			db.InsertRequestEventParams{
				ID:                 ids.New(),
				RequestID:          id,
				Kind:               string(e.kind),
				ExternalReference:  e.reference,
				ReconciliationKind: e.reconciliation,
				Reason:             e.reason,
				EffectiveAt:        effective.UTC(),
				ActorAccountID:     &p.AccountID,
			},
		); err != nil {
			return ExternalInvoiceRequest{}, err
		}
	}
	if err = q.TransitionRequest(ctx, db.TransitionRequestParams{ID: id, State: string(next)}); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if order != nil {
		if err = s.syncAlreadyPaid(ctx, q, order.ID); err != nil {
			return ExternalInvoiceRequest{}, err
		}
		if err = q.BumpOrder(ctx, order.ID); err != nil {
			return ExternalInvoiceRequest{}, err
		}
	}
	auditEvent := events[0].kind
	if err = writeAudit(
		ctx,
		tx,
		p,
		"external_invoice_request."+string(auditEvent),
		"external_invoice_request",
		id,
		requestID,
		"state",
		"events",
	); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = finishOperation(ctx, q, p, input.OperationKey, string(kind), hash, r.OrderID, &id); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	v, err := s.loadRequest(ctx, q, id)
	if err != nil {
		return v, err
	}
	if err = tx.Commit(ctx); err != nil {
		return v, databaseError(err)
	}
	if action == InvoiceActionForward {
		// The mail goes out only after the forwarding is durable; its outcome never undoes the forwarding.
		return s.deliverIssued(ctx, p, v, requestID), nil
	}
	return v, nil
}
