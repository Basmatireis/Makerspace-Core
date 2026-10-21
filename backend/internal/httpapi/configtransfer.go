package httpapi

import (
	"bytes"
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/configtransfer"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
)

func (s *Server) ExportConfiguration(
	ctx context.Context,
	request openapi.ExportConfigurationRequestObject,
) (openapi.ExportConfigurationResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	export, err := s.configTransfer.Export(ctx, principal, sectionKeys(request.Params.Sections), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ExportConfiguration200ApplicationoctetStreamResponse{
		Body:          bytes.NewReader(export.Data),
		ContentLength: int64(len(export.Data)),
		Headers: openapi.ExportConfiguration200ResponseHeaders{
			CacheControl:        "no-store",
			ContentDisposition:  attachmentDisposition(export.Filename),
			XContentTypeOptions: "nosniff",
		},
	}, nil
}

func (s *Server) PreviewConfigurationImport(
	ctx context.Context,
	request openapi.PreviewConfigurationImportRequestObject,
) (openapi.PreviewConfigurationImportResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	report, err := s.configTransfer.Preview(
		ctx,
		principal,
		configtransfer.Mode(request.Params.Mode),
		sectionKeys(request.Params.Sections),
		request.Body,
	)
	if err != nil {
		return nil, err
	}
	return openapi.PreviewConfigurationImport200JSONResponse(importReportDTO(report)), nil
}

func (s *Server) ApplyConfigurationImport(
	ctx context.Context,
	request openapi.ApplyConfigurationImportRequestObject,
) (openapi.ApplyConfigurationImportResponseObject, error) {
	principal, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	report, err := s.configTransfer.Apply(
		ctx,
		principal,
		configtransfer.Mode(request.Params.Mode),
		sectionKeys(request.Params.Sections),
		request.Params.Fingerprint,
		request.Body,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.ApplyConfigurationImport200JSONResponse(importReportDTO(report)), nil
}

func sectionKeys(sections []openapi.ConfigurationSection) []configtransfer.SectionKey {
	keys := make([]configtransfer.SectionKey, 0, len(sections))
	for _, section := range sections {
		keys = append(keys, configtransfer.SectionKey(section))
	}
	return keys
}

func importReportDTO(report configtransfer.Report) openapi.ConfigurationImportReport {
	sections := make([]openapi.ConfigurationSectionReport, 0, len(report.Sections))
	for _, section := range report.Sections {
		items := make([]openapi.ConfigurationImportItem, 0, len(section.Items))
		for _, item := range section.Items {
			dto := openapi.ConfigurationImportItem{
				Name:   item.Name,
				Action: openapi.ConfigurationImportAction(item.Action),
			}
			if item.Reason != "" {
				dto.Reason = &item.Reason
			}
			if item.Code != "" {
				dto.Code = &item.Code
			}
			items = append(items, dto)
		}
		sections = append(sections, openapi.ConfigurationSectionReport{
			Section: openapi.ConfigurationSection(section.Key),
			Counts: openapi.ConfigurationImportCounts{
				Create:     section.Counts.Create,
				Update:     section.Counts.Update,
				Delete:     section.Counts.Delete,
				Deactivate: section.Counts.Deactivate,
				Keep:       section.Counts.Keep,
				Skip:       section.Counts.Skip,
				Conflict:   section.Counts.Conflict,
			},
			Items: items,
		})
	}
	return openapi.ConfigurationImportReport{
		Mode:        openapi.ConfigurationImportMode(report.Mode),
		Fingerprint: report.Fingerprint,
		Applied:     report.Applied,
		AppVersion:  report.AppVersion,
		ExportedAt:  report.ExportedAt,
		Sections:    sections,
		Warnings:    append([]string{}, report.Warnings...),
	}
}
