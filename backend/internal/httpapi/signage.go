package httpapi

import (
	"context"
	"encoding/json"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
)

const signageAssetCSP = "default-src 'none'; style-src 'none'; sandbox"

func (s *Server) ListSignageLayouts(ctx context.Context, _ openapi.ListSignageLayoutsRequestObject) (openapi.ListSignageLayoutsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	layouts, err := s.signage.ListLayouts(ctx, p)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SignageLayout, 0, len(layouts))
	for _, layout := range layouts {
		zones := make([]openapi.SignageLayoutZone, 0, len(layout.Zones))
		for _, zone := range layout.Zones {
			zones = append(zones, openapi.SignageLayoutZone{Id: zone.ID, Label: zone.Label, Col: zone.Col, Row: zone.Row, ColSpan: zone.ColSpan, RowSpan: zone.RowSpan})
		}
		items = append(items, openapi.SignageLayout{Id: openapi.SignageLayoutId(layout.ID), Name: layout.Name, Columns: layout.Columns, Rows: layout.Rows, Zones: zones})
	}
	return openapi.ListSignageLayouts200JSONResponse{Items: items}, nil
}

// Assets ------------------------------------------------------------------------------------------------------

func signageAssetDTO(asset signage.Asset) openapi.SignageAsset {
	result := openapi.SignageAsset{
		Id: asset.ID, Kind: openapi.SignageAssetKind(asset.Kind), Name: asset.Name,
		Width: nullableValue(asset.Width), Height: nullableValue(asset.Height), DurationMs: nullableValue(asset.DurationMs),
		ContentType: asset.ContentType, SizeBytes: asset.SizeBytes, Sha256: asset.SHA256, CreatedAt: asset.CreatedAt,
	}
	if asset.CreatedByAccountID != nil {
		result.CreatedByAccountId = nullable.NewNullableWithValue(*asset.CreatedByAccountID)
	}
	return result
}

func (s *Server) ListSignageAssets(ctx context.Context, r openapi.ListSignageAssetsRequestObject) (openapi.ListSignageAssetsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	var kind *string
	if r.Params.Kind != nil {
		value := string(*r.Params.Kind)
		kind = &value
	}
	assets, err := s.signage.ListAssets(ctx, p, kind)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SignageAsset, 0, len(assets))
	for _, asset := range assets {
		items = append(items, signageAssetDTO(asset))
	}
	return openapi.ListSignageAssets200JSONResponse{Items: items}, nil
}

func (s *Server) UploadSignageAsset(ctx context.Context, r openapi.UploadSignageAssetRequestObject) (openapi.UploadSignageAssetResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("asset body is required")
	}
	asset, err := s.signage.UploadAsset(ctx, p, signage.UploadInput{
		Name: r.Params.XFileName, ContentType: string(r.Params.XFileContentType),
		Width: r.Params.XAssetWidth, Height: r.Params.XAssetHeight, DurationMs: r.Params.XAssetDurationMs, Body: r.Body,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UploadSignageAsset201JSONResponse(signageAssetDTO(asset)), nil
}

func (s *Server) GetSignageAsset(ctx context.Context, r openapi.GetSignageAssetRequestObject) (openapi.GetSignageAssetResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	asset, err := s.signage.GetAsset(ctx, p, r.AssetId)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageAsset200JSONResponse(signageAssetDTO(asset)), nil
}

func (s *Server) RenameSignageAsset(ctx context.Context, r openapi.RenameSignageAssetRequestObject) (openapi.RenameSignageAssetResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	asset, err := s.signage.RenameAsset(ctx, p, r.AssetId, r.Body.Name, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RenameSignageAsset200JSONResponse(signageAssetDTO(asset)), nil
}

func (s *Server) DeleteSignageAsset(ctx context.Context, r openapi.DeleteSignageAssetRequestObject) (openapi.DeleteSignageAssetResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.signage.DeleteAsset(ctx, p, r.AssetId, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteSignageAsset204Response{}, nil
}

func (s *Server) DownloadSignageAsset(ctx context.Context, r openapi.DownloadSignageAssetRequestObject) (openapi.DownloadSignageAssetResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	opened, err := s.signage.OpenAsset(ctx, p, r.AssetId)
	if err != nil {
		return nil, err
	}
	headers := openapi.DownloadSignageAsset200ResponseHeaders{CacheControl: "private, no-store", XContentTypeOptions: "nosniff", ContentSecurityPolicy: signageAssetCSP}
	switch opened.Asset.ContentType {
	case "image/png":
		return openapi.DownloadSignageAsset200ImagepngResponse{Body: opened.Reader, ContentLength: opened.Asset.SizeBytes, Headers: headers}, nil
	case "image/jpeg":
		return openapi.DownloadSignageAsset200ImagejpegResponse{Body: opened.Reader, ContentLength: opened.Asset.SizeBytes, Headers: headers}, nil
	case "image/webp":
		return openapi.DownloadSignageAsset200ImagewebpResponse{Body: opened.Reader, ContentLength: opened.Asset.SizeBytes, Headers: headers}, nil
	case "video/mp4":
		return openapi.DownloadSignageAsset200Videomp4Response{Body: opened.Reader, ContentLength: opened.Asset.SizeBytes, Headers: headers}, nil
	default:
		_ = opened.Reader.Close()
		return nil, apperror.New(500, "internal_error", "Stored asset content type is invalid")
	}
}

// Scenes ------------------------------------------------------------------------------------------------------

func signageZonesInput(zones *openapi.SignageZones) (map[string]json.RawMessage, error) {
	if zones == nil {
		return nil, nil
	}
	result := make(map[string]json.RawMessage, len(*zones))
	for key, widget := range *zones {
		raw, err := widget.MarshalJSON()
		if err != nil {
			return nil, invalidRequest("zone widget is invalid")
		}
		result[key] = raw
	}
	return result, nil
}

func signageSceneDTO(scene signage.Scene) (openapi.SignageScene, error) {
	zones := make(openapi.SignageZones, len(scene.Zones))
	for key, raw := range scene.Zones {
		var widget openapi.SignageWidget
		if err := widget.UnmarshalJSON(raw); err != nil {
			return openapi.SignageScene{}, err
		}
		zones[key] = widget
	}
	return openapi.SignageScene{
		Id: scene.ID, Name: scene.Name, Orientation: openapi.SignageOrientation(scene.Orientation), LayoutId: openapi.SignageLayoutId(scene.LayoutID),
		BackgroundColor: scene.BackgroundColor, BackgroundAssetId: nullableValue(scene.BackgroundAssetID), BackgroundFit: openapi.SignageFit(scene.BackgroundFit),
		BackgroundDim: scene.BackgroundDim, Theme: openapi.SignageSceneTheme(scene.Theme), Zones: zones,
		Version: scene.Version, CreatedAt: scene.CreatedAt, UpdatedAt: scene.UpdatedAt,
	}, nil
}

func (s *Server) ListSignageScenes(ctx context.Context, _ openapi.ListSignageScenesRequestObject) (openapi.ListSignageScenesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	scenes, err := s.signage.ListScenes(ctx, p)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SignageScene, 0, len(scenes))
	for _, scene := range scenes {
		dto, err := signageSceneDTO(scene)
		if err != nil {
			return nil, err
		}
		items = append(items, dto)
	}
	return openapi.ListSignageScenes200JSONResponse{Items: items}, nil
}

func (s *Server) CreateSignageScene(ctx context.Context, r openapi.CreateSignageSceneRequestObject) (openapi.CreateSignageSceneResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	zones, err := signageZonesInput(r.Body.Zones)
	if err != nil {
		return nil, err
	}
	scene, err := s.signage.CreateScene(ctx, p, signage.SceneInput{
		Name: r.Body.Name, Orientation: string(r.Body.Orientation), LayoutID: string(r.Body.LayoutId), BackgroundColor: r.Body.BackgroundColor,
		BackgroundAssetID: uuidNullable(r.Body.BackgroundAssetId), BackgroundFit: string(r.Body.BackgroundFit), BackgroundDim: r.Body.BackgroundDim,
		Theme: string(r.Body.Theme), Zones: zones,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := signageSceneDTO(scene)
	if err != nil {
		return nil, err
	}
	return openapi.CreateSignageScene201JSONResponse(dto), nil
}

func (s *Server) GetSignageScene(ctx context.Context, r openapi.GetSignageSceneRequestObject) (openapi.GetSignageSceneResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	scene, err := s.signage.GetScene(ctx, p, r.SceneId)
	if err != nil {
		return nil, err
	}
	dto, err := signageSceneDTO(scene)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageScene200JSONResponse(dto), nil
}

func (s *Server) UpdateSignageScene(ctx context.Context, r openapi.UpdateSignageSceneRequestObject) (openapi.UpdateSignageSceneResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	zones, err := signageZonesInput(r.Body.Zones)
	if err != nil {
		return nil, err
	}
	scene, err := s.signage.UpdateScene(ctx, p, r.SceneId, r.Body.ExpectedVersion, signage.SceneInput{
		Name: r.Body.Name, Orientation: string(r.Body.Orientation), LayoutID: string(r.Body.LayoutId), BackgroundColor: r.Body.BackgroundColor,
		BackgroundAssetID: uuidNullable(r.Body.BackgroundAssetId), BackgroundFit: string(r.Body.BackgroundFit), BackgroundDim: r.Body.BackgroundDim,
		Theme: string(r.Body.Theme), Zones: zones,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	dto, err := signageSceneDTO(scene)
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSignageScene200JSONResponse(dto), nil
}

func (s *Server) DeleteSignageScene(ctx context.Context, r openapi.DeleteSignageSceneRequestObject) (openapi.DeleteSignageSceneResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.signage.DeleteScene(ctx, p, r.SceneId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteSignageScene204Response{}, nil
}

// Playlists ---------------------------------------------------------------------------------------------------

func signagePlaylistDTO(playlist signage.Playlist) openapi.SignagePlaylist {
	items := make([]openapi.SignagePlaylistItem, 0, len(playlist.Items))
	for _, item := range playlist.Items {
		items = append(items, openapi.SignagePlaylistItem{SceneId: item.SceneID, Seconds: item.Seconds, Transition: openapi.SignageTransition(item.Transition)})
	}
	return openapi.SignagePlaylist{Id: playlist.ID, Name: playlist.Name, Items: items, Version: playlist.Version, CreatedAt: playlist.CreatedAt, UpdatedAt: playlist.UpdatedAt}
}

func signagePlaylistItems(items []openapi.SignagePlaylistItem) []signage.PlaylistItem {
	result := make([]signage.PlaylistItem, 0, len(items))
	for _, item := range items {
		result = append(result, signage.PlaylistItem{SceneID: item.SceneId, Seconds: item.Seconds, Transition: string(item.Transition)})
	}
	return result
}

func (s *Server) ListSignagePlaylists(ctx context.Context, _ openapi.ListSignagePlaylistsRequestObject) (openapi.ListSignagePlaylistsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	playlists, err := s.signage.ListPlaylists(ctx, p)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SignagePlaylist, 0, len(playlists))
	for _, playlist := range playlists {
		items = append(items, signagePlaylistDTO(playlist))
	}
	return openapi.ListSignagePlaylists200JSONResponse{Items: items}, nil
}

func (s *Server) CreateSignagePlaylist(ctx context.Context, r openapi.CreateSignagePlaylistRequestObject) (openapi.CreateSignagePlaylistResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	playlist, err := s.signage.CreatePlaylist(ctx, p, signage.PlaylistInput{Name: r.Body.Name, Items: signagePlaylistItems(r.Body.Items)}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateSignagePlaylist201JSONResponse(signagePlaylistDTO(playlist)), nil
}

func (s *Server) GetSignagePlaylist(ctx context.Context, r openapi.GetSignagePlaylistRequestObject) (openapi.GetSignagePlaylistResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	playlist, err := s.signage.GetPlaylist(ctx, p, r.PlaylistId)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignagePlaylist200JSONResponse(signagePlaylistDTO(playlist)), nil
}

func (s *Server) UpdateSignagePlaylist(ctx context.Context, r openapi.UpdateSignagePlaylistRequestObject) (openapi.UpdateSignagePlaylistResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	playlist, err := s.signage.UpdatePlaylist(ctx, p, r.PlaylistId, r.Body.ExpectedVersion, signage.PlaylistInput{Name: r.Body.Name, Items: signagePlaylistItems(r.Body.Items)}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSignagePlaylist200JSONResponse(signagePlaylistDTO(playlist)), nil
}

func (s *Server) DeleteSignagePlaylist(ctx context.Context, r openapi.DeleteSignagePlaylistRequestObject) (openapi.DeleteSignagePlaylistResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.signage.DeletePlaylist(ctx, p, r.PlaylistId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteSignagePlaylist204Response{}, nil
}

// Announcement templates --------------------------------------------------------------------------------------

func signageTemplateDTO(template signage.Template) openapi.SignageAnnouncementTemplate {
	fields := make([]openapi.SignageTemplateField, 0, len(template.Fields))
	for _, field := range template.Fields {
		fields = append(fields, openapi.SignageTemplateField{
			Key: field.Key, Label: field.Label, Type: openapi.SignageFieldType(field.Type), Required: field.Required,
			DefaultValue: field.DefaultValue, HelperText: field.HelperText, Options: field.Options,
		})
	}
	return openapi.SignageAnnouncementTemplate{
		Id: template.ID, Name: template.Name, Tone: openapi.SignageTone(template.Tone), Title: template.Title, Body: template.Body,
		Fields: fields, Version: template.Version, CreatedAt: template.CreatedAt, UpdatedAt: template.UpdatedAt,
	}
}

func signageTemplateFields(fields []openapi.SignageTemplateField) []signage.TemplateField {
	result := make([]signage.TemplateField, 0, len(fields))
	for _, field := range fields {
		result = append(result, signage.TemplateField{
			Key: field.Key, Label: field.Label, Type: string(field.Type), Required: field.Required,
			DefaultValue: field.DefaultValue, HelperText: field.HelperText, Options: field.Options,
		})
	}
	return result
}

func (s *Server) ListSignageAnnouncementTemplates(ctx context.Context, _ openapi.ListSignageAnnouncementTemplatesRequestObject) (openapi.ListSignageAnnouncementTemplatesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	templates, err := s.signage.ListTemplates(ctx, p)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SignageAnnouncementTemplate, 0, len(templates))
	for _, template := range templates {
		items = append(items, signageTemplateDTO(template))
	}
	return openapi.ListSignageAnnouncementTemplates200JSONResponse{Items: items}, nil
}

func (s *Server) CreateSignageAnnouncementTemplate(ctx context.Context, r openapi.CreateSignageAnnouncementTemplateRequestObject) (openapi.CreateSignageAnnouncementTemplateResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	template, err := s.signage.CreateTemplate(ctx, p, signage.TemplateInput{
		Name: r.Body.Name, Tone: string(r.Body.Tone), Title: r.Body.Title, Body: r.Body.Body, Fields: signageTemplateFields(r.Body.Fields),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateSignageAnnouncementTemplate201JSONResponse(signageTemplateDTO(template)), nil
}

func (s *Server) GetSignageAnnouncementTemplate(ctx context.Context, r openapi.GetSignageAnnouncementTemplateRequestObject) (openapi.GetSignageAnnouncementTemplateResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	template, err := s.signage.GetTemplate(ctx, p, r.TemplateId)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageAnnouncementTemplate200JSONResponse(signageTemplateDTO(template)), nil
}

func (s *Server) UpdateSignageAnnouncementTemplate(ctx context.Context, r openapi.UpdateSignageAnnouncementTemplateRequestObject) (openapi.UpdateSignageAnnouncementTemplateResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	template, err := s.signage.UpdateTemplate(ctx, p, r.TemplateId, r.Body.ExpectedVersion, signage.TemplateInput{
		Name: r.Body.Name, Tone: string(r.Body.Tone), Title: r.Body.Title, Body: r.Body.Body, Fields: signageTemplateFields(r.Body.Fields),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSignageAnnouncementTemplate200JSONResponse(signageTemplateDTO(template)), nil
}

func (s *Server) DeleteSignageAnnouncementTemplate(ctx context.Context, r openapi.DeleteSignageAnnouncementTemplateRequestObject) (openapi.DeleteSignageAnnouncementTemplateResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.signage.DeleteTemplate(ctx, p, r.TemplateId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteSignageAnnouncementTemplate204Response{}, nil
}

// Announcements -----------------------------------------------------------------------------------------------

func signageAnnouncementDTO(item signage.Announcement) openapi.SignageAnnouncement {
	displayIDs := make([]openapi.UUIDv7, 0, len(item.DisplayIDs))
	displayIDs = append(displayIDs, item.DisplayIDs...)
	return openapi.SignageAnnouncement{
		Id: item.ID, TemplateId: item.TemplateID, Values: item.Values, AllDisplays: item.AllDisplays, DisplayIds: displayIDs,
		StartsAt: item.StartsAt, EndsAt: nullableValue(item.EndsAt), Status: openapi.SignageAnnouncementStatus(item.Status),
		Rendered: openapi.SignageRenderedMessage{Title: item.Rendered.Title, Body: item.Rendered.Body, Tone: openapi.SignageTone(item.Rendered.Tone)},
		Version:  item.Version, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt,
	}
}

func uuidSlice(ids []openapi.UUIDv7) []uuid.UUID { return append([]uuid.UUID{}, ids...) }

func (s *Server) ListSignageAnnouncements(ctx context.Context, _ openapi.ListSignageAnnouncementsRequestObject) (openapi.ListSignageAnnouncementsResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	announcements, err := s.signage.ListAnnouncements(ctx, p)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SignageAnnouncement, 0, len(announcements))
	for _, item := range announcements {
		items = append(items, signageAnnouncementDTO(item))
	}
	return openapi.ListSignageAnnouncements200JSONResponse{Items: items}, nil
}

func (s *Server) StartSignageAnnouncement(ctx context.Context, r openapi.StartSignageAnnouncementRequestObject) (openapi.StartSignageAnnouncementResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	item, err := s.signage.StartAnnouncement(ctx, p, signage.AnnouncementInput{
		TemplateID: r.Body.TemplateId, Values: r.Body.Values, AllDisplays: r.Body.AllDisplays, DisplayIDs: uuidSlice(r.Body.DisplayIds),
		StartsAt: r.Body.StartsAt, EndsAt: nullableTime(r.Body.EndsAt),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.StartSignageAnnouncement201JSONResponse(signageAnnouncementDTO(item)), nil
}

func (s *Server) GetSignageAnnouncement(ctx context.Context, r openapi.GetSignageAnnouncementRequestObject) (openapi.GetSignageAnnouncementResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	item, err := s.signage.GetAnnouncement(ctx, p, r.AnnouncementId)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageAnnouncement200JSONResponse(signageAnnouncementDTO(item)), nil
}

func (s *Server) UpdateSignageAnnouncement(ctx context.Context, r openapi.UpdateSignageAnnouncementRequestObject) (openapi.UpdateSignageAnnouncementResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	startsAt := r.Body.StartsAt
	item, err := s.signage.UpdateAnnouncement(ctx, p, r.AnnouncementId, r.Body.ExpectedVersion, signage.AnnouncementInput{
		Values: r.Body.Values, AllDisplays: r.Body.AllDisplays, DisplayIDs: uuidSlice(r.Body.DisplayIds), StartsAt: &startsAt, EndsAt: nullableTime(r.Body.EndsAt),
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSignageAnnouncement200JSONResponse(signageAnnouncementDTO(item)), nil
}

func (s *Server) StopSignageAnnouncement(ctx context.Context, r openapi.StopSignageAnnouncementRequestObject) (openapi.StopSignageAnnouncementResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.signage.StopAnnouncement(ctx, p, r.AnnouncementId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.StopSignageAnnouncement204Response{}, nil
}
