package httpapi

import (
	"bytes"
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/invoicing"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) GetWiRefDeliverySettings(
	ctx context.Context,
	_ openapi.GetWiRefDeliverySettingsRequestObject,
) (openapi.GetWiRefDeliverySettingsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	settings, err := s.invoicing.GetSettings(ctx, p)
	if err != nil {
		return nil, err
	}
	return openapi.GetWiRefDeliverySettings200JSONResponse(wiRefSettingsDTO(settings)), nil
}

func (s *Server) UpdateWiRefDeliverySettings(
	ctx context.Context,
	r openapi.UpdateWiRefDeliverySettingsRequestObject,
) (openapi.UpdateWiRefDeliverySettingsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	b := r.Body
	settings, err := s.invoicing.UpdateSettings(ctx, p, invoicing.SettingsInput{
		Templates: invoicing.Templates{
			MailSubject:            b.MailSubject,
			MailIntro:              b.MailIntro,
			MailClosing:            b.MailClosing,
			PDFTitle:               b.PdfTitle,
			PDFIntro:               b.PdfIntro,
			PDFClosing:             b.PdfClosing,
			ShowContactPerson:      b.ShowContactPerson,
			ShowApprover:           b.ShowApprover,
			ShowPurchaseOrder:      b.ShowPurchaseOrder,
			ShowServicePeriod:      b.ShowServicePeriod,
			ShowServiceDescription: b.ShowServiceDescription,
		},
		Enabled:         b.Enabled,
		RecipientEmail:  b.RecipientEmail,
		CCEmails:        b.CcEmails,
		ExpectedVersion: b.ExpectedVersion,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateWiRefDeliverySettings200JSONResponse(wiRefSettingsDTO(settings)), nil
}

func templatesFromFields(b openapi.WiRefTemplateFields) invoicing.Templates {
	return invoicing.Templates{
		MailSubject:            b.MailSubject,
		MailIntro:              b.MailIntro,
		MailClosing:            b.MailClosing,
		PDFTitle:               b.PdfTitle,
		PDFIntro:               b.PdfIntro,
		PDFClosing:             b.PdfClosing,
		ShowContactPerson:      b.ShowContactPerson,
		ShowApprover:           b.ShowApprover,
		ShowPurchaseOrder:      b.ShowPurchaseOrder,
		ShowServicePeriod:      b.ShowServicePeriod,
		ShowServiceDescription: b.ShowServiceDescription,
	}
}

func (s *Server) PreviewWiRefDeliveryMail(
	ctx context.Context,
	r openapi.PreviewWiRefDeliveryMailRequestObject,
) (openapi.PreviewWiRefDeliveryMailResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	preview, err := s.invoicing.PreviewMail(ctx, p, templatesFromFields(*r.Body))
	if err != nil {
		return nil, err
	}
	return openapi.PreviewWiRefDeliveryMail200JSONResponse(
		openapi.WiRefMailPreview{Subject: preview.Subject, Text: preview.Text, Html: preview.HTML},
	), nil
}

func (s *Server) PreviewWiRefDeliveryPdf(
	ctx context.Context,
	r openapi.PreviewWiRefDeliveryPdfRequestObject,
) (openapi.PreviewWiRefDeliveryPdfResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	data, err := s.invoicing.PreviewPDF(ctx, p, templatesFromFields(*r.Body))
	if err != nil {
		return nil, err
	}
	return openapi.PreviewWiRefDeliveryPdf200ApplicationpdfResponse{
		Body:          bytes.NewReader(data),
		ContentLength: int64(len(data)),
		Headers: openapi.PreviewWiRefDeliveryPdf200ResponseHeaders{
			CacheControl:        "no-store",
			ContentDisposition:  attachmentDisposition("wiref-sample.pdf"),
			XContentTypeOptions: "nosniff",
		},
	}, nil
}

func (s *Server) SendWiRefDeliveryTestMail(
	ctx context.Context,
	_ openapi.SendWiRefDeliveryTestMailRequestObject,
) (openapi.SendWiRefDeliveryTestMailResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	outcome, err := s.invoicing.SendTestMail(ctx, p)
	if err != nil {
		return nil, err
	}
	return openapi.SendWiRefDeliveryTestMail200JSONResponse(openapi.WiRefTestMailResult{
		Status:      openapi.WiRefTestMailResultStatus(outcome.Status),
		FailureCode: outcome.FailureCode,
	}), nil
}

func (s *Server) ResendExternalInvoiceRequestToWiRef(
	ctx context.Context,
	r openapi.ResendExternalInvoiceRequestToWiRefRequestObject,
) (openapi.ResendExternalInvoiceRequestToWiRefResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	result, err := s.orders.ResendToWiRef(ctx, p, r.RequestId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := mapFinancialJSON[openapi.ExternalInvoiceRequest](result)
	if err != nil {
		return nil, err
	}
	return openapi.ResendExternalInvoiceRequestToWiRef200JSONResponse(dto), nil
}

func wiRefSettingsDTO(v invoicing.Settings) openapi.WiRefDeliverySettings {
	placeholders := make([]openapi.WiRefPlaceholder, 0, len(invoicing.Placeholders))
	for _, p := range invoicing.Placeholders {
		placeholders = append(placeholders, openapi.WiRefPlaceholder{Token: p.Token(), Description: p.Description})
	}
	cc := v.CCEmails
	if cc == nil {
		cc = []string{}
	}
	return openapi.WiRefDeliverySettings{
		Enabled:                v.Enabled,
		RecipientEmail:         v.RecipientEmail,
		CcEmails:               cc,
		MailSubject:            v.MailSubject,
		MailIntro:              v.MailIntro,
		MailClosing:            v.MailClosing,
		PdfTitle:               v.PDFTitle,
		PdfIntro:               v.PDFIntro,
		PdfClosing:             v.PDFClosing,
		ShowContactPerson:      v.ShowContactPerson,
		ShowApprover:           v.ShowApprover,
		ShowPurchaseOrder:      v.ShowPurchaseOrder,
		ShowServicePeriod:      v.ShowServicePeriod,
		ShowServiceDescription: v.ShowServiceDescription,
		Placeholders:           placeholders,
		Version:                v.Version,
		UpdatedAt:              v.UpdatedAt,
	}
}
