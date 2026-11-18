package httpapi

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/invoicing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/orders"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/pdftemplates/engine"
)

// The record sources of the PDF template previews are thin adapters: the orders and invoicing packages own the
// records and check their permissions, the template service owns the preview. The adapters keep the two sides free
// of each other's types.

func sources(listed []orders.PDFSource, err error) ([]pdftemplates.Source, error) {
	if err != nil {
		return nil, err
	}
	result := make([]pdftemplates.Source, 0, len(listed))
	for _, source := range listed {
		result = append(result, pdftemplates.Source{ID: source.ID, Label: source.Label})
	}
	return result, nil
}

// wirefRecords previews the wiRef template with approved invoice requests; the settings of the delivery decide
// the texts and the shown parts, so the document is turned into data by the invoicing package.
type wirefRecords struct {
	orders    *orders.Service
	invoicing *invoicing.Service
}

func (r wirefRecords) PreviewSources(ctx context.Context, p authorization.Principal) ([]pdftemplates.Source, error) {
	return sources(r.orders.PreviewInvoiceRequests(ctx, p))
}

func (r wirefRecords) RecordData(ctx context.Context, p authorization.Principal, id string) (engine.Data, error) {
	document, err := r.orders.InvoiceRequestDocument(ctx, p, id)
	if err != nil {
		return nil, err
	}
	return r.invoicing.PDFData(ctx, document)
}

// cashbookRecords previews the cashbook template with a calendar month of the cash register.
type cashbookRecords struct{ orders *orders.Service }

func (r cashbookRecords) PreviewSources(ctx context.Context, p authorization.Principal) ([]pdftemplates.Source, error) {
	return sources(r.orders.PreviewCashbooks(ctx, p))
}

func (r cashbookRecords) RecordData(ctx context.Context, p authorization.Principal, id string) (engine.Data, error) {
	return r.orders.CashbookPDFData(ctx, p, id)
}

// receiptRecords previews the receipt template with finalized orders.
type receiptRecords struct{ orders *orders.Service }

func (r receiptRecords) PreviewSources(ctx context.Context, p authorization.Principal) ([]pdftemplates.Source, error) {
	return sources(r.orders.PreviewReceipts(ctx, p))
}

func (r receiptRecords) RecordData(ctx context.Context, p authorization.Principal, id string) (engine.Data, error) {
	return r.orders.ReceiptPDFData(ctx, p, id)
}
