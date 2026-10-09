package orders

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

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
		return pgtype.Date{}, validation("Service period dates must be YYYY-MM-DD")
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
	return InvoicingRequirements{RequirePurchaseOrderReference: r.RequirePurchaseOrderReference, Version: r.Version}, err
}
func (s *Service) GetRequirements(ctx context.Context, p authorization.Principal, id uuid.UUID) (InvoicingRequirements, error) {
	if err := require(p, authorization.OrdersRead); err != nil {
		return InvoicingRequirements{}, err
	}
	q := db.New(s.pool)
	if _, err := q.GetOrganization(ctx, id); err != nil {
		return InvoicingRequirements{}, databaseError(err)
	}
	return s.requirements(ctx, q, &id)
}
func (s *Service) UpdateRequirements(ctx context.Context, p authorization.Principal, id uuid.UUID, input UpdateInvoicingRequirements, requestID *uuid.UUID) (InvoicingRequirements, error) {
	if err := require(p, authorization.OrdersRead, authorization.OrganizationsManage); err != nil {
		return InvoicingRequirements{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return InvoicingRequirements{}, err
	}
	defer tx.Rollback(ctx)
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
	r, err := q.SaveRequirements(ctx, db.SaveRequirementsParams{OrganizationID: id, RequirePurchaseOrderReference: input.RequirePurchaseOrderReference, UpdatedByAccountID: &p.AccountID})
	if err != nil {
		return InvoicingRequirements{}, err
	}
	if err = writeAudit(ctx, tx, p, "organization.invoicing_requirements_updated", "organization", id, requestID, "requirePurchaseOrderReference"); err != nil {
		return InvoicingRequirements{}, err
	}
	return InvoicingRequirements{RequirePurchaseOrderReference: r.RequirePurchaseOrderReference, Version: r.Version}, tx.Commit(ctx)
}
func (s *Service) saveDetails(ctx context.Context, q *db.Queries, r db.ExternalInvoiceRequest, input InvoiceRequestDetails, ready bool) error {
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
		return validation("Service period must be ordered")
	}
	fields := []string{input.RecipientName, input.AddressLine1, input.AddressLine2, input.PostalCode, input.Locality, input.Region, input.ContactName, input.ContactChannel, input.PurchaseOrderReference}
	for _, v := range fields {
		if len(v) > 200 {
			return validation("Invoice recipient fields exceed their length limits")
		}
	}
	if len(input.ServiceDescription) > 2000 {
		return validation("Service description is too long")
	}
	if input.ContactPersonID != nil {
		if _, err = q.GetPerson(ctx, *input.ContactPersonID); err != nil {
			return databaseError(err)
		}
	}
	if ready {
		for _, v := range []string{input.RecipientName, input.AddressLine1, input.PostalCode, input.Locality, input.CountryCode, input.ServiceDescription} {
			if strings.TrimSpace(v) == "" {
				return validation("Recipient, billing address, service period and description are required")
			}
		}
		if len(input.CountryCode) != 2 || !start.Valid || !end.Valid {
			return validation("Country code and complete service period are required")
		}
		if old.RecipientKind == "organization" && strings.TrimSpace(input.ContactName) == "" {
			return validation("Organizations require a contact person")
		}
		if policy.RequirePurchaseOrderReference && strings.TrimSpace(input.PurchaseOrderReference) == "" {
			return validation("This organization requires a purchase order reference")
		}
	}
	return q.UpdateRequestDetails(ctx, db.UpdateRequestDetailsParams{RequestID: r.ID, RecipientName: strings.TrimSpace(input.RecipientName), AddressLine1: strings.TrimSpace(input.AddressLine1), AddressLine2: strings.TrimSpace(input.AddressLine2), PostalCode: strings.TrimSpace(input.PostalCode), Locality: strings.TrimSpace(input.Locality), Region: strings.TrimSpace(input.Region), CountryCode: strings.ToUpper(strings.TrimSpace(input.CountryCode)), ContactPersonID: input.ContactPersonID, ContactName: strings.TrimSpace(input.ContactName), ContactChannel: strings.TrimSpace(input.ContactChannel), ServiceStartsOn: start, ServiceEndsOn: end, ServiceDescription: strings.TrimSpace(input.ServiceDescription), PurchaseOrderReference: strings.TrimSpace(input.PurchaseOrderReference), RequirementsVersion: policy.Version, RequirePurchaseOrderReference: policy.RequirePurchaseOrderReference})
}
func (s *Service) CreateRequest(ctx context.Context, p authorization.Principal, id uuid.UUID, input CreateInvoiceRequest, requestID *uuid.UUID) (ExternalInvoiceRequest, error) {
	if err := require(p, authorization.OrdersRead, authorization.ExternalInvoiceRequestsRead, authorization.ExternalInvoiceRequestsManage); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	defer tx.Rollback(ctx)
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
	if o.Status != "finalized" || o.CustomerKind == "anonymous" {
		return ExternalInvoiceRequest{}, conflict("external_invoice_requires_customer", "External invoicing requires a finalized named-customer order")
	}
	balance, err := q.SumAllocations(ctx, &id)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if !d(balance).IsZero() {
		return ExternalInvoiceRequest{}, conflict("settlement_workflow_conflict", "Orders with payments cannot start external invoicing")
	}
	active, e := q.ActiveRequest(ctx, &id)
	if e == nil {
		return ExternalInvoiceRequest{}, conflict("request_already_exists", "An active request already exists: "+active.Reference)
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
	r, err := q.CreateRequest(ctx, db.CreateRequestParams{ID: newID(), Reference: reference("W", n), OrderID: &id, OrderReference: o.Reference, RequestedAmount: o.TotalAmount, SupersedesRequestID: supersedes})
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
	if err = q.CreateRequestDetails(ctx, db.CreateRequestDetailsParams{RequestID: r.ID, RecipientKind: o.CustomerKind, RecipientPersonID: o.CustomerPersonID, RecipientOrganizationID: o.CustomerOrganizationID, ItemSummary: summary}); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	details := input.Details
	if details.RecipientName == "" && order.CustomerName != nil {
		details.RecipientName = *order.CustomerName
	}
	if err = s.saveDetails(ctx, q, r, details, false); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = q.BumpOrder(ctx, id); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = writeAudit(ctx, tx, p, "external_invoice_request.created", "external_invoice_request", r.ID, requestID, "details"); err != nil {
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
	return InvoiceRequestDetails{RecipientName: d.RecipientName, AddressLine1: d.AddressLine1, AddressLine2: d.AddressLine2, PostalCode: d.PostalCode, Locality: d.Locality, Region: d.Region, CountryCode: d.CountryCode, ContactPersonID: d.ContactPersonID, ContactName: d.ContactName, ContactChannel: d.ContactChannel, ServiceStartsOn: dateString(d.ServiceStartsOn), ServiceEndsOn: dateString(d.ServiceEndsOn), ServiceDescription: d.ServiceDescription, PurchaseOrderReference: d.PurchaseOrderReference}
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
	v := ExternalInvoiceRequest{ID: r.ID, Reference: r.Reference, OrderID: r.OrderID, OrderReference: r.OrderReference, Provider: r.Provider, State: r.State, Currency: r.Currency, RequestedAmount: money(r.RequestedAmount), Details: detailsFromRow(d), RequirePurchaseOrderReference: d.RequirePurchaseOrderReference, RequirementsVersion: d.RequirementsVersion, SupersedesRequestID: r.SupersedesRequestID, Version: r.Version, CreatedAt: r.CreatedAt, ItemSummary: []OrderItem{}, Events: []InvoiceRequestEvent{}}
	if err = json.Unmarshal(d.ItemSummary, &v.ItemSummary); err != nil {
		return v, err
	}
	events, err := q.RequestEvents(ctx, id)
	if err != nil {
		return v, err
	}
	for _, e := range events {
		v.Events = append(v.Events, InvoiceRequestEvent{ID: e.ID, Kind: e.Kind, ExternalReference: e.ExternalReference, ReconciliationKind: e.ReconciliationKind, Reason: e.Reason, EffectiveAt: e.EffectiveAt, RecordedAt: e.RecordedAt})
	}
	return v, nil
}
func (s *Service) GetRequest(ctx context.Context, p authorization.Principal, id uuid.UUID) (ExternalInvoiceRequest, error) {
	if err := require(p, authorization.ExternalInvoiceRequestsRead); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	return s.loadRequest(ctx, db.New(s.pool), id)
}
func (s *Service) ListRequests(ctx context.Context, p authorization.Principal, search, status string, page, size int) (ExternalInvoiceRequestPage, error) {
	if err := require(p, authorization.ExternalInvoiceRequestsRead); err != nil {
		return ExternalInvoiceRequestPage{}, err
	}
	limit, offset, err := pageBounds(page, size)
	if err != nil {
		return ExternalInvoiceRequestPage{}, err
	}
	q := db.New(s.pool)
	rows, err := q.ListRequests(ctx, db.ListRequestsParams{Search: search, Status: status, PageLimit: limit, PageOffset: offset})
	if err != nil {
		return ExternalInvoiceRequestPage{}, err
	}
	v := ExternalInvoiceRequestPage{Items: []ExternalInvoiceRequest{}, Page: int64(page), PageSize: int64(size)}
	v.Total, err = q.CountRequests(ctx, db.CountRequestsParams{Search: search, Status: status})
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
func (s *Service) UpdateRequest(ctx context.Context, p authorization.Principal, id uuid.UUID, input UpdateInvoiceRequest, requestID *uuid.UUID) (ExternalInvoiceRequest, error) {
	if err := require(p, authorization.OrdersRead, authorization.ExternalInvoiceRequestsRead, authorization.ExternalInvoiceRequestsManage); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	r, err := lockRequest(ctx, q, id)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if r.Version != input.ExpectedVersion {
		return ExternalInvoiceRequest{}, apperror.StaleWrite
	}
	if r.State != "draft" {
		return ExternalInvoiceRequest{}, conflict("request_not_draft", "Ready request details are immutable")
	}
	if err = s.saveDetails(ctx, q, r, input.Details, false); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = q.TransitionRequest(ctx, db.TransitionRequestParams{ID: id, State: r.State}); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = writeAudit(ctx, tx, p, "external_invoice_request.updated", "external_invoice_request", id, requestID, "details"); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	v, err := s.loadRequest(ctx, q, id)
	if err != nil {
		return v, err
	}
	return v, databaseError(tx.Commit(ctx))
}
func (s *Service) RequestCommand(ctx context.Context, p authorization.Principal, id uuid.UUID, input InvoiceRequestCommand, action string, requestID *uuid.UUID) (ExternalInvoiceRequest, error) {
	if err := require(p, authorization.OrdersRead, authorization.ExternalInvoiceRequestsRead, authorization.ExternalInvoiceRequestsManage); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ExternalInvoiceRequest{}, err
	}
	defer tx.Rollback(ctx)
	q := db.New(tx)
	kind := "request." + action
	old, hash, err := beginOperation(ctx, q, p, input.OperationKey, kind, struct {
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
	next := r.State
	event := action
	switch action {
	case "ready":
		if r.State != "draft" {
			return ExternalInvoiceRequest{}, conflict("invalid_request_transition", "Only drafts can become ready")
		}
		d, e := q.GetRequestDetails(ctx, id)
		if e != nil {
			return ExternalInvoiceRequest{}, e
		}
		if err = s.saveDetails(ctx, q, r, detailsFromRow(d), true); err != nil {
			return ExternalInvoiceRequest{}, err
		}
		next = "ready"
	case "submit":
		if r.State != "ready" {
			return ExternalInvoiceRequest{}, conflict("invalid_request_transition", "Only ready requests can be submitted")
		}
		next = "submitted"
		event = "submitted"
	case "record-issued":
		if r.State != "submitted" {
			return ExternalInvoiceRequest{}, conflict("invalid_request_transition", "Only submitted requests can record an external invoice")
		}
		amount, amountErr := parseAmount(input.Amount, 2, false)
		if input.ExternalReference == "" || input.EffectiveAt.IsZero() || amountErr != nil || !amount.Equal(d(r.RequestedAmount)) {
			return ExternalInvoiceRequest{}, validation("External invoice reference, date and matching amount are required")
		}
		next = "issued"
		event = "issued_recorded"
	case "cancel":
		if r.State != "draft" && r.State != "ready" {
			return ExternalInvoiceRequest{}, conflict("external_reconciliation_required", "Submitted requests require external cancellation evidence")
		}
		next = "cancelled"
	case "request-cancellation":
		if r.State != "submitted" && r.State != "issued" {
			return ExternalInvoiceRequest{}, conflict("invalid_request_transition", "Only submitted or issued requests require external cancellation")
		}
		next = "cancellation_requested"
		event = "cancellation_requested"
	case "confirm-cancellation":
		if r.State != "cancellation_requested" {
			return ExternalInvoiceRequest{}, conflict("invalid_request_transition", "Request external cancellation first")
		}
		if input.ExternalReference == "" || input.ReconciliationKind == "" || input.EffectiveAt.IsZero() {
			return ExternalInvoiceRequest{}, validation("External correction kind, reference and date are required")
		}
		switch input.ReconciliationKind {
		case "cancellation", "credit_note", "corrected_invoice", "reallocation", "other":
		default:
			return ExternalInvoiceRequest{}, validation("Unsupported external accounting procedure")
		}
		next = "cancelled"
		event = "cancelled"
	case "reference-corrections":
		if r.State != "issued" && r.State != "cancellation_requested" {
			return ExternalInvoiceRequest{}, conflict("invalid_request_transition", "Reference correction requires an issued invoice")
		}
		if input.ExternalReference == "" || input.Reason == "" || input.EffectiveAt.IsZero() {
			return ExternalInvoiceRequest{}, validation("Corrected reference, reason and date are required")
		}
		event = "reference_corrected"
	default:
		return ExternalInvoiceRequest{}, validation("Unsupported request action")
	}
	if len(input.ExternalReference) > 200 || len(input.Reason) > 500 {
		return ExternalInvoiceRequest{}, validation("Reference or reason is too long")
	}
	effective := input.EffectiveAt
	if effective.IsZero() {
		effective = time.Now().UTC()
	}
	if err = q.InsertRequestEvent(ctx, db.InsertRequestEventParams{ID: newID(), RequestID: id, Kind: event, ExternalReference: input.ExternalReference, ReconciliationKind: input.ReconciliationKind, Reason: input.Reason, EffectiveAt: effective.UTC(), ActorAccountID: &p.AccountID}); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = q.TransitionRequest(ctx, db.TransitionRequestParams{ID: id, State: next}); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if r.OrderID != nil {
		if err = q.BumpOrder(ctx, *r.OrderID); err != nil {
			return ExternalInvoiceRequest{}, err
		}
	}
	if err = writeAudit(ctx, tx, p, "external_invoice_request."+event, "external_invoice_request", id, requestID, "state", "events"); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if err = finishOperation(ctx, q, p, input.OperationKey, kind, hash, r.OrderID, &id); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	v, err := s.loadRequest(ctx, q, id)
	if err != nil {
		return v, err
	}
	return v, databaseError(tx.Commit(ctx))
}
