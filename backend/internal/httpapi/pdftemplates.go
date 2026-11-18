package httpapi

import (
	"context"
	"net/http"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

// TEMPORARY (phase 1): the PDF template contract and persistence exist, the service does not. Every operation
// answers 501 until phase 2 replaces these stubs with real handlers; do not extend them.
var errPDFTemplatesNotImplemented = apperror.New(http.StatusNotImplemented, "not_implemented", "PDF templates are not implemented yet.")

func (s *Server) ListPdfTemplates(context.Context, openapi.ListPdfTemplatesRequestObject) (openapi.ListPdfTemplatesResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) ListPdfTemplateAssets(context.Context, openapi.ListPdfTemplateAssetsRequestObject) (openapi.ListPdfTemplateAssetsResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) UploadPdfTemplateAsset(context.Context, openapi.UploadPdfTemplateAssetRequestObject) (openapi.UploadPdfTemplateAssetResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) DeletePdfTemplateAsset(context.Context, openapi.DeletePdfTemplateAssetRequestObject) (openapi.DeletePdfTemplateAssetResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) GetPdfTemplateAsset(context.Context, openapi.GetPdfTemplateAssetRequestObject) (openapi.GetPdfTemplateAssetResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) GetPdfTemplate(context.Context, openapi.GetPdfTemplateRequestObject) (openapi.GetPdfTemplateResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) DiscardPdfTemplateDraft(context.Context, openapi.DiscardPdfTemplateDraftRequestObject) (openapi.DiscardPdfTemplateDraftResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) SavePdfTemplateDraft(context.Context, openapi.SavePdfTemplateDraftRequestObject) (openapi.SavePdfTemplateDraftResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) PreviewPdfTemplate(context.Context, openapi.PreviewPdfTemplateRequestObject) (openapi.PreviewPdfTemplateResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) PublishPdfTemplateDraft(context.Context, openapi.PublishPdfTemplateDraftRequestObject) (openapi.PublishPdfTemplateDraftResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) ListPdfTemplateVersions(context.Context, openapi.ListPdfTemplateVersionsRequestObject) (openapi.ListPdfTemplateVersionsResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) GetPdfTemplateVersion(context.Context, openapi.GetPdfTemplateVersionRequestObject) (openapi.GetPdfTemplateVersionResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) RestorePdfTemplateVersion(context.Context, openapi.RestorePdfTemplateVersionRequestObject) (openapi.RestorePdfTemplateVersionResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}

func (s *Server) GetOrderReceiptPdf(context.Context, openapi.GetOrderReceiptPdfRequestObject) (openapi.GetOrderReceiptPdfResponseObject, error) {
	return nil, errPDFTemplatesNotImplemented
}
