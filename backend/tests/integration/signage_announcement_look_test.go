package integration_test

import (
	"bytes"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/google/uuid"
)

func lookTemplate(name string, color *string, image *uuid.UUID) signage.TemplateInput {
	return signage.TemplateInput{Name: name, Tone: "info", Title: "Hello", Color: color, ImageAssetID: image}
}

func TestSignageAnnouncementLookValidationAndAudit(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)
	image := f.uploadImage(t, "Look image")
	video, err := f.service.UploadAsset(
		ctx, f.admin, signage.UploadInput{Name: "Clip", ContentType: "video/mp4", Body: bytes.NewReader(signageMP4(64))}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}

	// Templates: the colour is normalised to lower case; unreadable, malformed and missing values are 422.
	template, err := f.service.CreateTemplate(ctx, f.admin, lookTemplate("Blue", ptr("#0F62FE"), &image.ID), nil)
	if err != nil || template.Color == nil || *template.Color != "#0f62fe" || *template.ImageAssetID != image.ID {
		t.Fatalf("template = %#v, %v", template, err)
	}
	plain, err := f.service.CreateTemplate(ctx, f.admin, lookTemplate("Plain", nil, nil), nil)
	if err != nil || plain.Color != nil || plain.ImageAssetID != nil {
		t.Fatalf("plain template = %#v, %v", plain, err)
	}
	for name, input := range map[string]signage.TemplateInput{
		"no contrast":   lookTemplate("A", ptr("#777777"), nil),
		"not a colour":  lookTemplate("B", ptr("blue"), nil),
		"short colour":  lookTemplate("C", ptr("#fff"), nil),
		"missing image": lookTemplate("D", nil, ptr(ids.New())),
		"video image":   lookTemplate("E", nil, &video.ID),
	} {
		_, err := f.service.CreateTemplate(ctx, f.admin, input, nil)
		if name == "no contrast" {
			var appErr *apperror.Error
			if !apperror.IsCode(err, "signage_color_contrast") || !errors.As(err, &appErr) || appErr.HTTPStatus != 422 ||
				appErr.Details["field"] != "color" {
				t.Fatalf("%s: %v", name, err)
			}
			continue
		}
		expectAppCode(t, err, "validation_failed")
		if _, err := f.service.UpdateTemplate(ctx, f.admin, plain.ID, plain.Version, input, nil); err == nil {
			t.Fatalf("%s accepted on update", name)
		}
	}

	// Announcements: without ownLook no own values; with it the same checks as for templates.
	start := signage.AnnouncementInput{TemplateID: plain.ID, AllDisplays: true}
	for name, change := range map[string]func(*signage.AnnouncementInput){
		"colour without ownLook": func(i *signage.AnnouncementInput) { i.Color = ptr("#0f62fe") },
		"image without ownLook":  func(i *signage.AnnouncementInput) { i.ImageAssetID = &image.ID },
	} {
		candidate := start
		change(&candidate)
		expectAppCode(t, mustFail(t, name, f, candidate), "validation_failed")
	}
	for name, change := range map[string]func(*signage.AnnouncementInput){
		"no contrast":   func(i *signage.AnnouncementInput) { i.Color = ptr("#777777") },
		"not a colour":  func(i *signage.AnnouncementInput) { i.Color = ptr("#12345g") },
		"missing image": func(i *signage.AnnouncementInput) { i.ImageAssetID = ptr(ids.New()) },
		"video image":   func(i *signage.AnnouncementInput) { i.ImageAssetID = &video.ID },
	} {
		candidate := start
		candidate.OwnLook = true
		change(&candidate)
		want := "validation_failed"
		if name == "no contrast" {
			want = "signage_color_contrast"
		}
		expectAppCode(t, mustFail(t, name, f, candidate), want)
	}
	own := start
	own.OwnLook, own.Color, own.ImageAssetID = true, ptr("#FFFF00"), &image.ID
	announcement, err := f.service.StartAnnouncement(ctx, f.admin, own, nil)
	if err != nil || !announcement.OwnLook || *announcement.Color != "#ffff00" || *announcement.ImageAssetID != image.ID {
		t.Fatalf("announcement = %#v, %v", announcement, err)
	}
	// Switching ownLook off on update clears nothing by itself: the request must not carry own values.
	if _, err := f.service.UpdateAnnouncement(ctx, f.admin, announcement.ID, announcement.Version,
		signage.AnnouncementInput{AllDisplays: true, StartsAt: &announcement.StartsAt, Color: ptr("#ffff00")}, nil); !apperror.IsCode(err, "validation_failed") {
		t.Fatalf("own values without ownLook on update: %v", err)
	}
	updated, err := f.service.UpdateAnnouncement(ctx, f.admin, announcement.ID, announcement.Version,
		signage.AnnouncementInput{AllDisplays: true, StartsAt: &announcement.StartsAt}, nil)
	if err != nil || updated.OwnLook || updated.Color != nil || updated.ImageAssetID != nil {
		t.Fatalf("announcement back to the template look = %#v, %v", updated, err)
	}
	if _, err := f.service.UpdateAnnouncement(ctx, f.admin, announcement.ID, updated.Version,
		signage.AnnouncementInput{AllDisplays: true, StartsAt: &announcement.StartsAt, OwnLook: true, Color: ptr("#777777")}, nil); !apperror.IsCode(err, "signage_color_contrast") {
		t.Fatalf("contrast on update: %v", err)
	}

	// A duplicate copies colour and image.
	copied, err := f.service.DuplicateTemplate(ctx, f.admin, template.ID, nil)
	if err != nil || copied.Color == nil || *copied.Color != "#0f62fe" || copied.ImageAssetID == nil || *copied.ImageAssetID != image.ID {
		t.Fatalf("copy = %#v, %v", copied, err)
	}

	// The audit log names the fields, never the colour or the image.
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE (changed_fields::text || metadata::text) LIKE '%0f62fe%'
		OR (changed_fields::text || metadata::text) LIKE '%ffff00%' OR (changed_fields::text || metadata::text) LIKE '%`+image.ID.String()+`%'`, 0)
	var fields []string
	if err := f.pool.QueryRow(ctx, `SELECT changed_fields FROM audit_events WHERE action = 'signage_announcement.started'`).Scan(&fields); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"ownLook", "color", "imageAssetId"} {
		if !slices.Contains(fields, want) {
			t.Fatalf("announcement audit fields %v miss %s", fields, want)
		}
	}
	if err := f.pool.QueryRow(ctx, `SELECT changed_fields FROM audit_events WHERE action = 'signage_announcement_template.created'
		AND resource_id = $1`, template.ID).Scan(&fields); err != nil || !slices.Contains(fields, "color") || !slices.Contains(fields, "imageAssetId") {
		t.Fatalf("template audit fields %v, %v", fields, err)
	}
}

func mustFail(t *testing.T, name string, f signageFixture, input signage.AnnouncementInput) error {
	t.Helper()
	_, err := f.service.StartAnnouncement(testContext(t), f.admin, input, nil)
	if err == nil {
		t.Fatalf("%s accepted", name)
	}
	return err
}

func TestSignageAssetDeleteIsBlockedByAnnouncementLooks(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)
	usedByTemplate, usedByOwnLook, unused := f.uploadImage(t, "A"), f.uploadImage(t, "B"), f.uploadImage(t, "C")

	template, err := f.service.CreateTemplate(ctx, f.admin, lookTemplate("With image", nil, &usedByTemplate.ID), nil)
	if err != nil {
		t.Fatal(err)
	}
	expectInUse(t, f.service.DeleteAsset(ctx, f.admin, usedByTemplate.ID, nil), "template")

	// An announcement that keeps the template's look does not add a reference of its own.
	if _, err := f.service.StartAnnouncement(ctx, f.admin, signage.AnnouncementInput{TemplateID: template.ID, AllDisplays: true}, nil); err != nil {
		t.Fatal(err)
	}
	expectInUse(t, f.service.DeleteAsset(ctx, f.admin, usedByTemplate.ID, nil), "template")

	// Active and scheduled announcements with their own look block; so does the template.
	future := time.Now().Add(time.Hour)
	scheduled, err := f.service.StartAnnouncement(ctx, f.admin, signage.AnnouncementInput{
		TemplateID: template.ID, AllDisplays: true, StartsAt: &future, OwnLook: true, ImageAssetID: &usedByOwnLook.ID,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectInUse(t, f.service.DeleteAsset(ctx, f.admin, usedByOwnLook.ID, nil), "announcement")
	active, err := f.service.StartAnnouncement(ctx, f.admin, signage.AnnouncementInput{
		TemplateID: template.ID, AllDisplays: true, OwnLook: true, ImageAssetID: &usedByOwnLook.ID,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectInUse(t, f.service.DeleteAsset(ctx, f.admin, usedByOwnLook.ID, nil), "announcement", "announcement")
	if err := f.service.StopAnnouncement(ctx, f.admin, scheduled.ID, scheduled.Version, nil); err != nil {
		t.Fatal(err)
	}
	expectInUse(t, f.service.DeleteAsset(ctx, f.admin, usedByOwnLook.ID, nil), "announcement")

	// Once it has ended the announcement just loses the image.
	if _, err := f.pool.Exec(ctx, `UPDATE signage_announcements SET starts_at = now() - interval '2 hours',
		ends_at = now() - interval '1 hour' WHERE id = $1`, active.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.service.DeleteAsset(ctx, f.admin, usedByOwnLook.ID, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM signage_announcements WHERE id = $1 AND image_asset_id IS NULL AND own_look`, 1, active.ID)

	// Taking the image off the template frees it.
	if _, err := f.service.UpdateTemplate(ctx, f.admin, template.ID, template.Version, lookTemplate("With image", nil, &unused.ID), nil); err != nil {
		t.Fatal(err)
	}
	if err := f.service.DeleteAsset(ctx, f.admin, usedByTemplate.ID, nil); err != nil {
		t.Fatal(err)
	}
	expectInUse(t, f.service.DeleteAsset(ctx, f.admin, unused.ID, nil), "template")
}

// lookEnv is a player display, a second one, a web embed and a template with an image, for the access tests.
type lookEnv struct {
	*signageEnv
	staff        staffSession
	templateImg  signage.Asset
	ownImg       signage.Asset
	template     signage.Template
	display      map[string]any
	player       *http.Client
	other        map[string]any
	otherPlayer  *http.Client
	embed        map[string]any
	embedBase    string
	otherEmbed   map[string]any
	otherBase    string
	displayAsset func(a signage.Asset) string
}

func newLookEnv(t *testing.T) lookEnv {
	t.Helper()
	e := newSignageEnv(t)
	staff := e.allStaff()
	_, defaults := e.seedContent("Look")
	l := lookEnv{signageEnv: e, staff: staff}
	l.templateImg, l.ownImg = e.fixture.uploadImage(t, "Template image"), e.fixture.uploadImage(t, "Own image")
	var err error
	l.template, err = e.fixture.service.CreateTemplate(testContext(t), e.fixture.admin,
		lookTemplate("Look", ptr("#0f62fe"), &l.templateImg.ID), nil)
	if err != nil {
		t.Fatal(err)
	}
	l.display, l.player = e.pair(staff, "Entrance", defaults)
	l.other, l.otherPlayer = e.pair(staff, "Workshop", defaults)
	l.embed = e.createEmbed(staff, "Site", defaults)
	l.otherEmbed = e.createEmbed(staff, "Other site", defaults)
	l.embedBase = "/public/signage/embeds/" + l.embed["embedKey"].(string)
	l.otherBase = "/public/signage/embeds/" + l.otherEmbed["embedKey"].(string)
	l.displayAsset = func(a signage.Asset) string { return "/signage/player/assets/" + a.ID.String() + "/" + a.SHA256 }
	return l
}

func (l lookEnv) start(input signage.AnnouncementInput) signage.Announcement {
	l.t.Helper()
	input.TemplateID = l.template.ID
	item, err := l.fixture.service.StartAnnouncement(testContext(l.t), l.fixture.admin, input, nil)
	if err != nil {
		l.t.Fatal(err)
	}
	return item
}

func (l lookEnv) playerGet(client *http.Client, path string) int {
	l.t.Helper()
	response := l.do(client, "", http.MethodGet, path, nil)
	response.Body.Close()
	return response.StatusCode
}

func (l lookEnv) liveAnnouncements(client *http.Client, path string) []any {
	l.t.Helper()
	return l.expect(l.do(client, "", http.MethodGet, path, nil), http.StatusOK)["announcements"].([]any)
}

func TestSignageLiveAnnouncementsCarryTheEffectiveLook(t *testing.T) {
	l := newLookEnv(t)
	displayID := uuid.MustParse(l.display["id"].(string))
	inherited := l.start(signage.AnnouncementInput{DisplayIDs: []uuid.UUID{displayID}})
	// Own look with no colour and no image: the tone colour and no image, whatever the template says.
	tone := l.start(signage.AnnouncementInput{DisplayIDs: []uuid.UUID{displayID}, OwnLook: true})
	override := l.start(signage.AnnouncementInput{
		DisplayIDs: []uuid.UUID{displayID}, OwnLook: true, Color: ptr("#F1C21B"), ImageAssetID: &l.ownImg.ID,
	})

	// Admin: own values as stored, the effective look in rendered, the image as a staff download.
	list := l.expect(l.as(l.staff, http.MethodGet, "/signage/announcements", nil), http.StatusOK)["items"].([]any)
	byID := map[string]map[string]any{}
	for _, item := range list {
		byID[item.(map[string]any)["id"].(string)] = item.(map[string]any)
	}
	admin := byID[inherited.ID.String()]
	rendered := admin["rendered"].(map[string]any)
	image := rendered["image"].(map[string]any)
	if admin["ownLook"] != false || admin["color"] != nil || admin["imageAssetId"] != nil ||
		rendered["color"] != "#0f62fe" || rendered["textColor"] != "#ffffff" ||
		image["assetId"] != l.templateImg.ID.String() || image["sha256"] != l.templateImg.SHA256 ||
		image["url"] != "/api/v1/signage/assets/"+l.templateImg.ID.String()+"/content?v="+l.templateImg.SHA256 {
		t.Fatalf("inherited announcement = %v", admin)
	}
	admin = byID[tone.ID.String()]
	rendered = admin["rendered"].(map[string]any)
	if admin["ownLook"] != true || admin["color"] != nil || rendered["color"] != nil || rendered["textColor"] != nil || rendered["image"] != nil {
		t.Fatalf("tone announcement = %v", admin)
	}
	admin = byID[override.ID.String()]
	rendered = admin["rendered"].(map[string]any)
	if admin["color"] != "#f1c21b" || admin["imageAssetId"] != l.ownImg.ID.String() ||
		rendered["color"] != "#f1c21b" || rendered["textColor"] != "#161616" ||
		rendered["image"].(map[string]any)["assetId"] != l.ownImg.ID.String() {
		t.Fatalf("override announcement = %v", admin)
	}

	// Player: the same effective look, with the player asset path.
	live := map[string]map[string]any{}
	for _, item := range l.liveAnnouncements(l.player, "/signage/player/live") {
		live[item.(map[string]any)["id"].(string)] = item.(map[string]any)
	}
	got := live[inherited.ID.String()]
	if got["color"] != "#0f62fe" || got["textColor"] != "#ffffff" ||
		got["image"].(map[string]any)["url"] != "/api/v1"+l.displayAsset(l.templateImg) {
		t.Fatalf("player inherited = %v", got)
	}
	got = live[tone.ID.String()]
	if got["color"] != nil || got["textColor"] != nil || got["image"] != nil {
		t.Fatalf("player tone = %v", got)
	}
	got = live[override.ID.String()]
	if got["color"] != "#f1c21b" || got["textColor"] != "#161616" ||
		got["image"].(map[string]any)["url"] != "/api/v1"+l.displayAsset(l.ownImg) {
		t.Fatalf("player override = %v", got)
	}

	// A changed template look reaches the announcements that inherit it.
	_, err := l.fixture.service.UpdateTemplate(testContext(t), l.fixture.admin, l.template.ID, l.template.Version,
		lookTemplate("Look", ptr("#FFFFFF"), nil), nil)
	if err != nil {
		t.Fatal(err)
	}
	live = map[string]map[string]any{}
	for _, item := range l.liveAnnouncements(l.player, "/signage/player/live") {
		live[item.(map[string]any)["id"].(string)] = item.(map[string]any)
	}
	if got := live[inherited.ID.String()]; got["color"] != "#ffffff" || got["textColor"] != "#161616" || got["image"] != nil {
		t.Fatalf("player inherited after the template changed = %v", got)
	}

	// The HTTP contract: template and announcement requests.
	created := l.expect(l.as(l.staff, http.MethodPost, "/signage/announcement-templates", map[string]any{
		"name": "Via HTTP", "tone": "info", "title": "T", "body": "", "fields": []any{},
		"color": "#0F62FE", "imageAssetId": l.ownImg.ID.String(),
	}), http.StatusCreated)
	if created["color"] != "#0f62fe" || created["imageAssetId"] != l.ownImg.ID.String() {
		t.Fatalf("created template = %v", created)
	}
	l.expectCode(l.as(l.staff, http.MethodPost, "/signage/announcement-templates", map[string]any{
		"name": "Dull", "tone": "info", "title": "T", "body": "", "fields": []any{}, "color": "#777777",
	}), http.StatusUnprocessableEntity, "signage_color_contrast")
	l.expectCode(l.as(l.staff, http.MethodPost, "/signage/announcement-templates", map[string]any{
		"name": "Bad", "tone": "info", "title": "T", "body": "", "fields": []any{}, "color": "red",
	}), http.StatusUnprocessableEntity, "validation_failed")
	l.expectCode(l.as(l.staff, http.MethodPost, "/signage/announcements", map[string]any{
		"templateId": l.template.ID.String(), "values": map[string]any{}, "allDisplays": true, "displayIds": []any{}, "groupIds": []any{},
		"color": "#f1c21b",
	}), http.StatusUnprocessableEntity, "validation_failed")
	started := l.expect(l.as(l.staff, http.MethodPost, "/signage/announcements", map[string]any{
		"templateId": l.template.ID.String(), "values": map[string]any{}, "allDisplays": true, "displayIds": []any{}, "groupIds": []any{},
		"ownLook": true, "color": "#F1C21B", "imageAssetId": l.ownImg.ID.String(),
	}), http.StatusCreated)
	if started["ownLook"] != true || started["color"] != "#f1c21b" {
		t.Fatalf("started announcement = %v", started)
	}
}

func TestSignagePlayerAndEmbedAssetAccessFollowsAnnouncementsInForce(t *testing.T) {
	l := newLookEnv(t)
	displayID, otherID := uuid.MustParse(l.display["id"].(string)), uuid.MustParse(l.other["id"].(string))
	embedID := uuid.MustParse(l.embed["id"].(string))
	sha := func(a signage.Asset) string { return a.ID.String() + "/" + a.SHA256 }
	wrongSHA := l.templateImg.ID.String() + "/" + strings.Repeat("0", 64)
	player := func(client *http.Client, path string) int { return l.playerGet(client, "/signage/player/assets/"+path) }
	embedAsset := func(base, path string) int {
		response := l.publicGet(base + "/assets/" + path)
		response.Body.Close()
		return response.StatusCode
	}

	// Nothing is in force yet: the image of the template is unreachable, though the template names it.
	if got := player(l.player, sha(l.templateImg)); got != http.StatusNotFound {
		t.Fatalf("image without an announcement = %d", got)
	}

	// One announcement for the entrance display and one embed.
	inherited := l.start(signage.AnnouncementInput{DisplayIDs: []uuid.UUID{displayID, embedID}})
	if got := player(l.player, sha(l.templateImg)); got != http.StatusOK {
		t.Fatalf("template image of an announcement in force = %d", got)
	}
	if got := player(l.player, wrongSHA); got != http.StatusNotFound {
		t.Fatalf("wrong checksum = %d", got)
	}
	if got := player(l.player, sha(l.ownImg)); got != http.StatusNotFound {
		t.Fatalf("an image no announcement shows = %d", got)
	}
	if got := player(l.otherPlayer, sha(l.templateImg)); got != http.StatusNotFound {
		t.Fatalf("other display = %d", got)
	}
	if got := embedAsset(l.embedBase, sha(l.templateImg)); got != http.StatusOK {
		t.Fatalf("embed named by the announcement = %d", got)
	}
	if got := embedAsset(l.embedBase, wrongSHA); got != http.StatusNotFound {
		t.Fatalf("embed, wrong checksum = %d", got)
	}
	if got := embedAsset(l.otherBase, sha(l.templateImg)); got != http.StatusNotFound {
		t.Fatalf("embed not named = %d", got)
	}
	// The embed's live data names the image under the embed's path.
	liveEmbed := l.liveAnnouncements(l.newPlayer(), l.embedBase+"/live")
	if len(liveEmbed) != 1 || liveEmbed[0].(map[string]any)["image"].(map[string]any)["url"] != "/api/v1"+l.embedBase+"/assets/"+sha(l.templateImg) {
		t.Fatalf("embed live = %v", liveEmbed)
	}

	// An own look replaces the template's image: the new one is reachable, the old one no longer.
	changed, err := l.fixture.service.UpdateAnnouncement(testContext(t), l.fixture.admin, inherited.ID, inherited.Version,
		signage.AnnouncementInput{DisplayIDs: []uuid.UUID{displayID, embedID}, StartsAt: &inherited.StartsAt, OwnLook: true, ImageAssetID: &l.ownImg.ID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := player(l.player, sha(l.ownImg)); got != http.StatusOK {
		t.Fatalf("own image = %d", got)
	}
	if got := player(l.player, sha(l.templateImg)); got != http.StatusNotFound {
		t.Fatalf("replaced template image = %d", got)
	}
	if got := embedAsset(l.embedBase, sha(l.ownImg)); got != http.StatusOK {
		t.Fatalf("embed own image = %d", got)
	}

	// A broadcast reaches displays but never a web embed.
	if err := l.fixture.service.StopAnnouncement(testContext(t), l.fixture.admin, changed.ID, changed.Version, nil); err != nil {
		t.Fatal(err)
	}
	broadcast := l.start(signage.AnnouncementInput{AllDisplays: true})
	for name, got := range map[string]int{
		"display":       player(l.player, sha(l.templateImg)),
		"other display": player(l.otherPlayer, sha(l.templateImg)),
	} {
		if got != http.StatusOK {
			t.Fatalf("broadcast, %s = %d", name, got)
		}
	}
	if got := embedAsset(l.embedBase, sha(l.templateImg)); got != http.StatusNotFound {
		t.Fatalf("broadcast must not reach an embed = %d", got)
	}

	// A scheduled announcement shows nothing yet; an ended one nothing any more.
	if err := l.fixture.service.StopAnnouncement(testContext(t), l.fixture.admin, broadcast.ID, broadcast.Version, nil); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour)
	scheduled := l.start(signage.AnnouncementInput{DisplayIDs: []uuid.UUID{otherID}, StartsAt: &future})
	if got := player(l.otherPlayer, sha(l.templateImg)); got != http.StatusNotFound {
		t.Fatalf("scheduled announcement = %d", got)
	}
	if _, err := l.pool.Exec(testContext(t), `UPDATE signage_announcements SET starts_at = now() - interval '2 hours',
		ends_at = now() - interval '1 hour' WHERE id = $1`, scheduled.ID); err != nil {
		t.Fatal(err)
	}
	if got := player(l.otherPlayer, sha(l.templateImg)); got != http.StatusNotFound {
		t.Fatalf("ended announcement = %d", got)
	}

	// Group members get the group's announcements, a display outside the group does not.
	_, defaults := l.seedContent("Group")
	group := l.createGroup(l.staff, "Floor", defaults)
	_, memberClient := l.pairInto(l.staff, "Member", group["id"].(string))
	l.start(signage.AnnouncementInput{GroupIDs: []uuid.UUID{uuid.MustParse(group["id"].(string))}})
	if got := player(memberClient, sha(l.templateImg)); got != http.StatusOK {
		t.Fatalf("group member = %d", got)
	}
	if got := player(l.otherPlayer, sha(l.templateImg)); got != http.StatusNotFound {
		t.Fatalf("display outside the group = %d", got)
	}

	// A switched-off embed serves nothing, and a revoked or unknown credential never reaches the asset.
	l.expect(l.patchEmbed(l.staff, l.embed["id"].(string), map[string]any{"enabled": false}), http.StatusOK)
	if got := embedAsset(l.embedBase, sha(l.ownImg)); got != http.StatusNotFound {
		t.Fatalf("switched-off embed = %d", got)
	}
	if got := l.playerGet(l.newPlayer(), "/signage/player/assets/"+sha(l.templateImg)); got != http.StatusUnauthorized {
		t.Fatalf("unpaired client = %d", got)
	}
}

func TestSignageRevokedDisplayCannotFetchAnAnnouncementImage(t *testing.T) {
	l := newLookEnv(t)
	displayID := l.display["id"].(string)
	l.start(signage.AnnouncementInput{DisplayIDs: []uuid.UUID{uuid.MustParse(displayID)}})
	path := "/signage/player/assets/" + l.templateImg.ID.String() + "/" + l.templateImg.SHA256
	if got := l.playerGet(l.player, path); got != http.StatusOK {
		t.Fatalf("image before the revocation = %d", got)
	}
	l.expect(l.as(l.staff, http.MethodPost, "/signage/displays/"+displayID+"/revoke",
		map[string]any{"expectedVersion": l.displayVersion(l.staff, displayID)}), http.StatusOK)
	if got := l.playerGet(l.player, path); got != http.StatusUnauthorized {
		t.Fatalf("image for a revoked display = %d", got)
	}
}

func TestSignageAnnouncementLookPermissions(t *testing.T) {
	l := newLookEnv(t)
	override := l.staff2("override", authorization.SignageRead, authorization.SignageOverride)
	overrideOnly := l.staff2("override-only", authorization.SignageOverride)
	contentOnly := l.staff2("content-only", authorization.SignageContentManage, authorization.SignageRead)
	start := func(s staffSession) *http.Response {
		return l.as(s, http.MethodPost, "/signage/announcements", map[string]any{
			"templateId": l.template.ID.String(), "values": map[string]any{}, "allDisplays": true, "displayIds": []any{},
			"groupIds": []any{}, "ownLook": true, "color": "#F1C21B", "imageAssetId": l.ownImg.ID.String(),
		})
	}

	// signage.override alone is enough to start and update an announcement with an own colour and image.
	for _, s := range []staffSession{override, overrideOnly} {
		started := l.expect(start(s), http.StatusCreated)
		if started["color"] != "#f1c21b" || started["imageAssetId"] != l.ownImg.ID.String() {
			t.Fatalf("started = %v", started)
		}
		l.expect(l.as(s, http.MethodPut, "/signage/announcements/"+started["id"].(string), map[string]any{
			"expectedVersion": started["version"], "values": map[string]any{}, "allDisplays": true, "displayIds": []any{},
			"groupIds": []any{}, "startsAt": started["startsAt"], "ownLook": true, "color": "#FFFF00",
			"imageAssetId": l.ownImg.ID.String(),
		}), http.StatusOK)
	}
	// signage.content.manage alone cannot start one.
	l.expectCode(start(contentOnly), http.StatusForbidden, "permission_denied")

	// signage.override alone cannot give a template a colour or an image.
	for name, extra := range map[string]map[string]any{
		"colour": {"color": "#0f62fe"},
		"image":  {"imageAssetId": l.ownImg.ID.String()},
	} {
		body := map[string]any{"name": "No " + name, "tone": "info", "title": "T", "body": "", "fields": []any{}}
		for k, v := range extra {
			body[k] = v
		}
		l.expectCode(l.as(override, http.MethodPost, "/signage/announcement-templates", body), http.StatusForbidden, "permission_denied")
		l.expectCode(l.as(overrideOnly, http.MethodPut, "/signage/announcement-templates/"+l.template.ID.String(),
			mergeMaps(body, map[string]any{"expectedVersion": l.template.Version})), http.StatusForbidden, "permission_denied")
	}
}

func mergeMaps(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func (l lookEnv) staff2(suffix string, permissions ...authorization.Permission) staffSession {
	return l.signageEnv.staff(suffix+"-"+uuid.NewString()[:8], permissions...)
}

func TestSignageOwnLookWithoutImageHidesTheTemplateImage(t *testing.T) {
	l := newLookEnv(t)
	displayID := uuid.MustParse(l.display["id"].(string))
	l.start(signage.AnnouncementInput{DisplayIDs: []uuid.UUID{displayID}, OwnLook: true})
	live := l.liveAnnouncements(l.player, "/signage/player/live")
	if len(live) != 1 || live[0].(map[string]any)["image"] != nil {
		t.Fatalf("live = %v", live)
	}
	list := l.expect(l.as(l.staff, http.MethodGet, "/signage/announcements", nil), http.StatusOK)["items"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["rendered"].(map[string]any)["image"] != nil {
		t.Fatalf("rendered = %v", list)
	}
	if got := l.playerGet(l.player, "/signage/player/assets/"+l.templateImg.ID.String()+"/"+l.templateImg.SHA256); got != http.StatusNotFound {
		t.Fatalf("template image of an announcement with its own look = %d", got)
	}
}
