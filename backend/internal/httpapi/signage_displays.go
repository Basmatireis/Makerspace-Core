package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/manageddevices"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/openapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/oapi-codegen/nullable"
)

const defaultSignagePairingCookieName = "makerspace_signage_pairing"

// nullableToPointer unwraps an optional nullable request field; unspecified and null are both nil.
func nullableToPointer[T any](value nullable.Nullable[T]) *T {
	if !value.IsSpecified() || value.IsNull() {
		return nil
	}
	result := value.GetOrEmpty()
	return &result
}

func signageDisplayDTO(display signage.Display) openapi.SignageDisplay {
	pending := make([]openapi.SignagePendingChange, 0, len(display.PendingChanges))
	for _, change := range display.PendingChanges {
		pending = append(pending, openapi.SignagePendingChange{
			Kind: openapi.SignagePendingChangeKind(change.Kind), Name: change.Name, Change: openapi.SignagePendingChangeType(change.Change),
		})
	}
	return openapi.SignageDisplay{
		Id: display.ID, ManagedDeviceId: display.ManagedDeviceID, Name: display.Name, Location: display.Location,
		Orientation: openapi.SignageOrientation(display.Orientation), Resolution: openapi.SignageResolution{Width: display.Resolution.Width, Height: display.Resolution.Height},
		VisibleFromOutside: display.VisibleFromOutside, DefaultPlaylistId: display.DefaultPlaylistID, Status: openapi.SignageDisplayStatus(display.Status),
		RevokedAt: nullableTimeValue(display.RevokedAt), LastHeartbeatAt: nullableTimeValue(display.LastHeartbeatAt),
		PublishedRevision: nullableValue(display.PublishedRevision), PublishedAt: nullableTimeValue(display.PublishedAt), PendingChanges: pending,
		ReportedRevision: nullableValue(display.ReportedRevision), CurrentRule: nullableValue(display.CurrentRule), CurrentSceneId: nullableUUIDValue(display.CurrentSceneID),
		PlayerVersion: nullableValue(display.PlayerVersion), CacheUsedBytes: nullableValue(display.CacheUsedBytes), CacheQuotaBytes: nullableValue(display.CacheQuotaBytes),
		Errors: display.Errors, Version: display.Version, CreatedAt: display.CreatedAt, UpdatedAt: display.UpdatedAt,
	}
}

func (s *Server) ListSignageDisplays(ctx context.Context, _ openapi.ListSignageDisplaysRequestObject) (openapi.ListSignageDisplaysResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	displays, err := s.signage.ListDisplays(ctx, p)
	if err != nil {
		return nil, err
	}
	items := make([]openapi.SignageDisplay, 0, len(displays))
	for _, display := range displays {
		items = append(items, signageDisplayDTO(display))
	}
	return openapi.ListSignageDisplays200JSONResponse{Items: items}, nil
}

func (s *Server) GetSignageDisplay(ctx context.Context, r openapi.GetSignageDisplayRequestObject) (openapi.GetSignageDisplayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	display, err := s.signage.GetDisplay(ctx, p, r.DisplayId)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignageDisplay200JSONResponse(signageDisplayDTO(display)), nil
}

func (s *Server) PairSignageDisplay(ctx context.Context, r openapi.PairSignageDisplayRequestObject) (openapi.PairSignageDisplayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	display, err := s.signage.PairDisplay(ctx, p, r.Body.Code, signage.DisplayInput{
		Name: r.Body.Name, Location: r.Body.Location, Orientation: string(r.Body.Orientation),
		Resolution: signage.Resolution{Width: r.Body.Resolution.Width, Height: r.Body.Resolution.Height}, VisibleFromOutside: r.Body.VisibleFromOutside,
		DefaultPlaylistID: r.Body.DefaultPlaylistId,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.PairSignageDisplay201JSONResponse(signageDisplayDTO(display)), nil
}

func (s *Server) UpdateSignageDisplay(ctx context.Context, r openapi.UpdateSignageDisplayRequestObject) (openapi.UpdateSignageDisplayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	display, err := s.signage.UpdateDisplay(ctx, p, r.DisplayId, r.Body.ExpectedVersion, signage.DisplayInput{
		Name: r.Body.Name, Location: r.Body.Location, Orientation: string(r.Body.Orientation),
		Resolution: signage.Resolution{Width: r.Body.Resolution.Width, Height: r.Body.Resolution.Height}, VisibleFromOutside: r.Body.VisibleFromOutside,
		DefaultPlaylistID: r.Body.DefaultPlaylistId,
	}, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSignageDisplay200JSONResponse(signageDisplayDTO(display)), nil
}

func (s *Server) DeleteSignageDisplay(ctx context.Context, r openapi.DeleteSignageDisplayRequestObject) (openapi.DeleteSignageDisplayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.signage.DeleteDisplay(ctx, p, r.DisplayId, r.Body.ExpectedVersion, requestIDPointer(ctx)); err != nil {
		return nil, err
	}
	return openapi.DeleteSignageDisplay204Response{}, nil
}

func (s *Server) RevokeSignageDisplay(ctx context.Context, r openapi.RevokeSignageDisplayRequestObject) (openapi.RevokeSignageDisplayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	display, err := s.signage.RevokeDisplay(ctx, p, r.DisplayId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.RevokeSignageDisplay200JSONResponse(signageDisplayDTO(display)), nil
}

func (s *Server) PublishSignageDisplay(ctx context.Context, r openapi.PublishSignageDisplayRequestObject) (openapi.PublishSignageDisplayResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	display, err := s.signage.PublishDisplay(ctx, p, r.DisplayId, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.PublishSignageDisplay200JSONResponse(signageDisplayDTO(display)), nil
}

// Rules -------------------------------------------------------------------------------------------------------

func signageRuleListDTO(list signage.RuleList) openapi.SignageRuleList {
	items := make([]openapi.SignageRule, 0, len(list.Items))
	for _, rule := range list.Items {
		var match nullable.Nullable[openapi.SignageMachineMatch]
		if rule.MachineMatch == nil {
			match = nullable.NewNullNullable[openapi.SignageMachineMatch]()
		} else {
			match = nullable.NewNullableWithValue(openapi.SignageMachineMatch(*rule.MachineMatch))
		}
		items = append(items, openapi.SignageRule{
			Id: rule.ID, Position: rule.Position, Enabled: rule.Enabled, ConditionKind: openapi.SignageRuleConditionKind(rule.ConditionKind),
			Weekdays: rule.Weekdays, TimeFrom: nullableValue(rule.TimeFrom), TimeTo: nullableValue(rule.TimeTo), MachineIds: rule.MachineIDs, MachineMatch: match,
			AnnouncementTemplateIds: rule.AnnouncementTemplateIDs, TargetKind: openapi.SignageRuleTargetKind(rule.TargetKind), TargetId: rule.TargetID,
			MinSeconds: rule.MinSeconds, MultiMode: openapi.SignageMultiMode(rule.MultiMode), AlternateSeconds: rule.AlternateSeconds,
		})
	}
	return openapi.SignageRuleList{Items: items, DisplayVersion: list.DisplayVersion}
}

func signageRuleInput(body *openapi.SignageRuleRequest) signage.RuleInput {
	var match *string
	if body.MachineMatch != nil {
		value := string(*body.MachineMatch)
		match = &value
	}
	return signage.RuleInput{
		Enabled: body.Enabled, ConditionKind: string(body.ConditionKind), Weekdays: derefSlice(body.Weekdays), TimeFrom: body.TimeFrom, TimeTo: body.TimeTo,
		MachineIDs: derefSlice(body.MachineIds), MachineMatch: match, AnnouncementTemplateIDs: derefSlice(body.AnnouncementTemplateIds),
		TargetKind: string(body.TargetKind), TargetID: body.TargetId, MinSeconds: body.MinSeconds, MultiMode: string(body.MultiMode), AlternateSeconds: body.AlternateSeconds,
	}
}

func (s *Server) ListSignageRules(ctx context.Context, r openapi.ListSignageRulesRequestObject) (openapi.ListSignageRulesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	list, err := s.signage.ListRules(ctx, p, r.DisplayId)
	if err != nil {
		return nil, err
	}
	return openapi.ListSignageRules200JSONResponse(signageRuleListDTO(list)), nil
}

func (s *Server) CreateSignageRule(ctx context.Context, r openapi.CreateSignageRuleRequestObject) (openapi.CreateSignageRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	list, err := s.signage.CreateRule(ctx, p, r.DisplayId, r.Body.ExpectedVersion, signageRuleInput(r.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.CreateSignageRule201JSONResponse(signageRuleListDTO(list)), nil
}

func (s *Server) UpdateSignageRule(ctx context.Context, r openapi.UpdateSignageRuleRequestObject) (openapi.UpdateSignageRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	list, err := s.signage.UpdateRule(ctx, p, r.DisplayId, r.RuleId, r.Body.ExpectedVersion, signageRuleInput(r.Body), requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.UpdateSignageRule200JSONResponse(signageRuleListDTO(list)), nil
}

func (s *Server) SetSignageRuleEnabled(ctx context.Context, r openapi.SetSignageRuleEnabledRequestObject) (openapi.SetSignageRuleEnabledResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	list, err := s.signage.SetRuleEnabled(ctx, p, r.DisplayId, r.RuleId, r.Body.ExpectedVersion, r.Body.Enabled, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.SetSignageRuleEnabled200JSONResponse(signageRuleListDTO(list)), nil
}

func (s *Server) DeleteSignageRule(ctx context.Context, r openapi.DeleteSignageRuleRequestObject) (openapi.DeleteSignageRuleResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	list, err := s.signage.DeleteRule(ctx, p, r.DisplayId, r.RuleId, r.Body.ExpectedVersion, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.DeleteSignageRule200JSONResponse(signageRuleListDTO(list)), nil
}

func (s *Server) ReorderSignageRules(ctx context.Context, r openapi.ReorderSignageRulesRequestObject) (openapi.ReorderSignageRulesResponseObject, error) {
	p, err := requirePrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	list, err := s.signage.ReorderRules(ctx, p, r.DisplayId, r.Body.ExpectedVersion, r.Body.RuleIds, requestIDPointer(ctx))
	if err != nil {
		return nil, err
	}
	return openapi.ReorderSignageRules200JSONResponse(signageRuleListDTO(list)), nil
}

// Pairing (public) --------------------------------------------------------------------------------------------

// httpRequest returns the raw request that the authentication middleware stored for the few handlers
// that need cookies or Range headers the generated request objects do not carry.
func httpRequest(ctx context.Context) *http.Request {
	request, _ := ctx.Value(httpRequestContextKey).(*http.Request)
	return request
}

func (s *Server) signagePairingCookieName() string {
	if s.config.SignagePairingCookieName != "" {
		return s.config.SignagePairingCookieName
	}
	return defaultSignagePairingCookieName
}

func (s *Server) signagePairingCookie(value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name: s.signagePairingCookieName(), Value: value, Path: "/", HttpOnly: true, Secure: s.config.SessionCookieSecure,
		SameSite: http.SameSiteStrictMode, MaxAge: maxAge,
	}
}

func (s *Server) pollSecret(ctx context.Context) string {
	if request := httpRequest(ctx); request != nil {
		if cookie, err := request.Cookie(s.signagePairingCookieName()); err == nil {
			return cookie.Value
		}
	}
	return ""
}

func (s *Server) StartSignagePairing(ctx context.Context, _ openapi.StartSignagePairingRequestObject) (openapi.StartSignagePairingResponseObject, error) {
	start, err := s.signage.StartPairing(ctx, sourceAddress(ctx), s.pollSecret(ctx))
	if err != nil {
		return nil, err
	}
	cookie := s.signagePairingCookie(start.PollSecret, int(signage.PairingTTL.Seconds())).String()
	return openapi.StartSignagePairing201JSONResponse{
		Body:    openapi.SignagePairingStart{Code: start.Code, ExpiresAt: start.ExpiresAt},
		Headers: openapi.StartSignagePairing201ResponseHeaders{CacheControl: "no-store", SetCookie: cookie},
	}, nil
}

// signagePairingPollResponse writes the poll answer. The generated response can carry only one
// Set-Cookie line, but the paired answer sets the managed-device cookie and clears the poll cookie.
type signagePairingPollResponse struct {
	status  openapi.SignagePairingPollStatus
	cookies []*http.Cookie
}

func (response signagePairingPollResponse) VisitPollSignagePairingResponse(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	for _, cookie := range response.cookies {
		http.SetCookie(w, cookie)
	}
	w.WriteHeader(http.StatusOK)
	return json.NewEncoder(w).Encode(openapi.SignagePairingPoll{Status: response.status})
}

func (s *Server) PollSignagePairing(ctx context.Context, _ openapi.PollSignagePairingRequestObject) (openapi.PollSignagePairingResponseObject, error) {
	poll, err := s.signage.PollPairing(ctx, s.pollSecret(ctx))
	if err != nil {
		return nil, err
	}
	response := signagePairingPollResponse{status: openapi.SignagePairingPollStatus(poll.Status)}
	if poll.Status == "paired" {
		expires := time.Now().UTC().AddDate(10, 0, 0)
		response.cookies = []*http.Cookie{
			// Same attributes as the browser binding of the generic managed-device endpoints.
			{Name: s.config.ManagedDeviceCookieName, Value: poll.DeviceToken, Path: "/", HttpOnly: true, Secure: s.config.SessionCookieSecure,
				SameSite: http.SameSiteStrictMode, Expires: expires, MaxAge: 10 * 365 * 24 * 60 * 60},
			s.signagePairingCookie("", -1),
		}
	}
	return response, nil
}

// Player ------------------------------------------------------------------------------------------------------

// signagePlayerDisplay resolves the display behind the verified signage player credential. The
// authentication middleware only lets signage player devices reach the /signage/player routes; the
// check is repeated here so a handler can never serve a user session.
func (s *Server) signagePlayerDisplay(ctx context.Context) (signage.PlayerDisplay, error) {
	device, ok := ctx.Value(visitorDeviceContextKey).(manageddevices.DeviceContext)
	if !ok || !device.IsSignagePlayer() {
		return signage.PlayerDisplay{}, apperror.Unauthenticated
	}
	return s.signage.PlayerDisplayFor(ctx, device.ID)
}

func signagePlayerManifestDTO(manifest signage.Manifest) (openapi.SignagePlayerManifest, error) {
	rules := make([]openapi.SignagePlayerRule, 0, len(manifest.Rules))
	for _, rule := range manifest.Rules {
		var match nullable.Nullable[openapi.SignageMachineMatch]
		if rule.MachineMatch == nil {
			match = nullable.NewNullNullable[openapi.SignageMachineMatch]()
		} else {
			match = nullable.NewNullableWithValue(openapi.SignageMachineMatch(*rule.MachineMatch))
		}
		rules = append(rules, openapi.SignagePlayerRule{
			Id: rule.ID, Kind: openapi.SignageRuleConditionKind(rule.Kind), Weekdays: rule.Weekdays, TimeFrom: nullableValue(rule.TimeFrom), TimeTo: nullableValue(rule.TimeTo),
			MachineIds: rule.MachineIDs, MachineMatch: match, AnnouncementTemplateIds: rule.AnnouncementTemplateIDs, TargetKind: openapi.SignageRuleTargetKind(rule.TargetKind),
			TargetId: rule.TargetID, MinSeconds: rule.MinSeconds, MultiMode: openapi.SignageMultiMode(rule.MultiMode), AlternateSeconds: rule.AlternateSeconds,
		})
	}
	scenes := make([]openapi.SignagePlayerScene, 0, len(manifest.Scenes))
	for _, scene := range manifest.Scenes {
		zones := make(openapi.SignageZones, len(scene.Zones))
		for key, raw := range scene.Zones {
			var widget openapi.SignageWidget
			if err := widget.UnmarshalJSON(raw); err != nil {
				return openapi.SignagePlayerManifest{}, err
			}
			zones[key] = widget
		}
		scenes = append(scenes, openapi.SignagePlayerScene{
			Id: scene.ID, Name: scene.Name, Orientation: openapi.SignageOrientation(scene.Orientation), LayoutId: openapi.SignageLayoutId(scene.LayoutID),
			BackgroundColor: scene.BackgroundColor, BackgroundAssetId: nullableValue(scene.BackgroundAssetID), BackgroundFit: openapi.SignageFit(scene.BackgroundFit),
			BackgroundDim: scene.BackgroundDim, Theme: openapi.SignagePlayerSceneTheme(scene.Theme), Zones: zones, Version: scene.Version,
		})
	}
	playlists := make([]openapi.SignagePlayerPlaylist, 0, len(manifest.Playlists))
	for _, playlist := range manifest.Playlists {
		items := make([]openapi.SignagePlaylistItem, 0, len(playlist.Items))
		for _, item := range playlist.Items {
			items = append(items, openapi.SignagePlaylistItem{SceneId: item.SceneID, Seconds: item.Seconds, Transition: openapi.SignageTransition(item.Transition)})
		}
		playlists = append(playlists, openapi.SignagePlayerPlaylist{Id: playlist.ID, Name: playlist.Name, Items: items, Version: playlist.Version})
	}
	assets := make([]openapi.SignagePlayerAsset, 0, len(manifest.Assets))
	for _, asset := range manifest.Assets {
		assets = append(assets, openapi.SignagePlayerAsset{
			Id: asset.ID, Kind: openapi.SignageAssetKind(asset.Kind), Name: asset.Name, ContentType: asset.ContentType, Sha256: asset.SHA256, SizeBytes: asset.SizeBytes,
			Width: nullableValue(asset.Width), Height: nullableValue(asset.Height), DurationMs: nullableValue(asset.DurationMs),
			Url: apiBasePath + "/signage/player/assets/" + asset.ID.String() + "/" + asset.SHA256,
		})
	}
	return openapi.SignagePlayerManifest{
		Revision: manifest.Revision, DefaultPlaylistId: manifest.DefaultPlaylistID, LayoutsVersion: manifest.LayoutsVersion,
		Display: openapi.SignagePlayerManifestDisplay{
			Orientation:        openapi.SignageOrientation(manifest.Display.Orientation),
			Resolution:         openapi.SignageResolution{Width: manifest.Display.Resolution.Width, Height: manifest.Display.Resolution.Height},
			VisibleFromOutside: manifest.Display.VisibleFromOutside,
		},
		Rules: rules, Scenes: scenes, Playlists: playlists, Assets: assets,
	}, nil
}

func (s *Server) GetSignagePlayerManifest(ctx context.Context, r openapi.GetSignagePlayerManifestRequestObject) (openapi.GetSignagePlayerManifestResponseObject, error) {
	display, err := s.signagePlayerDisplay(ctx)
	if err != nil {
		return nil, err
	}
	manifest, unchanged, err := s.signage.PlayerManifest(ctx, display, r.Params.Known)
	if err != nil {
		return nil, err
	}
	headers := openapi.GetSignagePlayerManifest200ResponseHeaders{CacheControl: "no-store"}
	if unchanged {
		return openapi.GetSignagePlayerManifest200JSONResponse{Body: openapi.SignagePlayerManifestResponse{Unchanged: true}, Headers: headers}, nil
	}
	dto, err := signagePlayerManifestDTO(manifest)
	if err != nil {
		return nil, err
	}
	return openapi.GetSignagePlayerManifest200JSONResponse{Body: openapi.SignagePlayerManifestResponse{Unchanged: false, Manifest: &dto}, Headers: headers}, nil
}

// signagePlayerAssetResponse serves content-addressed asset bytes. Storage that can seek (local
// files) gets full HTTP Range and conditional-request support through http.ServeContent; other
// storage streams the whole body.
type signagePlayerAssetResponse struct {
	file    signage.PlayerAssetFile
	request *http.Request
}

func (response signagePlayerAssetResponse) VisitGetSignagePlayerAssetResponse(w http.ResponseWriter) error {
	defer func() { _ = response.file.Reader.Close() }()
	header := w.Header()
	header.Set("Content-Type", response.file.Asset.ContentType)
	header.Set("Cache-Control", "private, max-age=31536000, immutable")
	header.Set("ETag", `"`+response.file.Asset.SHA256+`"`)
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Security-Policy", signageAssetCSP)
	if seeker, ok := response.file.Reader.(io.ReadSeeker); ok && response.request != nil {
		http.ServeContent(w, response.request, "", time.Time{}, seeker)
		return nil
	}
	header.Set("Accept-Ranges", "none")
	header.Set("Content-Length", strconv.FormatInt(response.file.Asset.SizeBytes, 10))
	w.WriteHeader(http.StatusOK)
	_, err := io.Copy(w, response.file.Reader)
	return err
}

func (s *Server) GetSignagePlayerAsset(ctx context.Context, r openapi.GetSignagePlayerAssetRequestObject) (openapi.GetSignagePlayerAssetResponseObject, error) {
	display, err := s.signagePlayerDisplay(ctx)
	if err != nil {
		return nil, err
	}
	file, err := s.signage.OpenPlayerAsset(ctx, display, r.AssetId, r.Sha256)
	if err != nil {
		return nil, err
	}
	return signagePlayerAssetResponse{file: file, request: httpRequest(ctx)}, nil
}

func (s *Server) GetSignagePlayerLive(ctx context.Context, _ openapi.GetSignagePlayerLiveRequestObject) (openapi.GetSignagePlayerLiveResponseObject, error) {
	display, err := s.signagePlayerDisplay(ctx)
	if err != nil {
		return nil, err
	}
	live, err := s.signage.PlayerLive(ctx, display)
	if err != nil {
		return nil, err
	}
	machines := make([]openapi.SignagePlayerLiveMachine, 0, len(live.Machines))
	for _, machine := range live.Machines {
		machines = append(machines, openapi.SignagePlayerLiveMachine{
			MachineId: machine.MachineID, Name: machine.Name, State: openapi.SignagePlayerMachineState(machine.State), ProgressPercent: nullableValue(machine.ProgressPercent),
			RemainingMinutes: nullableValue(machine.RemainingMinutes), ObservedAt: nullableTimeValue(machine.ObservedAt), Stale: machine.Stale,
		})
	}
	announcements := make([]openapi.SignagePlayerLiveAnnouncement, 0, len(live.Announcements))
	for _, announcement := range live.Announcements {
		announcements = append(announcements, openapi.SignagePlayerLiveAnnouncement{
			Id: announcement.ID, TemplateId: announcement.TemplateID, Tone: openapi.SignageTone(announcement.Tone), Title: announcement.Title,
			Body: announcement.Body, StartsAt: announcement.StartsAt, EndsAt: nullableTimeValue(announcement.EndsAt),
		})
	}
	openDays := make([]openapi.SignagePlayerOpenDay, 0, len(live.OpenDays))
	for _, day := range live.OpenDays {
		openDays = append(openDays, openapi.SignagePlayerOpenDay{StartsAt: day.StartsAt, EndsAt: day.EndsAt, Status: day.Status})
	}
	events := make([]openapi.SignagePlayerEvent, 0, len(live.Events))
	for _, event := range live.Events {
		var location *string
		if event.Location != "" {
			value := event.Location
			location = &value
		}
		events = append(events, openapi.SignagePlayerEvent{Title: event.Title, StartsAt: event.StartsAt, Location: nullableValue(location)})
	}
	return openapi.GetSignagePlayerLive200JSONResponse{
		Body: openapi.SignagePlayerLive{
			ServerTime: live.ServerTime, Revision: nullableValue(live.Revision), Machines: machines, Announcements: announcements,
			OpenDays: openDays, Events: events, Streams: []openapi.SignagePlayerStream{},
		},
		Headers: openapi.GetSignagePlayerLive200ResponseHeaders{CacheControl: "no-store"},
	}, nil
}

func (s *Server) PostSignagePlayerHeartbeat(ctx context.Context, r openapi.PostSignagePlayerHeartbeatRequestObject) (openapi.PostSignagePlayerHeartbeatResponseObject, error) {
	display, err := s.signagePlayerDisplay(ctx)
	if err != nil {
		return nil, err
	}
	if r.Body == nil {
		return nil, invalidRequest("request body is required")
	}
	if err := s.signage.RecordHeartbeat(ctx, display, signage.Heartbeat{
		Revision: nullableToPointer(r.Body.Revision), CurrentRule: nullableToPointer(r.Body.CurrentRule), CurrentSceneID: nullableToPointer(r.Body.CurrentSceneId),
		PlayerVersion: nullableToPointer(r.Body.PlayerVersion), CacheUsedBytes: nullableToPointer(r.Body.CacheUsedBytes),
		CacheQuotaBytes: nullableToPointer(r.Body.CacheQuotaBytes), Errors: r.Body.Errors,
	}); err != nil {
		return nil, err
	}
	return openapi.PostSignagePlayerHeartbeat204Response{Headers: openapi.PostSignagePlayerHeartbeat204ResponseHeaders{CacheControl: "no-store"}}, nil
}
