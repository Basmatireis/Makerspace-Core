package orders

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/invoicing"
	db "github.com/Basmatireis/Makerspace-Core/backend/internal/orders/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/google/uuid"
)

// InvoiceDelivery hands an approved invoice request to the university accounting office (wiRef). It is a real
// module seam: the invoicing package renders and mails, tests replace it.
type InvoiceDelivery interface {
	Deliver(ctx context.Context, document invoicing.Document) invoicing.Outcome
}

// WithInvoiceDelivery enables the mail to wiRef after a request is forwarded. Without it, forwarding records no
// delivery status.
func (s *Service) WithInvoiceDelivery(delivery InvoiceDelivery) *Service {
	s.delivery = delivery
	return s
}

// invoiceDocument collects what the mail and the PDF show. The approver is whoever issued the request.
func invoiceDocument(r ExternalInvoiceRequest) invoicing.Document {
	document := invoicing.Document{
		Organisation:           r.Details.RecipientName,
		ContactName:            r.Details.ContactName,
		ContactChannel:         r.Details.ContactChannel,
		PurchaseOrderReference: r.Details.PurchaseOrderReference,
		RequestNumber:          r.Reference,
		OrderNumber:            r.OrderReference,
		Total:                  r.RequestedAmount,
		AlreadyPaid:            r.AlreadyPaid,
		ServiceStartsOn:        r.Details.ServiceStartsOn,
		ServiceEndsOn:          r.Details.ServiceEndsOn,
		ServiceDescription:     r.Details.ServiceDescription,
	}
	for _, line := range []string{
		r.Details.AddressLine1,
		r.Details.AddressLine2,
		strings.TrimSpace(r.Details.PostalCode + " " + r.Details.Locality),
		r.Details.Region,
		r.Details.CountryCode,
	} {
		if strings.TrimSpace(line) != "" {
			document.AddressLines = append(document.AddressLines, line)
		}
	}
	for _, item := range r.ItemSummary {
		if item.RemovedAt != nil {
			continue
		}
		document.Items = append(document.Items, invoicing.Item{
			Description: item.Description,
			Quantity:    item.Quantity,
			Unit:        item.Unit,
			UnitPrice:   item.UnitPrice,
			Amount:      item.Amount,
		})
	}
	document.ApprovedAt = r.CreatedAt
	for _, event := range r.Events {
		if event.Kind == InvoiceEventIssued {
			document.ApprovedAt = event.RecordedAt
			if event.RecordedBy != nil {
				document.Approver = event.RecordedBy.DisplayName
			}
		}
	}
	return document
}

// deliverIssued sends the forwarded request and records the outcome. The forwarding is already committed, so a
// failure to record is logged and the request is returned as it is.
func (s *Service) deliverIssued(
	ctx context.Context,
	p authorization.Principal,
	r ExternalInvoiceRequest,
	requestID *uuid.UUID,
) ExternalInvoiceRequest {
	if s.delivery == nil {
		return r
	}
	updated, err := s.sendAndRecord(ctx, p, r, requestID)
	if err != nil {
		slog.ErrorContext(ctx, "record wiref delivery failed", "error", err)
		return r
	}
	return updated
}

// sendAndRecord mails the document outside of any transaction, then stores the outcome and its audit event in one.
func (s *Service) sendAndRecord(
	ctx context.Context,
	p authorization.Principal,
	r ExternalInvoiceRequest,
	requestID *uuid.UUID,
) (ExternalInvoiceRequest, error) {
	outcome := s.delivery.Deliver(ctx, invoiceDocument(r))
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return r, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if err = q.SetRequestWiRefDelivery(ctx, db.SetRequestWiRefDeliveryParams{
		RequestID:   r.ID,
		Status:      string(outcome.Status),
		AttemptedAt: time.Now().UTC(),
		FailureCode: outcome.FailureCode,
	}); err != nil {
		return r, err
	}
	if err = audit.Write(ctx, tx, audit.Event{
		ActorAccountID: &p.AccountID,
		Action:         "external_invoice_request.wiref_delivery_" + string(outcome.Status),
		ResourceType:   "external_invoice_request",
		ResourceID:     &r.ID,
		RequestID:      requestID,
		ChangedFields:  []string{"wirefDelivery"},
	}); err != nil {
		return r, err
	}
	updated, err := s.loadRequest(ctx, q, r.ID)
	if err != nil {
		return r, err
	}
	return updated, databaseError(tx.Commit(ctx))
}

// ResendToWiRef mails an issued request to the accounting office again, for example after a failure or when the
// recipient asked for another copy.
func (s *Service) ResendToWiRef(
	ctx context.Context,
	p authorization.Principal,
	id uuid.UUID,
	requestID *uuid.UUID,
) (ExternalInvoiceRequest, error) {
	if err := require(
		p,
		authorization.OrdersRead,
		authorization.ExternalInvoiceRequestsRead,
		authorization.ExternalInvoiceRequestsApprove,
	); err != nil {
		return ExternalInvoiceRequest{}, err
	}
	if s.delivery == nil {
		return ExternalInvoiceRequest{}, apperror.Conflicting(
			"wiref_delivery_unavailable",
			"Delivery to wiRef is not available",
		)
	}
	r, err := s.loadRequest(ctx, db.New(s.pool), id)
	if err != nil {
		return r, err
	}
	if r.State != InvoiceIssued {
		return r, apperror.Conflicting(
			"invalid_request_transition",
			"Only requests that were forwarded to wiRef can be sent again",
		)
	}
	return s.sendAndRecord(ctx, p, r, requestID)
}
