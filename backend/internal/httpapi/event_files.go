package httpapi

import (
	"context"
	"io"
	"mime"
	"net/http"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/events"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
)

func (s *Server) ListEventFiles(
	ctx context.Context,
	r openapi.ListEventFilesRequestObject,
) (openapi.ListEventFilesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	items, err := s.events.ListFiles(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	result := make([]openapi.EventFile, 0, len(items))
	for _, item := range items {
		result = append(result, eventFileDTO(item))
	}
	return openapi.ListEventFiles200JSONResponse{Items: result}, nil
}

func (s *Server) UploadEventFile(
	ctx context.Context,
	r openapi.UploadEventFileRequestObject,
) (openapi.UploadEventFileResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, events.MaxFileBytes+1))
	if err != nil {
		return nil, invalidRequest("could not read file")
	}
	if len(data) > events.MaxFileBytes {
		return nil, apperror.New(
			http.StatusRequestEntityTooLarge,
			"event_file_too_large",
			"Event files are limited to 25 MiB",
		)
	}
	isBanner := r.Params.XEventFilePurpose != nil && *r.Params.XEventFilePurpose == openapi.Banner
	item, err := s.events.AttachFile(
		ctx,
		p,
		r.EventId,
		r.Params.XFileName,
		r.Params.XFileContentType,
		string(r.Params.XEventFileVisibility),
		isBanner,
		r.Params.XEventFileDescription,
		data,
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UploadEventFile201JSONResponse(eventFileDTO(item)), nil
}

func (s *Server) UpdateEventFile(
	ctx context.Context,
	r openapi.UpdateEventFileRequestObject,
) (openapi.UpdateEventFileResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.events.UpdateFile(
		ctx,
		p,
		r.EventId,
		r.EventFileId,
		r.Body.ExpectedVersion,
		string(r.Body.Visibility),
		r.Body.IsBanner,
		nullableStringPointer(r.Body.Description),
		requestIDPointer(ctx),
	)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateEventFile200JSONResponse(eventFileDTO(item)), nil
}

func (s *Server) RemoveEventFile(
	ctx context.Context,
	r openapi.RemoveEventFileRequestObject,
) (openapi.RemoveEventFileResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err = s.events.RemoveFile(
		ctx,
		p,
		r.EventId,
		r.EventFileId,
		r.Body.ExpectedVersion,
		requestIDPointer(ctx),
	); err != nil {
		return nil, err
	}
	return openapi.RemoveEventFile204Response{}, nil
}

func (s *Server) DownloadEventFile(
	ctx context.Context,
	r openapi.DownloadEventFileRequestObject,
) (openapi.DownloadEventFileResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	_, file, reader, err := s.events.OpenFile(ctx, p, r.EventId, r.EventFileId)
	if err != nil {
		return nil, err
	}
	return openapi.DownloadEventFile200ApplicationoctetStreamResponse{
		Body:          reader,
		ContentLength: file.Size,
		Headers: openapi.DownloadEventFile200ResponseHeaders{
			CacheControl:          "no-store",
			ContentDisposition:    attachmentDisposition(file.OriginalFilename),
			XContentTypeOptions:   "nosniff",
			ContentSecurityPolicy: "default-src 'none'; sandbox",
		},
	}, nil
}

func (s *Server) GetEventBanner(
	ctx context.Context,
	r openapi.GetEventBannerRequestObject,
) (openapi.GetEventBannerResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	file, reader, err := s.events.OpenBanner(ctx, p, r.EventId)
	if err != nil {
		return nil, err
	}
	headers := openapi.GetEventBanner200ResponseHeaders{
		CacheControl:          "private, no-store",
		XContentTypeOptions:   "nosniff",
		ContentSecurityPolicy: "default-src 'none'; sandbox",
	}
	switch file.ContentType {
	case "image/jpeg":
		return openapi.GetEventBanner200ImagejpegResponse{Body: reader, ContentLength: file.Size, Headers: headers}, nil
	case "image/png":
		return openapi.GetEventBanner200ImagepngResponse{Body: reader, ContentLength: file.Size, Headers: headers}, nil
	case "image/gif":
		return openapi.GetEventBanner200ImagegifResponse{Body: reader, ContentLength: file.Size, Headers: headers}, nil
	case "image/webp":
		return openapi.GetEventBanner200ImagewebpResponse{Body: reader, ContentLength: file.Size, Headers: headers}, nil
	default:
		_ = reader.Close()
		return nil, invalidRequest("stored Event banner content type is invalid")
	}
}

func eventFileDTO(v events.EventFile) openapi.EventFile {
	return openapi.EventFile{
		Id:               v.ID,
		EventId:          v.EventID,
		FileId:           v.FileID,
		Description:      nullablePointer[string](v.Description, func(x string) string { return x }),
		Visibility:       openapi.EventFileVisibility(v.Visibility),
		IsBanner:         v.IsBanner,
		OriginalFilename: v.OriginalFilename,
		ContentType:      v.ContentType,
		SizeBytes:        v.SizeBytes,
		Version:          v.Version,
		CreatedAt:        v.CreatedAt,
		UpdatedAt:        v.UpdatedAt,
	}
}

func attachmentDisposition(filename string) string {
	value := mime.FormatMediaType("attachment", map[string]string{"filename": filename})
	if value == "" {
		return "attachment"
	}
	return value
}
